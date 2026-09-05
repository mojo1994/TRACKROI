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
    scopes: String(process.env.META_SCOPES || "ads_read,ads_management,pages_read_engagement,pages_show_list").trim(),
    redirectUri: String(
      process.env.META_REDIRECT_URI || `${backendBase()}/api/integrations/connect/meta/callback`
    ).trim(),
  };
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
    const accessToken = String(body.access_token || "").trim();
    if (!accessToken) {
      throw new Error("A Meta não retornou um token de acesso.");
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