const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const db = require("./src/db");
const { logger, newRequestId } = require("./src/logger");
const { encryptSecret, decryptSecret, assertEncryptionKey } = require("./src/crypto");
const { buildDashboardFromAggregates } = require("./src/metrics");
const { resolvePeriod } = require("./src/period");
const { importCsv } = require("./src/csv-import");
const providers = require("./src/providers");

const PORT = Number(process.env.PORT || 4100);
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || `http://localhost:${PORT}`;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5180";

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || FRONTEND_ORIGIN)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== "false";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token, X-CSRF-Token",
  "Access-Control-Allow-Credentials": "true",
};

function corsHeadersFor(req) {
  const origin = String(req.headers.origin || "").trim();
  if (ALLOWED_ORIGINS.includes(origin)) {
    return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { ...CORS_HEADERS };
}

function send(res, statusCode, body, extraHeaders = {}, req = null) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers = req ? corsHeadersFor(req) : CORS_HEADERS;
  res.writeHead(statusCode, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
}

function securityHeaders() {
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'",
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readRawBodyBuffer(req, maxBytes = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.removeAllListeners("error");
        req.destroy();
        const error = new Error("Arquivo muito grande. O limite é de 30 MB — exporte um período menor.");
        error.payloadTooLarge = true;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body, contentType) {
  const files = [];
  const fields = {};
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return { files, fields };
  const boundary = match[1] || match[2];
  const marker = Buffer.from(`--${boundary}`);
  const first = body.indexOf(marker);
  if (first === -1) return { files, fields };
  const parts = [];
  let start = first + marker.length;
  while (start < body.length) {
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const next = body.indexOf(marker, start);
    let end = next !== -1 ? (body[next - 2] === 0x0d && body[next - 1] === 0x0a ? next - 2 : next) : body.length;
    parts.push(body.slice(start, end));
    if (next === -1) break;
    start = next + marker.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    if (filenameMatch && nameMatch) {
      files.push({
        fieldname: nameMatch[1],
        filename: filenameMatch[1],
        content: content.toString("utf8"),
      });
    } else if (nameMatch) {
      fields[nameMatch[1]] = content.toString("utf8").trim();
    }
  }
  return { files, fields };
}

async function parseBody(req, keepRaw = false) {
  const raw = await readRawBody(req);
  if (!raw) return keepRaw ? { body: null, raw: null } : null;
  try {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return keepRaw ? { body: Object.fromEntries(new URLSearchParams(raw).entries()), raw } : Object.fromEntries(new URLSearchParams(raw).entries());
    }
    return keepRaw ? { body: JSON.parse(raw), raw } : JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body");
    error.unprocessable = true;
    throw error;
  }
}

function getPath(reqUrl) {
  return new URL(reqUrl, "http://localhost").pathname;
}

function getQuery(reqUrl) {
  const parsed = new URL(reqUrl, "http://localhost");
  return Object.fromEntries(parsed.searchParams.entries());
}

function getAuthToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-session-token"] || "").trim();
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function requireAuth(req) {
  const token = getAuthToken(req);
  const user = token ? db.getUserByToken(token) : null;
  if (!user) return null;
  return { token, user };
}

function resolveDashboardId(auth, req) {
  const query = getQuery(req.url);
  const requested = String(req.headers["x-dashboard-id"] || query.dashboard_id || "").trim();
  if (requested) {
    const dash = db.getDashboard(requested);
    if (dash && String(dash.owner_id) === String(auth.user.id)) return requested;
  }
  const dash = db.ensureDefaultDashboard(auth.user.id);
  return dash.id;
}

/* ------------------------------------------------------------- SSE */

const eventClientsByUser = new Map();

function broadcastSseToUser(userId, message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  const set = eventClientsByUser.get(String(userId));
  if (!set) return;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      /* client already gone */
    }
  }
}

function broadcastSSE(message, userId) {
  if (userId) {
    broadcastSseToUser(userId, message);
    return;
  }
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const set of eventClientsByUser.values()) {
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        /* client already gone */
      }
    }
  }
}

function handleEvents(req, res) {
  const { token } = getQuery(req.url);
  const user = token ? db.getUserByToken(token) : null;
  if (!user) {
    send(res, 401, { ok: false, error: "Não autenticado" }, {}, req);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeadersFor(req),
  });
  res.write(`: connected\n\n`);
  res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);

  const userId = String(user.id);
  let set = eventClientsByUser.get(userId);
  if (!set) {
    set = new Set();
    eventClientsByUser.set(userId, set);
  }
  set.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) eventClientsByUser.delete(userId);
  });
}

