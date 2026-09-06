const crypto = require("crypto");

const API_VERSION = process.env.META_API_VERSION || "v22.0";

function backendBase() {
  return process.env.BACKEND_ORIGIN || `http://localhost:${Number(process.env.PORT) || 4100}`;
}

function env() {
  return {
    appId: String(process.env.META_APP_ID || "").trim(),
    appSecret: String(process.env.META_APP_SECRET || "").trim(),
    apiVersion: API_VERSION,
    scopes: String(process.env.META_SCOPES || "ads_read,ads_management").trim(),
    redirectUri: String(
      process.env.META_REDIRECT_URI || `${backendBase()}/api/integrations/connect/meta/callback`
    ).trim(),
  };
}

function extractActionCount(actions, actionType) {
  if (!Array.isArray(actions)) return 0;
  const match = actions.find((a) => a.action_type === actionType || (a.action_type && a.action_type.includes("purchase")));
  return match ? Math.round(Number(match.value || 0)) : 0;
}

function extractActionValue(actionValues, actionType) {
  if (!Array.isArray(actionValues)) return 0;
  const match = actionValues.find((a) => a.action_type === actionType || (a.action_type && a.action_type.includes("purchase")));
  return match ? Number(match.value || 0) : 0;
}

const provider = {
  id: "meta",
  displayName: "Meta Ads",
  description: "Importe gastos, campanhas e resultados dos seus anúncios.",
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],

  isConfigured() {
    const c = env();
    return Boolean(c.appId && c.appSecret);
  },

  health() {
    const configured = this.isConfigured();
    return {
      ok: configured,
      configured,
      message: configured
        ? "Pronto para conectar."
        : "Integração ainda não configurada pelo administrador.",
      missingEnv: configured ? [] : this.requiredEnv.filter((key) => !process.env[key]),
    };
  },

  getAuthUrl(state) {
    if (!this.isConfigured()) {
      const error = new Error("Meta app credentials are not configured");
      error.code = "PROVIDER_NOT_CONFIGURED";
      throw error;
    }
    const c = env();
    const params = new URLSearchParams({
      client_id: c.appId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      scope: c.scopes,
      state,
    });
    return `https://www.facebook.com/${c.apiVersion}/dialog/oauth?${params.toString()}`;
  },

  async exchangeForLongLivedToken(shortToken) {
    const c = env();
    const url = new URL(`https://graph.facebook.com/${c.apiVersion}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", c.appId);
    url.searchParams.set("client_secret", c.appSecret);
    url.searchParams.set("fb_exchange_token", shortToken);
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.access_token) {
      return String(body.access_token).trim();
    }
    throw new Error(body.error?.message || "Falha ao converter o token para longa duração.");
  },

  async handleOAuthCallback({ state, code }) {
    if (!this.isConfigured()) {
      throw new Error("Meta app credentials are not configured");
    }
    if (!state || !code) {
      throw new Error("Parâmetros de autorização ausentes (state ou code).");
    }
    const c = env();
    const tokenUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", c.appId);
    tokenUrl.searchParams.set("client_secret", c.appSecret);
    tokenUrl.searchParams.set("redirect_uri", c.redirectUri);
    tokenUrl.searchParams.set("code", code);

    const response = await fetch(tokenUrl);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || "A Meta recusou o código de autorização.");
      error.retryable = true;
      error.providerHint = "revoke_reauth";
      throw error;
    }
    let accessToken = String(body.access_token || "").trim();
    if (!accessToken) {
      throw new Error("A Meta não retornou um token de acesso.");
    }

    try {
      accessToken = await this.exchangeForLongLivedToken(accessToken);
    } catch {
      /* mantém o token de curta duração se a troca falhar */
    }

    const profileUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/me`);
    profileUrl.searchParams.set("fields", "id,name");
    profileUrl.searchParams.set("access_token", accessToken);
    const profileResponse = await fetch(profileUrl);
    const profile = await profileResponse.json().catch(() => ({}));

    return {
      accessToken,
      connectedAccount: profile?.name || "Meta Ads",
      accountId: profile?.id || null,
    };
  },

  async listAdAccounts(token) {
    const c = env();
    const url = new URL(`https://graph.facebook.com/${c.apiVersion}/me/adaccounts`);
    url.searchParams.set("fields", "name,account_id,account_status,currency,amount_spent");
    url.searchParams.set("access_token", token);
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || "A Meta recusou a listagem de contas de anúncio.");
      error.retryable = true;
      throw error;
    }
    return (body.data || [])
      .filter((item) => item.account_status === 1)
      .map((item) => ({
        id: item.id || `act_${item.account_id}`,
        accountId: item.account_id,
        name: item.name,
        currency: item.currency,
        status: item.account_status,
      }));
  },

  async fetchAdsManager(token, adAccountId, { since, until } = {}) {
    const c = env();
    const cleanId = String(adAccountId || "").replace(/\s+/g, "").replace(/^act_/, "");
    if (!cleanId) throw new Error("Nenhuma conta de anúncio definida.");
    const end = until || new Date().toISOString().slice(0, 10);
    const start = since || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const timeRange = JSON.stringify({ since: start, until: end });

    async function paginatedGet(url, limit = 500) {
      const results = [];
      let next = url;
      for (let page = 0; page < 10 && next; page += 1) {
        const response = await fetch(next);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(body.error?.message || "A Meta recusou a consulta.");
          error.retryable = true;
          throw error;
        }
        results.push(...(body.data || []));
        next = body.paging?.next ? new URL(body.paging.next) : null;
      }
      return results;
    }

    const campaignListUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/act_${cleanId}/campaigns`);
    campaignListUrl.searchParams.set("fields", "id,name,status,effective_status,objective,daily_budget,lifetime_budget,remaining_budget,start_time,stop_time");
    campaignListUrl.searchParams.set("limit", "500");
    campaignListUrl.searchParams.set("access_token", token);
    const campaignRows = await paginatedGet(campaignListUrl);

    const insightsUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/act_${cleanId}/insights`);
    insightsUrl.searchParams.set("level", "campaign");
    insightsUrl.searchParams.set("fields", "campaign_id,campaign_name,spend,impressions,clicks,cpc,ctr,cpm,reach,actions,action_values,purchase_roas");
    insightsUrl.searchParams.set("time_range", timeRange);
    insightsUrl.searchParams.set("limit", "500");
    insightsUrl.searchParams.set("access_token", token);
    const insightRows = await paginatedGet(insightsUrl);

    const adsetUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/act_${cleanId}/adsets`);
    adsetUrl.searchParams.set("fields", "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget");
    adsetUrl.searchParams.set("limit", "500");
    adsetUrl.searchParams.set("access_token", token);
    const adsetRows = await paginatedGet(adsetUrl);

    const adsUrl = new URL(`https://graph.facebook.com/${c.apiVersion}/act_${cleanId}/ads`);
    adsUrl.searchParams.set("fields", "id,name,status,effective_status,adset_id,campaign_id");
    adsUrl.searchParams.set("limit", "500");
    adsUrl.searchParams.set("access_token", token);
    const adRows = await paginatedGet(adsUrl);

    const insightsMap = {};
    for (const row of insightRows) {
      const cid = row.campaign_id;
      if (!cid) continue;
      const purchases = extractActionCount(row.actions, "offsite_conversion.fb_pixel_purchase");
      const purchaseValue = extractActionValue(row.action_values, "offsite_conversion.fb_pixel_purchase");
      const revenueCents = Math.round(Number(purchaseValue || 0) * 100);
      const spendCents = Math.round(Number(row.spend || 0) * 100);
      insightsMap[cid] = {
        spendCents,
        impressions: Math.round(Number(row.impressions || 0)),
        clicks: Math.round(Number(row.clicks || 0)),
        cpcCents: Math.round(Number(row.cpc || 0) * 100),
        ctr: Number(row.ctr || 0),
        cpmCents: Math.round(Number(row.cpm || 0) * 100),
        reach: Math.round(Number(row.reach || 0)),
        purchases,
        revenueCents,
        roas: Number(row.purchase_roas) || 0,
        costPerResultCents: purchases > 0 ? Math.round(spendCents / purchases) : 0,
      };
    }

    const campaigns = campaignRows.map((camp) => ({
      id: camp.id,
      name: camp.name || "",
      status: camp.status || "",
      effectiveStatus: camp.effective_status || "",
      objective: camp.objective || "",
      dailyBudgetCents: Math.round(Number(camp.daily_budget || 0)),
      lifetimeBudgetCents: Math.round(Number(camp.lifetime_budget || 0)),
      remainingBudgetCents: camp.remaining_budget != null ? Math.round(Number(camp.remaining_budget)) : null,
      startTime: camp.start_time || null,
      stopTime: camp.stop_time || null,
      insights: insightsMap[camp.id] || null,
    }));

    const adsets = adsetRows.map((a) => ({
      id: a.id,
      name: a.name || "",
      status: a.status || "",
      effectiveStatus: a.effective_status || "",
      campaignId: a.campaign_id || "",
      dailyBudgetCents: Math.round(Number(a.daily_budget || 0)),
      lifetimeBudgetCents: Math.round(Number(a.lifetime_budget || 0)),
    }));

    const ads = adRows.map((a) => ({
      id: a.id,
      name: a.name || "",
      status: a.status || "",
      effectiveStatus: a.effective_status || "",
      adsetId: a.adset_id || "",
      campaignId: a.campaign_id || "",
    }));

    return { campaigns, adsets, ads, since: start, until: end };
  },

  async fetchDailyInsights(token, adAccountId, { since, until } = {}) {
    const c = env();
    const cleanId = String(adAccountId || "").replace(/\s+/g, "").replace(/^act_/, "");
    if (!cleanId) throw new Error("Nenhuma conta de anúncio definida.");
    const end = until || new Date().toISOString().slice(0, 10);
    const start = since || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const url = new URL(`https://graph.facebook.com/${c.apiVersion}/act_${cleanId}/insights`);
    url.searchParams.set("fields", "spend,clicks,impressions,reach");
    url.searchParams.set("time_range", JSON.stringify({ since: start, until: end }));
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("access_token", token);

    const daily = [];
    let nextUrl = url;
    for (let page = 0; page < 10 && nextUrl; page += 1) {
      const response = await fetch(nextUrl);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error?.message || "A Meta recusou a busca de insights.");
        error.retryable = true;
        throw error;
      }
      for (const row of body.data || []) {
        daily.push({
          date: String(row.date_stop || row.date_start || "").slice(0, 10),
          spendCents: Math.round(Number(row.spend || 0) * 100),
          clicks: Math.round(Number(row.clicks || 0)),
        });
      }
      nextUrl = body.paging?.next ? new URL(body.paging.next) : null;
    }
    return daily;
  },

  verifyWebhookSignature() {
    return true;
  },

  normalizeWebhookEvent(payload) {
    const purchase = payload?.purchase;
    const value = purchase
      ? Number(purchase.value ?? purchase.price ?? 0)
      : Number(payload?.value ?? payload?.price ?? 0);
    return {
      transactionId: String(payload?.purchase_events_id || payload?.event_id || payload?.transaction_id || "").trim(),
      eventType: String(payload?.event_name || "").trim().toLowerCase(),
      amountCents: Math.round(value * 100),
      currency: String(purchase?.currency || payload?.currency || "BRL").toUpperCase(),
      trackroiClickId: String(payload?.trackroi_click_id || "").trim() || null,
    };
  },

  defaultStatus() {
    return this.isConfigured() ? "not_connected" : "not_configured";
  },

  writableFields: ["status", "adAccountId"],
};

module.exports = provider;