const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const db = require("./src/db");
const { logger, newRequestId } = require("./src/logger");
const { encryptSecret, decryptSecret, assertEncryptionKey } = require("./src/crypto");
const { buildDashboardFromAggregates } = require("./src/metrics");
const { importCsv } = require("./src/csv-import");
const providers = require("./src/providers");

const PORT = Number(process.env.PORT || 4100);
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || `http://localhost:${PORT}`;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5180";

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || FRONTEND_ORIGIN)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";

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
    ...extraHeaders,
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readRawBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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

/* ------------------------------------------------------------- SSE */

const eventClients = new Map();

function broadcastSSE(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const set of eventClients.values()) {
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
  if (!token || !db.getUserByToken(token)) {
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

  let set = eventClients.get(token);
  if (!set) {
    set = new Set();
    eventClients.set(token, set);
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
    if (!set.size) eventClients.delete(token);
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

function renderPerfectPayForm({ token, error }) {
  const safeError = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Conectar Perfect Pay</title>
    <style>
      :root { color-scheme: dark; --bg:#0a0a0c; --panel:#121418; --border:#1f232b; --text:#f5f7fa; --muted:#8b93a1; --accent:#39ff88; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font-family:Inter, Segoe UI, Arial, sans-serif; padding:24px; }
      .card { width:min(460px,100%); border:1px solid var(--border); border-radius:14px; background:var(--panel); padding:28px; box-shadow:0 22px 60px rgba(0,0,0,.35); }
      h1 { margin:0 0 6px; font-size:20px; }
      p { margin:0 0 18px; color:var(--muted); font-size:14px; line-height:1.5; }
      form { display:grid; gap:14px; }
      label { display:grid; gap:6px; font-size:12px; color:var(--muted); }
      input { height:42px; border-radius:8px; border:1px solid var(--border); background:#0d0f13; color:var(--text); padding:0 14px; }
      button { height:42px; border-radius:8px; border:1px solid var(--border); background:var(--accent); color:#04140a; font-weight:600; cursor:pointer; }
      .error { margin-top:14px; padding:12px 14px; border-radius:8px; border:1px solid rgba(255,107,107,.25); background:rgba(255,107,107,.08); color:#ffb3b3; font-size:13px; }
      .note { margin-top:14px; font-size:12px; color:var(--muted); }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Conectar Perfect Pay</h1>
      <p>Use o e-mail e a senha da sua conta Perfect Pay para gerar o token de acesso no backend.</p>
      <form method="post" action="/api/integrations/connect/perfectpay">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <label><span>E-mail da Perfect Pay</span><input name="email" type="email" autocomplete="username" required /></label>
        <label><span>Senha</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Conectar Perfect Pay</button>
      </form>
      ${safeError}
      <div class="note">Esta janela será fechada automaticamente após conectar.</div>
    </section>
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
  const token = String(getQuery(req.url).token || "").trim();
  const user = token ? db.getUserByToken(token) : null;
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
    sendRawHtml(res, renderPerfectPayForm({ token, error: "" }));
    return;
  }
  let authUrl;
  try {
    authUrl = provider.getAuthUrl(token);
  } catch (error) {
    sendRawHtml(res, oauthResultHtml({ providerId, ok: false, error: friendlyProviderError(providerId, error) }));
    return;
  }
  res.writeHead(302, { Location: authUrl, ...corsHeadersFor(req) });
  res.end();
}

function storeConnection(providerId, extra) {
  const existing = db.getIntegration(providerId);
  db.upsertIntegration(providerId, {
    ...existing,
    status: "connected",
    connected: true,
    lastSyncAt: new Date().toISOString(),
    errors: [],
    ...extra,
  });
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
    const user = db.getUserByToken(String(query.state || "").trim());
    const result = await provider.handleOAuthCallback(query);
    const extra = {
      accessToken: encryptSecret(result.accessToken),
      connectedAccount: result.connectedAccount || null,
    };
    if (providerId === "meta") {
      extra.tokenStatus = "connected";
      extra.adAccountId = result.accountId || null;
    }
    storeConnection(providerId, extra);
    db.appendAuditLog({
      actorUserId: user?.id || null,
      action: `integration.${providerId}.oauth_connected`,
      resourceType: "integration",
      resourceId: providerId,
    });
    broadcastSSE({ type: "data", changed: ["integrations"] });
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
  let body;
  try {
    body = await parseBody(req, true);
  } catch (error) {
    sendRawHtml(res, oauthResultHtml({ providerId: "perfectpay", ok: false, error: "Dados do formulário inválidos." }));
    return;
  }
  const { body: fields, raw } = body || {};
  const provider = providers.get("perfectpay");
  const token = String(fields?.token || "").trim();
  const user = token ? db.getUserByToken(token) : null;
  if (!user) {
    sendRawHtml(res, oauthResultHtml({ providerId: "perfectpay", ok: false, error: "Sessão expirada. Reabra a página de conexões e tente novamente." }));
    return;
  }
  if (!fields?.email || !fields?.password) {
    sendRawHtml(res, renderPerfectPayForm({ token, error: "Preencha e-mail e senha para continuar." }));
    return;
  }
  try {
    const result = await provider.handleAuth({ email: String(fields.email).trim(), password: String(fields.password) });
    const existing = db.getIntegration("perfectpay");
    storeConnection("perfectpay", {
      accessToken: encryptSecret(result.accessToken),
      connectedAccount: result.connectedAccount || null,
      apiStatus: "connected",
      retryStatus: "idle",
      webhookUrl: existing.webhookUrl || null,
    });
    db.appendAuditLog({
      actorUserId: user.id,
      action: "integration.perfectpay.connected",
      resourceType: "integration",
      resourceId: "perfectpay",
    });
    broadcastSSE({ type: "data", changed: ["integrations"] });
    sendRawHtml(res, oauthResultHtml({ providerId: "perfectpay", ok: true, connectedAccount: result.connectedAccount }));
  } catch (error) {
    logger.error("Perfect Pay connect failed", { error: error.message });
    db.appendAuditLog({
      action: "integration.perfectpay.connect_failed",
      resourceType: "integration",
      resourceId: "perfectpay",
      metadata: { error: error.message },
    });
    sendRawHtml(res, renderPerfectPayForm({ token, error: friendlyProviderError("perfectpay", error) }));
  }
}

/* ------------------------------------------------------------- Integrations */

const SECRET_FIELDS = new Set(["accessToken", "webhookSecret", "access_token", "webhook_secret"]);

function publicIntegration(provider) {
  const data = db.getIntegration(provider.id);
  const health = provider.health();
  const safe = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_FIELDS.has(key)) continue;
    safe[key] = value;
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

function listPublicIntegrations() {
  return providers.list().map((provider) => publicIntegration(provider));
}

async function handleIntegrationHealth(req, res, match) {
  const provider = providers.get(match[1]);
  if (!provider) {
    send(res, 404, { ok: false, error: "Provider não encontrado" }, {}, req);
    return;
  }
  const health = provider.health();
  const data = db.getIntegration(provider.id);
  send(res, 200, { ok: true, provider: provider.id, ...health, connected: data.status === "connected" || data.connected === true || data.apiStatus === "connected" }, {}, req);
}

async function handleIntegrationUpdate(req, res, match, user) {
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
  const current = db.getIntegration(provider.id);
  const allowed = new Set(provider.writableFields || []);
  for (const [key, value] of Object.entries(body || {})) {
    if (!allowed.has(key)) continue;
    if (key === "webhookSecret" && typeof value === "string" && value) {
      current.webhookSecret = encryptSecret(value);
    } else {
      current[key] = value;
    }
  }
  if (body?.webhookUrl !== undefined) current.webhookUrl = String(body.webhookUrl || "").trim();
  db.upsertIntegration(provider.id, current);
  db.appendAuditLog({
    actorUserId: user.id,
    action: `integration.${provider.id}.update`,
    resourceType: "integration",
    resourceId: provider.id,
    metadata: { fields: Object.keys(body || {}).filter((key) => allowed.has(key)) },
  });
  broadcastSSE({ type: "data", changed: ["integrations"] });
  send(res, 200, { ok: true, item: publicIntegration(provider) }, {}, req);
}

/* ------------------------------------------------------------- Import CSV */

async function handleImportCsv(req, res, user) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    send(res, 400, { ok: false, error: "Envie o arquivo como multipart/form-data." }, {}, req);
    return;
  }
  let raw;
  try {
    raw = await readRawBodyBuffer(req);
  } catch {
    send(res, 400, { ok: false, error: "Não foi possível ler o arquivo enviado." }, {}, req);
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
        db.insertSpend(record);
        spendCommitted++;
      }
      for (const record of result.clicksRecords) {
        db.insertClick(record);
        clicksCommitted++;
      }
      for (const record of result.salesRecords || []) {
        db.insertSale(record);
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
  const metaIntegration = db.getIntegration("meta");
  db.upsertIntegration("meta", {
    ...metaIntegration,
    status: "connected",
    connected: true,
    lastSyncAt: now,
    importsCount: (metaIntegration.importsCount || 0) + 1,
    lastImportId: result.importId,
    errors: [],
  });
  broadcastSSE({ type: "data", changed: ["dashboard", "sales", "funnel", "metrics", "logs", "integrations"] });
  send(res, 200, { ok: true, importId: result.importId, stats: commits }, {}, req);
}

async function handleListImportRuns(req, res) {
  send(res, 200, { ok: true, items: db.listImportRuns(20) }, {}, req);
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
  if (password.length < 6) {
    send(res, 400, { ok: false, error: "A senha deve ter pelo menos 6 caracteres" }, {}, req);
    return;
  }
  if (db.getUserByEmail(email)) {
    send(res, 409, { ok: false, error: "Este e-mail já está cadastrado" }, {}, req);
    return;
  }
  const userCount = db.get("SELECT COUNT(*) AS n FROM users").n;
  const user = db.createUser({ name, email, role: userCount === 0 ? "admin" : "member", password });
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

  const integration = db.getIntegration("perfectpay");
  const secret = integration.webhookSecret ? decryptSecret(integration.webhookSecret) : (integration.webhookSecret || "");
  const provider = providers.get("perfectpay");
  if (secret) {
    const valid = provider.verifyWebhookSignature(raw, req.headers, secret);
    if (!valid) {
      db.appendAuditLog({
        action: "webhook.invalid_signature",
        resourceType: "webhook_event",
        resourceId: db.makeId("we"),
        metadata: { reason: "signature_mismatch" },
      });
      send(res, 401, { ok: false, error: "Invalid signature" }, {}, req);
      return;
    }
  }

  const event = provider.normalizeWebhookEvent(body);
  const supportedEvents = new Set(["approved", "pending", "refunded", "chargeback", "cancelled", "rejected"]);
  if (!event.transactionId || !event.eventType) {
    send(res, 400, { ok: false, error: "transaction_id and event_type are required" }, {}, req);
    return;
  }
  if (!supportedEvents.has(event.eventType)) {
    send(res, 400, { ok: false, error: "Unsupported event_type", supported_events: Array.from(supportedEvents) }, {}, req);
    return;
  }

  const idempotencyKey = `perfectpay:${event.transactionId}:${event.eventType}`;
  const receivedAt = new Date().toISOString();
  const inserted = db.insertWebhookEvent({
    id: db.makeId("we"),
    gateway: "perfectpay",
    transactionId: event.transactionId,
    eventType: event.eventType,
    idempotencyKey,
    receivedAt,
    status: "received",
    rawPayload: body,
  });
  if (!inserted) {
    send(res, 200, { ok: true, duplicate: true, idempotency_key: idempotencyKey }, {}, req);
    return;
  }

  const source = event.trackroiClickId ? "direct" : "meta";
  db.upsertSale({
    gateway: "perfectpay",
    gatewayTransactionId: event.transactionId,
    eventType: event.eventType,
    status: event.eventType,
    amountCents: Number.isFinite(event.amountCents) ? event.amountCents : 0,
    currency: event.currency,
    trackroiClickId: event.trackroiClickId,
    source,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  });
  db.updateIntegrationField("perfectpay", "lastReceivedEventAt", receivedAt);
  db.appendAuditLog({
    action: "webhook.received",
    resourceType: "webhook_event",
    resourceId: db.makeId("we"),
    metadata: { eventType: event.eventType, transactionId: event.transactionId, duplicate: false },
  });
  if (event.eventType === "approved") {
    db.appendAuditLog({
      action: "sale.approved",
      resourceType: "sale",
      resourceId: db.makeId("sa"),
      metadata: { amountCents: event.amountCents, currency: event.currency },
    });
  }
  broadcastSSE({ type: "data", changed: ["dashboard", "sales", "funnel", "logs", "integrations"] });
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
          await handlePerfectPaySubmit(req, res);
          return;
        }
      }

      const auth = requireAuthAndCsrf(req, res);
      if (!auth) return;
      req.authUserId = auth.user.id;

      if (req.method === "GET") {
        const healthMatch = pathname.match(/^\/api\/integrations\/([a-z]+)\/health$/);
        if (healthMatch) {
          await handleIntegrationHealth(req, res, healthMatch);
          return;
        }
      }

      if (req.method === "GET" && pathname === "/api/dashboard") {
        const source = String(query.source || "all").toLowerCase();
        const aggregates = db.dashboardAggregates(source);
        send(res, 200, buildDashboardFromAggregates({ aggregates, source }), {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/metrics") {
        const source = String(query.source || "all").toLowerCase();
        const aggregates = db.dashboardAggregates(source);
        const dashboard = buildDashboardFromAggregates({ aggregates, source });
        send(res, 200, { ok: true, metrics: dashboard.summary, cards: dashboard.cards, funnel: dashboard.funnel }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/sales") {
        const total = db.countSales();
        const rows = db.listSales(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50));
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/clicks") {
        const total = db.countClicks();
        const rows = db.listClicks(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50));
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/checkouts") {
        const total = db.countCheckouts();
        const rows = db.listCheckouts(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50));
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/webhook-events") {
        const total = db.countWebhookEvents();
        const rows = db.listWebhookEvents(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50));
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/audit-logs") {
        const total = db.countAuditLogs();
        const rows = db.listAuditLogs(Math.min(100, Number(query.limit) || 50), Math.max(0, (Number(query.page) || 1) - 1) * (Number(query.limit) || 50));
        send(res, 200, { ok: true, ...paginateSql(total, rows, query) }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/products") {
        send(res, 200, { ok: true, items: db.listProducts() }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/products") {
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
        const product = db.createProduct({ name, priceCents: Math.round(Number(body?.priceCents || 0)) });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "product.create", resourceType: "product", resourceId: product.id });
        broadcastSSE({ type: "data", changed: ["products"] });
        send(res, 201, { ok: true, item: product }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        send(res, 200, { ok: true, settings: db.getSettings() }, {}, req);
        return;
      }

      if (req.method === "PUT" && pathname === "/api/settings") {
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const current = db.getSettings();
        db.setSettings({
          ...current,
          ...(body || {}),
          general: { ...(current.general || {}), ...((body || {}).general || {}) },
          appearance: { ...(current.appearance || {}), ...((body || {}).appearance || {}) },
          dashboard: { ...(current.dashboard || {}), ...((body || {}).dashboard || {}) },
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "settings.update", resourceType: "settings", resourceId: "global" });
        broadcastSSE({ type: "data", changed: ["settings"] });
        send(res, 200, { ok: true, settings: db.getSettings() }, {}, req);
        return;
      }

      if (req.method === "GET" && pathname === "/api/integrations") {
        send(res, 200, { ok: true, items: listPublicIntegrations() }, {}, req);
        return;
      }

      const integrationUpdateMatch = pathname.match(/^\/api\/integrations\/([a-z]+)$/);
      if (req.method === "PUT" && integrationUpdateMatch) {
        await handleIntegrationUpdate(req, res, integrationUpdateMatch, auth.user);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/click") {
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const click = db.createClick({
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
        broadcastSSE({ type: "data", changed: ["dashboard", "funnel", "clicks"] });
        send(res, 201, { ok: true, item: click }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/checkout") {
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const checkout = db.createCheckout({
          trackroiClickId: String(body?.trackroi_click_id || "").trim(),
          status: String(body?.status || "initiated"),
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "checkout.create", resourceType: "checkout", resourceId: checkout.id });
        broadcastSSE({ type: "data", changed: ["dashboard", "funnel", "checkouts"] });
        send(res, 201, { ok: true, item: checkout }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/dev/spend") {
        let body;
        try {
          body = await parseBody(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error.message }, {}, req);
          return;
        }
        const spend = db.createSpend({
          source: String(body?.source || "meta"),
          amountCents: Math.round(Number(body?.amountCents ?? body?.amount_cents ?? 0)),
          currency: String(body?.currency || "BRL"),
        });
        db.appendAuditLog({ actorUserId: auth.user.id, action: "spend.create", resourceType: "spend", resourceId: spend.id });
        broadcastSSE({ type: "data", changed: ["dashboard", "metrics", "funnel"] });
        send(res, 201, { ok: true, item: spend }, {}, req);
        return;
      }

      if (req.method === "POST" && pathname === "/api/import/csv") {
        await handleImportCsv(req, res, auth.user);
        return;
      }

      if (req.method === "GET" && pathname === "/api/imports") {
        await handleListImportRuns(req, res);
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