/* ------------------------------------------------------------- OAuth popup pages */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function oauthResultHtml({ providerId, ok, error, connectedAccount }) {
  const payload = JSON.stringify({
    type: "trackroi:oauth",
    provider: providerId,
    ok,
    error: error ? String(error) : null,
    connectedAccount: connectedAccount ? String(connectedAccount) : null,
  });
  const title = ok ? "Conectado" : "Não foi possível conectar";
  const body = ok
    ? `Conexão com ${providerId} concluída. Esta janela pode ser fechada.`
    : `Algo deu errado: ${error}`;
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; --bg:#0a0a0c; --panel:#121418; --border:#1f232b; --text:#f5f7fa; --muted:#8b93a1; --ok:#39ff88; --err:#ff6b6b; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font-family:Inter, Segoe UI, Arial, sans-serif; padding:24px; }
      .card { width:min(420px,100%); border:1px solid var(--border); border-radius:14px; background:var(--panel); padding:28px; text-align:center; box-shadow:0 22px 60px rgba(0,0,0,.35); }
      .dot { width:44px; height:44px; margin:0 auto 14px; border-radius:50%; display:grid; place-items:center; font-size:20px; background:${ok ? "rgba(57,255,136,.12)" : "rgba(255,107,107,.12)"}; color:${ok ? "var(--ok)" : "var(--err)"}; }
      h1 { margin:0 0 8px; font-size:20px; }
      p { margin:0; color:var(--muted); line-height:1.5; font-size:14px; }
    </style>
  </head>
  <body>
    <section class="card">
      <div class="dot">${ok ? "✓" : "!"}</div>
      <h1>${ok ? "Conectado" : "Não foi possível conectar"}</h1>
      <p>${escapeHtml(body)}</p>
    </section>
    <script>
      (function () {
        var message = ${payload};
        if (window.opener) {
          window.opener.postMessage(message, "*");
          setTimeout(function () { window.close(); }, 400);
        } else {
          document.body.insertAdjacentHTML("beforeend", '<p style="color:#5b6170;font-size:12px;margin-top:16px">Esta janela deve ser aberta pelo painel. Feche e tente novamente.</p>');
        }
      })();
    </script>
  </body>
</html>`;
}

function renderPerfectPayWebhookSetup({ token, dashboardId, error }) {
  const webhookUrl = defaultPerfectPayWebhookUrl(dashboardId || "");
  const safeError = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Perfect Pay via Webhook</title>
    <style>
      :root { color-scheme: dark; --bg:#0a0a0c; --panel:#121418; --border:#1f232b; --text:#f5f7fa; --muted:#8b93a1; --accent:#39ff88; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font-family:Inter, Segoe UI, Arial, sans-serif; padding:24px; }
      .card { width:min(520px,100%); border:1px solid var(--border); border-radius:14px; background:var(--panel); padding:28px; box-shadow:0 22px 60px rgba(0,0,0,.35); }
      h1 { margin:0 0 6px; font-size:20px; }
      p { margin:0 0 16px; color:var(--muted); font-size:14px; line-height:1.5; }
      ol { margin:0 0 18px; padding-left:18px; color:var(--muted); font-size:14px; line-height:1.7; }
      .urlbox { display:flex; gap:8px; margin:0 0 14px; }
      .urlbox input { flex:1; height:42px; border-radius:8px; border:1px solid var(--border); background:#0d0f13; color:var(--text); padding:0 12px; font-size:12px; }
      button { height:42px; border-radius:8px; border:1px solid var(--border); background:var(--accent); color:#04140a; font-weight:600; cursor:pointer; padding:0 16px; }
      button.ghost { background:transparent; color:var(--text); border-color:var(--border); }
      .error { margin-top:14px; padding:12px 14px; border-radius:8px; border:1px solid rgba(255,107,107,.25); background:rgba(255,107,107,.08); color:#ffb3b3; font-size:13px; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Perfect Pay — sem plug-and-play</h1>
      <p>O TrackROI agora recebe as vendas da Perfect Pay direto pelo webhook deles. Não é mais necessário conectar com e-mail e senha.</p>
      <ol>
        <li>No painel da Perfect Pay, abra <b>Webhooks</b> e crie um novo webhook.</li>
        <li>Cole a URL abaixo como destino dos eventos.</li>
        <li>Ative os eventos desejados: <b>aprovação de venda</b>, <b>pré-checkout</b>, etc.</li>
        <li>Opcional (recomendado): copie o <b>Token String(32)</b> do webhook e cole no campo "Token do Webhook" em Conexões → Configurações avançadas.</li>
      </ol>
      <div class="urlbox">
        <input type="text" value="${escapeHtml(webhookUrl)}" readonly />
        <button type="button" class="ghost" id="copy-url">Copiar</button>
      </div>
      ${safeError}
      <button type="button" id="done">Concluir</button>
    </section>
    <script>
      document.getElementById("copy-url").onclick = async function () {
        var input = document.querySelector(".urlbox input");
        try { await navigator.clipboard.writeText(input.value); } catch (e) { input.select(); document.execCommand("copy"); }
        document.getElementById("copy-url").textContent = "Copiado!";
      };
      document.getElementById("done").onclick = function () {
        if (window.opener) {
          try { window.opener.postMessage({ type: "trackroi:oauth", provider: "perfectpay", ok: true, connectedAccount: "Webhook configurado" }, "*"); } catch (e) {}
        }
        window.close();
      };
    </script>
  </body>
</html>`;
}

function sendRawHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/* ------------------------------------------------------------- Provider connect flow */

function friendlyProviderError(providerId, error) {
  if (providerId === "perfectpay" && error.providerHint === "bad_credentials") {
    return "E-mail ou senha da Perfect Pay incorretos — confira e tente novamente.";
  }
  if (providerId === "meta" && error.providerHint === "revoke_reauth") {
    return "A Meta recusou a autorização. Feche esta janela, abra o conector de novo e autorize o acesso.";
  }
  if (error.code === "PROVIDER_NOT_CONFIGURED") {
    return "Integração ainda não configurada pelo administrador.";
  }
  return error.message;
}

async function handleConnectStart(req, res, match) {
  const providerId = match[1];
  const provider = providers.get(providerId);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  const query = getQuery(req.url);
  const token = String(query.token || "").trim();
  const user = token ? db.getUserByToken(token) : null;
  const dashboardId = String(query.dashboard_id || "").trim();
  const scopedDashboard = dashboardId && db.getDashboard(dashboardId) && String(db.getDashboard(dashboardId).owner_id) === String(user?.id) ? dashboardId : null;
  if (!user) {
    sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: "Sessão expirada. Reabra a página de conexões e tente novamente." }));
    return;
  }
  const health = provider.health();
  if (!health.configured) {
    sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: health.message || "Integração ainda não configurada pelo administrador." }));
    return;
  }
  if (provider.id === "perfectpay") {
    const dashboard = scopedDashboard || db.ensureDefaultDashboard(user.id);
    sendRawHtml(res, renderPerfectPayWebhookSetup({ token, dashboardId: dashboard?.id || "", error: "" }));
    return;
  }
  const state = scopedDashboard ? `${token}|${scopedDashboard}` : token;
  let authUrl;
  try {
    authUrl = provider.getAuthUrl(state);
  } catch (error) {
    sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: friendlyProviderError(providerId, error) }));
    return;
  }
  res.writeHead(302, { Location: authUrl, ...corsHeadersFor(req) });
  res.end();
}

function storeConnection(providerId, extra, dashboardId) {
  const existing = db.getIntegration(providerId, dashboardId);
  db.upsertIntegration(providerId, {
    ...existing,
    status: "connected",
    connected: true,
    lastSyncAt: new Date().toISOString(),
    errors: [],
    ...extra,
  }, dashboardId);
}

async function handleOAuthCallback(req, res, match) {
  const providerId = match[1];
  const provider = providers.get(providerId);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  const query = getQuery(req.url);
  try {
    const parts = String(query.state || "").split("|");
    const sessionToken = parts[0];
    let dashboardId = parts.length > 1 ? parts[1] : null;
    const user = db.getUserByToken(sessionToken);
    if (!user) {
      sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: "Sessão expirada. Reabra a página de conexões e tente novamente." }));
      return;
    }
    if (dashboardId) {
      const dash = db.getDashboard(dashboardId);
      if (!dash || String(dash.owner_id) !== String(user.id)) {
        dashboardId = null;
      }
    }
    const result = await provider.handleOAuthCallback(query);
    const extra = {
      accessToken: encryptSecret(result.accessToken),
      connectedAccount: result.connectedAccount || null,
    };
    if (providerId === "meta") {
      extra.tokenStatus = "connected";
      extra.adAccountId = result.accountId || null;
    }
    storeConnection(providerId, extra, dashboardId);
    db.appendAuditLog({
      actorUserId: user?.id || null,
      action: `integration.${providerId}.oauth_connected`,
      resourceType: "integration",
      resourceId: providerId,
      metadata: dashboardId ? { dashboardId } : null,
    });
    broadcastSSE({ type: "data", changed: ["integrations"], dashboardId }, user?.id);
    sendRawHtml(res, oauthResultHtml({ providerId, ok: true, connectedAccount: result.connectedAccount }));
  } catch (error) {
    logger.error("OAuth callback failed", { provider: providerId, error: error.message });
    db.appendAuditLog({
      action: `integration.${providerId}.connect_failed`,
      resourceType: "integration",
      resourceId: providerId,
      metadata: { error: error.message },
    });
    sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: friendlyProviderError(providerId, error) }));
  }
}

async function handlePerfectPaySubmit(req, res) {
  send(res, 410, { ok: false, error: "A conexão da Perfect Pay por e-mail/senha foi desativada. Use 'Configurar webhook' em Conexões." }, {}, req);
}

/* ------------------------------------------------------------- Integrations */

const SECRET_FIELDS = new Set(["accessToken", "webhookSecret", "webhookToken", "access_token", "webhook_secret"]);

function webhookPublicOrigin() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.FRONTEND_ORIGIN) return String(process.env.FRONTEND_ORIGIN).replace(/\/+$/, "");
  return `http://localhost:${process.env.PORT || 4100}`;
}

function defaultPerfectPayWebhookUrl(dashboardId) {
  return `${webhookPublicOrigin()}/api/webhooks/perfectpay?dash=${encodeURIComponent(String(dashboardId || "").trim())}`;
}

function publicIntegration(provider, dashboardId) {
  const data = db.getIntegration(provider.id, dashboardId);
  const health = provider.health();
  const safe = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_FIELDS.has(key)) continue;
    safe[key] = value;
  }
  if (provider.id === "perfectpay" && !data.webhookUrl) {
    safe.webhookUrl = defaultPerfectPayWebhookUrl(dashboardId);
  }
  return {
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    configured: health.configured,
    healthMessage: health.message,
    status: data.status || provider.defaultStatus(),
    connected: data.connected === true || data.status === "connected" || data.apiStatus === "connected",
    connectedAccount: data.connectedAccount || null,
    lastSyncAt: data.lastSyncAt || null,
    updatedAt: data.updated_at || null,
    errors: Array.isArray(data.errors) ? data.errors : [],
    ...safe,
  };
}

function listPublicIntegrations(dashboardId) {
  return providers.list().map((provider) => publicIntegration(provider, dashboardId));
}

async function handleMetaSync(req, res, user, dashboardId) {
  const provider = providers.get("meta");
  const integration = db.getIntegration("meta", dashboardId);
  const token = integration?.accessToken ? decryptSecret(integration.accessToken) : null;
  if (!token) {
    send(res, 400, { ok: false, error: "Meta Ads não está conectado. Conecte sua conta do Facebook primeiro." }, {}, req);
    return;
  }

  let accounts;
  try {
    accounts = await provider.listAdAccounts(token);
  } catch (error) {
    logger.error("Meta ad accounts list failed", { error: error.message });
    send(res, 502, { ok: false, error: friendlyProviderError("meta", error), retryable: true }, {}, req);
    return;
  }
  if (!accounts.length) {
    send(res, 400, { ok: false, error: "Nenhuma conta de anúncio ativa encontrada na sua conta do Facebook." }, {}, req);
    return;
  }

  const storedId = String(integration?.adAccountId || "").trim().replace(/^act_/, "");
  const selected = accounts.find((a) => String(a.accountId) === storedId) || accounts[0];
  const since = integration?.lastSyncAt
    ? new Date(new Date(integration.lastSyncAt).getTime() - 12 * 3600000).toISOString().slice(0, 10)
    : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  let daily;
  try {
    daily = await provider.fetchDailyInsights(token, selected.id, { since, until });
  } catch (error) {
    logger.error("Meta insights sync failed", { error: error.message });
    send(res, 502, { ok: false, error: friendlyProviderError("meta", error), retryable: true }, {}, req);
    return;
  }

  let importedSpend = 0;
  let importedClicks = 0;
  const dateTags = new Set();
  for (const row of daily) {
    if (!row.date) continue;
    dateTags.add(row.date);
    importedSpend += row.spendCents || 0;
    importedClicks += row.clicks || 0;
  }

  try {
    db.transaction(() => {
      for (const row of daily) {
        if (!row.date) continue;
        if (row.spendCents > 0) {
          db.run("DELETE FROM advertising_spend WHERE source = 'meta' AND dashboard_id = ? AND substr(created_at, 1, 10) = ?", [dashboardId, row.date]);
          db.insertSpend({
            id: `meta-sp-${row.date}`,
            source: "meta",
            amountCents: row.spendCents,
            currency: selected.currency || "BRL",
            dashboardId,
            createdAt: `${row.date}T00:00:00Z`,
          });
        }
        if (row.clicks > 0) {
          db.run("DELETE FROM clicks WHERE source = 'meta' AND dashboard_id = ? AND substr(created_at, 1, 10) = ?", [dashboardId, row.date]);
          db.insertClick({
            id: `meta-cl-${row.date}`,
            source: "meta",
            quantity: row.clicks,
            dashboardId,
            createdAt: `${row.date}T00:00:00Z`,
          });
        }
      }
    });
  } catch (error) {
    logger.error("Meta sync write failed", { error: error.message });
    send(res, 500, { ok: false, error: "Falha ao gravar os dados sincronizados." }, {}, req);
    return;
  }

  db.upsertIntegration("meta", {
    ...integration,
    status: "connected",
    connected: true,
    connectedAccount: selected.name,
    adAccountId: selected.accountId,
    lastSyncAt: new Date().toISOString(),
    importsCount: (Number(integration?.importsCount) || 0) + 1,
    errors: [],
  }, dashboardId);
  db.insertImportRun({
    type: "meta_sync",
    filename: "Sincronização automática Meta",
    totalRows: daily.length,
    importedSpend,
    importedClicks,
    spendCents: importedSpend,
    clicks: importedClicks,
    campaigns: dateTags.size,
    dashboardId,
    createdBy: user?.id || null,
  });
  db.appendAuditLog({
    actorUserId: user?.id || null,
    action: "integration.meta.sync",
    resourceType: "integration",
    resourceId: "meta",
    metadata: { account: selected.name, days: dateTags.size },
  });
  broadcastSSE({ type: "data", changed: ["integrations", "dashboard", "metrics", "funnel", "sales"], dashboardId }, user?.id);
  send(res, 200, { ok: true, account: selected.name, days: dateTags.size, spendCents: importedSpend, clicks: importedClicks }, {}, req);
}

async function handleIntegrationHealth(req, res, match, dashboardId) {
  const provider = providers.get(match[1]);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  const health = provider.health();
  const data = db.getIntegration(provider.id, dashboardId);
  send(res, 200, { ok: true, provider: provider.id, ...health, connected: data.status === "connected" || data.connected === true || data.apiStatus === "connected" }, {}, req);
}

async function handleIntegrationUpdate(req, res, match, user, dashboardId) {
  const provider = providers.get(match[1]);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    send(res, 400, { ok: false, error: error.message }, {}, req);
    return;
  }
  const current = db.getIntegration(provider.id, dashboardId);
  const allowed = new Set(provider.writableFields || []);
  for (const [key, value] of Object.entries(body || {})) {
    if (!allowed.has(key)) continue;
    if ((key === "webhookSecret" || key === "webhookToken") && typeof value === "string" && value) {
      current[key] = encryptSecret(value);
    } else {
      current[key] = value;
    }
  }
  if (body?.webhookUrl !== undefined) current.webhookUrl = String(body.webhookUrl || "").trim();
  db.upsertIntegration(provider.id, current, dashboardId);
  db.appendAuditLog({
    actorUserId: user.id,
    action: `integration.${provider.id}.update`,
    resourceType: "integration",
    resourceId: provider.id,
    metadata: { fields: Object.keys(body || {}).filter((key) => allowed.has(key)) },
  });
  broadcastSSE({ type: "data", changed: ["integrations"], dashboardId }, user.id);
  send(res, 200, { ok: true, item: publicIntegration(provider) }, {}, req);
}

async function handleIntegrationDisconnect(req, res, match, user, dashboardId) {
  const provider = providers.get(match[1]);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  db.clearIntegration(provider.id, dashboardId);
  db.appendAuditLog({
    actorUserId: user.id,
    action: `integration.${provider.id}.disconnected`,
    resourceType: "integration",
    resourceId: provider.id,
  });
  broadcastSSE({ type: "data", changed: ["integrations"], dashboardId }, user.id);
  send(res, 200, { ok: true, provider: provider.id }, {}, req);
}

/* ------------------------------------------------------------- Import CSV */

async function handleImportCsv(req, res, user, dashboardId) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    send(res, 400, { ok: false, error: "Envie o arquivo como multipart/form-data." }, {}, req);
    return;
  }
  let raw;
  try {
    raw = await readRawBodyBuffer(req, 30 * 1024 * 1024);
  } catch (error) {
    send(res, error.payloadTooLarge ? 413 : 400, { ok: false, error: error.message }, {}, req);
    return;
  }
  const { files, fields } = parseMultipart(raw, String(req.headers["content-type"] || ""));
  const file = files.find((f) => f.fieldname === "file");
  if (!file) {
    send(res, 400, { ok: false, error: "Nenhum arquivo enviado." }, {}, req);
    return;
  }
  const mode = String(fields.mode || "backfill");
  const filename = file.filename;
  if (/\.xlsx$|\.xls$/i.test(filename)) {
    send(res, 400, { ok: false, error: "Formato não suportado. Exporte a planilha como CSV (Arquivo > Exportar > CSV) e envie novamente." }, {}, req);
    return;
  }
  const content = file.content;
  if (!content || !content.trim()) {
    send(res, 400, { ok: false, error: "O arquivo está vazio." }, {}, req);
    return;
  }
  let result;
  try {
    result = importCsv(content);
  } catch (error) {
    send(res, 400, { ok: false, error: `Não foi possível processar o arquivo: ${error.message}` }, {}, req);
    return;
  }
  if (!result.ok) {
    send(res, 400, { ok: false, error: result.error }, {}, req);
    return;
  }

  let commits;
  try {
    commits = db.transaction(() => {
      let spendCommitted = 0;
      let clicksCommitted = 0;
      let salesCommitted = 0;
      for (const record of result.spendRecords) {
        db.insertSpend({ ...record, dashboardId });
        spendCommitted++;
      }
      for (const record of result.clicksRecords) {
        db.insertClick({ ...record, dashboardId });
        clicksCommitted++;
      }
      for (const record of result.salesRecords || []) {
        db.insertSale({ ...record, dashboardId });
        salesCommitted++;
      }
      const commissionSummary = {
        importId: result.importId,
        totalSpendCents: result.stats.totalSpendCents,
        totalClicks: result.stats.totalClicks,
        totalImpressions: result.stats.totalImpressions,
        totalReach: result.stats.totalReach,
        totalPurchases: result.stats.totalPurchases,
        totalPurchaseValueCents: result.stats.totalPurchaseValueCents,
        campaigns: result.campaigns,
        columnMap: result.columnMap,
      };
      db.insertImportRun({
        id: result.importId,
        type: "meta",
        filename,
        totalRows: result.totalRows,
        importedSpend: spendCommitted,
        importedClicks: clicksCommitted,
        spendCents: result.stats.totalSpendCents,
        clicks: result.stats.totalClicks,
        campaigns: result.campaigns.length,
        preview: commissionSummary,
        status: "completed",
        dashboardId,
        createdBy: user.id,
      });
      return { ...commissionSummary, salesCommitted };
    });
  } catch (error) {
    logger.error("Import CSV commit failed", { error: error.message });
    db.appendAuditLog({
      actorUserId: user.id,
      action: "import.meta.failed",
      resourceType: "import",
      resourceId: result.importId,
      metadata: { error: error.message },
    });
    send(res, 500, { ok: false, error: `Erro ao salvar os dados importados: ${error.message}` }, {}, req);
    return;
  }

  db.appendAuditLog({
    actorUserId: user.id,
    action: "import.meta.meta",
    resourceType: "import",
    resourceId: result.importId,
    metadata: { totalRows: result.totalRows, spendCents: commits.totalSpendCents, campaigns: commits.campaigns.length },
  });
  const now = new Date().toISOString();
  const metaIntegration = db.getIntegration("meta", dashboardId);
  db.upsertIntegration("meta", {
    ...metaIntegration,
    status: "connected",
    connected: true,
    lastSyncAt: now,
    importsCount: (metaIntegration.importsCount || 0) + 1,
    lastImportId: result.importId,
    errors: [],
  }, dashboardId);
  broadcastSSE({ type: "data", changed: ["dashboard", "sales", "funnel", "metrics", "logs", "integrations"], dashboardId }, user.id);
  send(res, 200, { ok: true, importId: result.importId, stats: commits }, {}, req);
}

async function handleListImportRuns(req, res, dashboardId) {
  send(res, 200, { ok: true, items: db.listImportRuns(20, dashboardId) }, {}, req);
}

/* ------------------------------------------------------------- Auth */

async function handleAuthLogin(req, res) {
  const ip = getClientIp(req);
  if (db.isRateLimited(ip)) {
    send(res, 429, { ok: false, error: "Muitas tentativas de login. Aguarde 15 minutos." }, {}, req);
    return;
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    send(res, 400, { ok: false, error: error.message }, {}, req);
    return;
  }
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const user = db.getUserByEmail(email);
  if (!user || !user.password_hash) {
    db.recordLoginAttempt(ip);
    send(res, 401, { ok: false, error: "Credenciais inválidas" }, {}, req);
    return;
  }
  const { verifyPassword } = require("./src/crypto");
  if (!verifyPassword(password, { salt: user.password_salt, hash: user.password_hash })) {
    db.recordLoginAttempt(ip);
    send(res, 401, { ok: false, error: "Credenciais inválidas" }, {}, req);
    return;
  }
  db.resetLoginAttempts(ip);
  db.pruneExpiredSessions();
  const session = db.createSession(user.id);
  db.appendAuditLog({ actorUserId: user.id, action: "auth.login", resourceType: "session", resourceId: session.id });
  const csrfToken = db.createCsrfToken(user.id);
  send(res, 200, {
    ok: true,
    token: session.token,
    user: db.publicUser({ id: user.id, name: user.name, email: user.email, role: user.role }),
    csrfToken,
    expiresAt: session.expiresAt,
  }, {}, req);
}

async function handleAuthStatus(req, res) {
  const count = db.get("SELECT COUNT(*) AS n FROM users").n;
  send(res, 200, { ok: true, hasUsers: count > 0 }, {}, req);
}

async function handleAuthRegister(req, res) {
  if (!ALLOW_REGISTRATION) {
    send(res, 403, { ok: false, error: "Cadastro desativado. Use a conta de administrador fornecida." }, {}, req);
    return;
  }
  const ip = getClientIp(req);
  if (db.isRateLimited(ip)) {
    send(res, 429, { ok: false, error: "Muitas tentativas. Aguarde 15 minutos." }, {}, req);
    return;
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    send(res, 400, { ok: false, error: error.message }, {}, req);
    return;
  }
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!name) {
    send(res, 400, { ok: false, error: "Informe seu nome" }, {}, req);
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    send(res, 400, { ok: false, error: "Informe um e-mail válido" }, {}, req);
    return;
  }
  if (password.length < 8) {
    send(res, 400, { ok: false, error: "A senha deve ter pelo menos 8 caracteres" }, {}, req);
    return;
  }
  if (db.getUserByEmail(email)) {
    send(res, 409, { ok: false, error: "Este e-mail já está cadastrado" }, {}, req);
    return;
  }
  const userCount = db.get("SELECT COUNT(*) AS n FROM users").n;
  const user = db.createUser({ name, email, role: userCount === 0 ? "admin" : "member", password });
  db.ensureDefaultDashboard(user.id);
  db.pruneExpiredSessions();
  const session = db.createSession(user.id);
  db.appendAuditLog({ actorUserId: user.id, action: "auth.register", resourceType: "user", resourceId: user.id });
  db.appendAuditLog({ actorUserId: user.id, action: "auth.login", resourceType: "session", resourceId: session.id });
  const csrfToken = db.createCsrfToken(user.id);
  send(res, 201, {
    ok: true,
    token: session.token,
    user: db.publicUser(user),
    csrfToken,
    expiresAt: session.expiresAt,
  }, {}, req);
}

async function handleAuthMe(req, res) {
  const auth = requireAuth(req);
  if (!auth) {
    send(res, 401, { ok: false, error: "Não autenticado" }, {}, req);
    return;
  }
  const csrfToken = db.createCsrfToken(auth.user.id);
  send(res, 200, {
    ok: true,
    user: db.publicUser({ id: auth.user.id, name: auth.user.name, email: auth.user.email, role: auth.user.role }),
    csrfToken,
  }, {}, req);
}

async function handleAuthLogout(req, res) {
  const auth = requireAuth(req);
  if (auth) {
    db.deleteSession(auth.token);
    db.pruneExpiredSessions();
    db.appendAuditLog({ actorUserId: auth.user.id, action: "auth.logout", resourceType: "session", resourceId: auth.token });
  }
  send(res, 200, { ok: true }, {}, req);
}

/* ------------------------------------------------------------- Webhooks */

async function handlePerfectPayWebhook(req, res) {
  const raw = await readRawBody(req);
  if (!raw) {
    send(res, 400, { ok: false, error: "Missing JSON payload" }, {}, req);
    return;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    send(res, 400, { ok: false, error: "Invalid JSON payload" }, {}, req);
    return;
  }
  if (!body || typeof body !== "object") {
    send(res, 400, { ok: false, error: "Missing JSON payload" }, {}, req);
    return;
  }

  const provider = providers.get("perfectpay");
  const event = provider.normalizeWebhookEvent(body);

  let dashboardId = "";
  const query = getQuery(req.url);
  const qDash = String(query.dash || query.dashboard_id || "").trim();
  if (qDash && db.getDashboard(qDash)) {
    const qIntegration = db.getIntegration("perfectpay", qDash);
    if (qIntegration.updated_at) {
      dashboardId = qDash;
    }
  }

  const dashboardsWithPp = db.listDashboardsWithIntegration("perfectpay");
  const connectedOnes = dashboardsWithPp.filter((entry) => {
    const data = db.getIntegration("perfectpay", entry.dashboardId);
    return data.status === "connected" || data.connected === true || data.apiStatus === "connected";
  });

  if (!dashboardId && event.trackroiClickId) {
    dashboardId = db.findClickDashboardByTrackroiId(event.trackroiClickId) || "";
  }
  if (!dashboardId && connectedOnes.length === 1) {
    dashboardId = connectedOnes[0].dashboardId;
  }
  if (!dashboardId) {
    db.appendAuditLog({
      action: "webhook.unknown_dashboard",
      resourceType: "webhook_event",
      resourceId: db.makeId("we"),
      metadata: { reason: "no_tenant_resolved", transactionId: event.transactionId || null },
    });
    send(res, 400, { ok: false, error: "No tenant resolved for this webhook. Configure the integration in the dashboard first." }, {}, req);
    return;
  }

  const findOwner = () => {
    const fromList = connectedOnes.find((entry) => entry.dashboardId === dashboardId) || dashboardsWithPp.find((entry) => entry.dashboardId === dashboardId);
    if (fromList) return fromList;
    const dash = db.getDashboard(dashboardId);
    return dash ? { dashboardId, owner_id: dash.owner_id } : null;
  };
  const dashOwner = findOwner();

  const integration = db.getIntegration("perfectpay", dashboardId);
  const webhookToken = integration.webhookToken ? decryptSecret(integration.webhookToken) : "";
  if (webhookToken) {
    if (!provider.verifyWebhookToken(body, webhookToken)) {
      db.appendAuditLog({
        actorUserId: dashOwner?.owner_id || null,
        action: "webhook.invalid_token",
        resourceType: "webhook_event",
        resourceId: db.makeId("we"),
        metadata: { reason: "token_mismatch", dashboardId },
      });
      send(res, 401, { ok: false, error: "Invalid webhook token" }, {}, req);
      return;
    }
  } else {
    const secret = integration.webhookSecret ? decryptSecret(integration.webhookSecret) : (integration.webhookSecret || "");
    if (secret) {
      const valid = provider.verifyWebhookSignature(raw, req.headers, secret);
      if (!valid) {
        db.appendAuditLog({
          actorUserId: dashOwner?.owner_id || null,
          action: "webhook.invalid_signature",
          resourceType: "webhook_event",
          resourceId: db.makeId("we"),
          metadata: { reason: "signature_mismatch", dashboardId },
        });
        send(res, 401, { ok: false, error: "Invalid signature" }, {}, req);
        return;
      }
    }
  }

  const supportedEvents = new Set([
    "approved", "pending", "refunded", "chargeback", "cancelled", "rejected",
    "authorized", "completed", "in_process", "in_mediation", "in_review",
    "initiated", "precheckout", "checkout_error", "expired",
  ]);
  if (!event.transactionId || !event.eventType) {
    send(res, 400, { ok: false, error: "transaction_id and event_type are required" }, {}, req);
    return;
  }
  if (!supportedEvents.has(event.eventType)) {
    send(res, 400, { ok: false, error: "Unsupported event_type", supported_events: Array.from(supportedEvents) }, {}, req);
    return;
  }

  const idempotencyKey = `perfectpay:${event.transactionId}:${event.eventType}:${dashboardId}`;
  const receivedAt = new Date().toISOString();
  const inserted = db.insertWebhookEvent({
    id: db.makeId("we"),
    gateway: "perfectpay",
    transactionId: event.transactionId,
    eventType: event.eventType,
    idempotencyKey,
    receivedAt,
    status: "received",
    dashboardId,
    rawPayload: body,
  });
  if (!inserted) {
    send(res, 200, { ok: true, duplicate: true, idempotency_key: idempotencyKey }, {}, req);
    return;
  }

  if (event.isCheckout) {
    db.createCheckout({
      dashboardId,
      trackroiClickId: event.trackroiClickId || "",
      status: event.eventType,
    });
    db.appendAuditLog({
      actorUserId: dashOwner?.owner_id || null,
      action: "checkout.received",
      resourceType: "checkout",
      resourceId: db.makeId("co"),
      metadata: { eventType: event.eventType, transactionId: event.transactionId, duplicate: false, dashboardId },
    });
  } else {
    const source = event.trackroiClickId ? "direct" : "meta";
    const saleAt = event.dateApproved || event.dateCreated || receivedAt;
    db.upsertSale({
      id: db.makeId("sa"),
      gateway: "perfectpay",
      gatewayTransactionId: event.transactionId,
      eventType: event.eventType,
      status: event.eventType,
      amountCents: Number.isFinite(event.amountCents) ? event.amountCents : 0,
      currency: event.currency,
      trackroiClickId: event.trackroiClickId,
      source,
      quantity: event.quantity || 1,
      dashboardId,
      createdAt: saleAt,
      updatedAt: receivedAt,
    });
    if (event.eventType === "approved") {
      db.appendAuditLog({
        actorUserId: dashOwner?.owner_id || null,
        action: "sale.approved",
        resourceType: "sale",
        resourceId: db.makeId("sa"),
        metadata: { amountCents: event.amountCents, currency: event.currency },
      });
    }
  }

  db.updateIntegrationField("perfectpay", "lastReceivedEventAt", receivedAt, dashboardId);
  db.appendAuditLog({
    actorUserId: dashOwner?.owner_id || null,
    action: "webhook.received",
    resourceType: "webhook_event",
    resourceId: db.makeId("we"),
    metadata: { eventType: event.eventType, transactionId: event.transactionId, duplicate: false, dashboardId },
  });
  broadcastSSE({ type: "data", changed: ["dashboard", "sales", "funnel", "logs", "integrations"], dashboardId }, dashOwner?.owner_id || null);
  send(res, 200, { ok: true, duplicate: false, idempotency_key: idempotencyKey, sale_status: event.eventType }, {}, req);
}

/* ------------------------------------------------------------- Pagination */

function paginateSql(total, rows, query) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  return {
    items: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/* ------------------------------------------------------------- Main server */

function requireAuthAndCsrf(req, res) {
  const auth = requireAuth(req);
  if (!auth) {
    send(res, 401, { ok: false, error: "Não autenticado" }, {}, req);
    return null;
  }
  if (req.method !== "GET") {
    const csrfHeader = String(req.headers["x-csrf-token"] || "").trim();
    if (!db.verifyCsrfToken(csrfHeader, auth.user.id)) {
      send(res, 403, { ok: false, error: "Invalid CSRF token" }, {}, req);
      return null;
    }
  }
  return auth;
}

async function main() {
  assertEncryptionKey();
  db.open();
  db.pruneCsrfTokens();
  db.pruneLoginAttempts();
  db.pruneExpiredSessions();

  const server = http.createServer(async (req, res) => {
    const requestId = newRequestId();
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info(`${req.method} ${getPath(req.url)}`, {
        requestId,
        userId: req.authUserId || null,
        route: getPath(req.url),
        status: res.statusCode,
        latencyMs: Date.now() - startedAt,
        ip: getClientIp(req),
      });
    });
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, "", {}, req);
        return;
      }

      const pathname = getPath(req.url);
      const query = getQuery(req.url);

      if (req.method === "GET" && pathname === "/health") {
        const dbOk = (() => {
          try {
            db.get("SELECT 1");
            return true;
          } catch {
            return false;
          }
        })();
        send(res, dbOk ? 200 : 503, {
          ok: dbOk,
          service: "trackroi-backend",
          port: PORT,
          uptime: Math.round(process.uptime()),
        }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        handleEvents(req, res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/auth/status") {
        await handleAuthStatus(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/auth/login") {
        await handleAuthLogin(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/auth/register") {
        await handleAuthRegister(req, res);
        return;
      }
      if (req.method === "GET" && pathname === "/api/auth/me") {
        await handleAuthMe(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/auth/logout") {
        await handleAuthLogout(req, res);
        return;
      }

      if (req.method === "POST" && pathname === "/api/webhooks/perfectpay") {
        await handlePerfectPayWebhook(req, res);
        return;
      }

      const connectMatch = pathname.match(/^\/api\/integrations\/connect\/([a-z]+)\/callback$/);
      if (req.method === "GET" && connectMatch) {
        await handleOAuthCallback(req, res, connectMatch);
        return;
      }

      const connectStartMatch = pathname.match(/^\/api\/integrations\/connect\/([a-z]+)$/);
      if (connectStartMatch) {
        if (req.method === "GET") {
          await handleConnectStart(req, res, connectStartMatch);
          return;
        }
        if (req.method === "POST") {
          send(res, 410, { ok: false, error: "A conexão da Perfect Pay por e-mail/senha foi desativada. Use 'Configurar webhook' em Conexões." }, {}, req);
          return;
        }
      }

      const auth = requireAuthAndCsrf(req, res);
      if (!auth) return;
      req.authUserId = auth.user.id;

      if (req.method === "GET") {
        const healthMatch = pathname.match(/^\/api\/integrations\/([a-z]+)\/health$/);
        if (healthMatch) {
          const dashboardId = resolveDashboardId(auth, req);
          await handleIntegrationHealth(req, res, healthMatch, dashboardId);
          return;
        }
      }

      if (req.method === "GET" && pathname === "/api/dashboard") {
        const dashboardId = resolveDashboardId(auth, req);
        const period = resolvePeriod(query);
        const source = String(query.source || "all").toLowerCase();
        const aggregates = db.dashboardAggregates(source, period, dashboardId);
        const dashboard = buildDashboardFromAggregates({ aggregates, source, period, finance: db.getSettings(dashboardId).finance });
        dashboard.trend = db.dailyTrend(source, period, dashboardId);
        send(res, 200, dashboard, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/metrics") {
        const dashboardId = resolveDashboardId(auth, req);
        const period = resolvePeriod(query);
        const source = String(query.source || "all").toLowerCase();
        const aggregates = db.dashboardAggregates(source, period, dashboardId);
        const dashboard = buildDashboardFromAggregates({ aggregates, source, period, finance: db.getSettings(dashboardId).finance });
        send(res, 200, { ok: true, metrics: dashboard.summary, cards: dashboard.cards, funnel: dashboard.funnel }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/sales") {
        const dashboardId = resolveDashboardId(auth, req);
        const total = db.countSales(dashboardId);
        const rows = db.listSales(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50), dashboardId);
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/clicks") {
        const dashboardId = resolveDashboardId(auth, req);
        const total = db.countClicks(dashboardId);
        const rows = db.listClicks(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50), dashboardId);
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/checkouts") {
        const dashboardId = resolveDashboardId(auth, req);
        const total = db.countCheckouts(dashboardId);
        const rows = db.listCheckouts(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50), dashboardId);
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/webhook-events") {
        const dashboardId = resolveDashboardId(auth, req);
        const total = db.countWebhookEvents(dashboardId);
        const rows = db.listWebhookEvents(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50), dashboardId);
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/audit-logs") {
        const total = db.countAuditLogs(auth.user.id);
        const rows = db.listAuditLogs(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50), auth.user.id);
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/products") {
        const dashboardId = resolveDashboardId(auth, req);
        send(res, 200, { ok: true, items: db.listProducts(dashboardId) }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/products") {
        const dashboardId = resolveDashboardId(auth, req);
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const name = String(body?.name || "").trim();
        if (!name) {
          send(res, 400, { ok: false, error: "name is required" }, {}, req);
          return;
        }
        const product = db.createProduct({ dashboardId, name, priceCents: Math.round(Number(body?.priceCents || 0)) });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "product.create", resourceType: "product", resourceId: product.id });
        broadcastSSE({ type: "data", changed: ["products"], dashboardId }, auth.user.id);
        send(res, 201, { ok: true, item: product }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        const dashboardId = resolveDashboardId(auth, req);
        send(res, 200, { ok: true, settings: db.getSettings(dashboardId) }, {}, req);
        return;
      }

      if (req.method === "PUT" && pathname === "/api/settings") {
        const dashboardId = resolveDashboardId(auth, req);
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const current = db.getSettings(dashboardId);
        db.setSettings({
          ...current,
          ...(body || {}),
          general: { ...(current.general || {}), ...((body || {}).general || {}) },
          appearance: { ...(current.appearance || {}), ...((body || {}).appearance || {}) },
          dashboard: { ...(current.dashboard || {}), ...((body || {}).dashboard || {}) },
          finance: { ...(current.finance || {}), ...((body || {}).finance || {}) },
        }, dashboardId);
        db.appendAuditLog({ actorUserId: auth.user.id, action: "settings.update", resourceType: "settings", resourceId: "global" });
        broadcastSSE({ type: "data", changed: ["settings"], dashboardId }, auth.user.id);
        send(res, 200, { ok: true, settings: db.getSettings(dashboardId) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/integrations") {
        const dashboardId = resolveDashboardId(auth, req);
        send(res, 200, { ok: true, items: listPublicIntegrations(dashboardId) }, {}, req);
        return;
      }

      const integrationUpdateMatch = pathname.match(/^\/api\/integrations\/([a-z]+)$/);
      if (req.method === "PUT" && integrationUpdateMatch) {
        const dashboardId = resolveDashboardId(auth, req);
        await handleIntegrationUpdate(req, res, integrationUpdateMatch, auth.user, dashboardId);
        return;
      }
      if (req.method === "DELETE" && integrationUpdateMatch) {
        const dashboardId = resolveDashboardId(auth, req);
        await handleIntegrationDisconnect(req, res, integrationUpdateMatch, auth.user, dashboardId);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/click") {
        const dashboardId = resolveDashboardId(auth, req);
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const click = db.createClick({
          dashboardId,
          trackroiClickId: String(body?.trackroi_click_id || "").trim() || undefined,
          source: String(body?.source || "direct"),
          campaignId: body?.campaign_id || body?.campaignId || null,
          adsetId: body?.adset_id || body?.adsetId || null,
          adId: body?.ad_id || body?.adId || null,
          landingPage: body?.landing_page || body?.landingPage || "/",
          referrer: body?.referrer || null,
          fbclid: body?.fbclid || null,
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "click.create", resourceType: "click", resourceId: click.id });
        broadcastSSE({ type: "data", changed: ["dashboard", "funnel", "clicks"], dashboardId }, auth.user.id);
        send(res, 201, { ok: true, item: click }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/checkout") {
        const dashboardId = resolveDashboardId(auth, req);
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const checkout = db.createCheckout({
          dashboardId,
          trackroiClickId: String(body?.trackroi_click_id || "").trim(),
          status: String(body?.status || "initiated"),
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "checkout.create", resourceType: "checkout", resourceId: checkout.id });
        broadcastSSE({ type: "data", changed: ["dashboard", "funnel", "checkouts"], dashboardId }, auth.user.id);
        send(res, 201, { ok: true, item: checkout }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/spend") {
        const dashboardId = resolveDashboardId(auth, req);
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const spend = db.createSpend({
          dashboardId,
          source: String(body?.source || "meta"),
          amountCents: Math.round(Number(body?.amountCents ?? body?.amount_cents ?? 0)),
          currency: String(body?.currency || "BRL"),
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "spend.create", resourceType: "spend", resourceId: spend.id });
        broadcastSSE({ type: "data", changed: ["dashboard", "metrics", "funnel"], dashboardId }, auth.user.id);
        send(res, 201, { ok: true, item: spend }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/import/csv") {
        const dashboardId = resolveDashboardId(auth, req);
        await handleImportCsv(req, res, auth.user, dashboardId);
        return;
      }

      if (req.method === "GET" && pathname === "/api/imports") {
        const dashboardId = resolveDashboardId(auth, req);
        await handleListImportRuns(req, res, dashboardId);
        return;
      }

      if (req.method === "POST" && pathname === "/api/integrations/meta/sync") {
        const dashboardId = resolveDashboardId(auth, req);
        await handleMetaSync(req, res, auth.user, dashboardId);
        return;
      }

      send(res, 404, { ok: false, error: "Not found" }, {}, req);
    } catch (error) {
      logger.error("Unhandled request error", { requestId, error: error.message, stack: error.stack });
      if (!res.headersSent) {
        send(res, 500, { ok: false, error: error.message || "Internal server error" }, {}, req);
      } else {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    }
  });

  const certFile = process.env.TLS_CERT || path.join(__dirname, "certs", "cert.pem");
  const keyFile = process.env.TLS_KEY || path.join(__dirname, "certs", "key.pem");
  const hasTls = process.env.ENABLE_TLS === "true" && fs.existsSync(certFile) && fs.existsSync(keyFile);
  const protocol = hasTls ? "https" : "http";

  const requestHandler = (req, res) => server.emit("request", req, res);
  const onListen = () => logger.info("Backend listening", { protocol, port: PORT });
  const onError = (error) => {
    if (error.code === "EADDRINUSE") {
      logger.error(`A porta ${PORT} já está em uso`, { hint: "Feche o processo anterior ou mude a variável PORT no backend/.env" });
      process.exit(1);
    }
    throw error;
  };

  if (hasTls) {
    const tlsServer = https.createServer(
      { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
      requestHandler
    );
    tlsServer.once("error", onError);
    tlsServer.listen(PORT, onListen);
  } else {
    server.once("error", onError);
    server.listen(PORT, onListen);
  }

  function shutdown(signal) {
    logger.info("Backend encerrado", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});