const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const {
  readState,
  writeState,
  createEmptyState,
  createSession,
  pruneExpiredSessions,
  getUserByToken,
  verifyPassword,
  createUserRecord,
  appendAuditLog,
  encryptSecret,
  decryptSecret,
} = require("./src/store");
const { buildDashboard } = require("./src/metrics");

const PORT = Number(process.env.PORT || 4100);
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || `http://localhost:${PORT}`;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5180";
const csrfTokens = new Map();
const META_API_VERSION = process.env.META_API_VERSION || "v22.0";
const META_APP_ID = String(process.env.META_APP_ID || "").trim();
const META_APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const META_REDIRECT_URI = String(process.env.META_REDIRECT_URI || `${BACKEND_ORIGIN}/api/integrations/connect/meta/callback`).trim();
const META_SCOPES = String(process.env.META_SCOPES || "ads_read,ads_management,pages_read_engagement,pages_show_list");

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || FRONTEND_ORIGIN)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";

function logEvent(level, message, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...details,
  };
  const line = `${entry.ts} [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line, details);
  else console.log(line, details);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
  "Access-Control-Allow-Credentials": "true",
};

function corsHeadersFor(req) {
  const origin = String(req.headers.origin || "").trim();
  if (ALLOWED_ORIGINS.length && ALLOWED_ORIGINS.includes(origin)) {
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("application/x-www-form-urlencoded")) {
          resolve(Object.fromEntries(new URLSearchParams(raw).entries()));
          return;
        }
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function getPath(reqUrl) {
  return new URL(reqUrl, "http://localhost").pathname;
}

function getQuery(reqUrl) {
  const parsed = new URL(reqUrl, "http://localhost");
  return Object.fromEntries(parsed.searchParams.entries());
}

function getQueryParam(reqUrl, name) {
  return new URL(reqUrl, "http://localhost").searchParams.get(name);
}

function getAuthToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-session-token"] || "").trim();
}

async function requireAuth(req) {
  const state = await readState();
  const token = getAuthToken(req);
  const user = token ? getUserByToken(state, token) : null;
  return { state, token, user };
}

async function saveStateWithAudit(state, entry) {
  appendAuditLog(state, entry);
  await writeState(state);
}

function connectionTokenFromQuery(reqUrl) {
  return String(getQueryParam(reqUrl, "token") || "").trim();
}

function buildMetaAuthorizationUrl(stateToken) {
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URI,
    response_type: "code",
    scope: META_SCOPES,
    state: stateToken,
  });
  return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${params.toString()}`;
}

function renderPerfectPayConnectPage({ token, error = "" }) {
  const safeError = error ? `<div class="connect-error">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Conectar Perfect Pay</title>
      <style>
        :root { color-scheme: dark; --bg:#080b0f; --panel:#121820; --border:#27313d; --text:#f5f7fa; --muted:#93a0af; --radius:6px; }
        * { box-sizing: border-box; }
        body { margin:0; min-height:100vh; display:grid; place-items:center; background:linear-gradient(180deg,#07090c 0%,#0b0f14 100%); color:var(--text); font-family: Inter, Segoe UI, Arial, sans-serif; padding:24px; }
        .card { width:min(540px,100%); border:1px solid var(--border); border-radius:12px; background:rgba(18,24,32,.98); padding:24px; box-shadow:0 22px 60px rgba(0,0,0,.35); }
        h1 { margin:0 0 10px; font-size:28px; }
        p { color:var(--muted); line-height:1.5; }
        form { display:grid; gap:14px; margin-top:18px; }
        label { display:grid; gap:6px; font-size:12px; color:var(--muted); }
        input { height:42px; border-radius:6px; border:1px solid var(--border); background:#10151b; color:var(--text); padding:0 14px; }
        button { height:42px; border-radius:6px; border:1px solid var(--border); background:#10151b; color:var(--text); cursor:pointer; }
        .connect-error { margin-top:14px; padding:12px 14px; border-radius:6px; border:1px solid rgba(230,107,107,.25); background:rgba(230,107,107,.08); color:#ffb3b3; }
        .note { margin-top:14px; font-size:13px; color:var(--muted); }
        .token { word-break:break-all; font-size:12px; color:var(--muted); }
      </style>
    </head>
    <body>
      <section class="card">
        <h1>Conectar Perfect Pay</h1>
        <p>Este atalho usa a autenticação oficial por e-mail e senha da API da Perfect Pay para gerar o token no backend. O webhook continua manual e pode ser configurado depois.</p>
        <form method="post" action="/api/integrations/connect/perfectpay">
          <input type="hidden" name="token" value="${escapeHtml(token)}" />
          <label><span>E-mail da Perfect Pay</span><input name="email" type="email" autocomplete="username" required /></label>
          <label><span>Senha</span><input name="password" type="password" autocomplete="current-password" required /></label>
          <button type="submit">Conectar Perfect Pay</button>
        </form>
        ${safeError}
        <div class="note">Depois de conectar, você ainda pode ajustar o webhook manualmente na dashboard.</div>
      </section>
    </body>
  </html>`;
}

function redirectConnected(res, provider) {
  const url = new URL(`${FRONTEND_ORIGIN}/index.html`);
  url.hash = "#connections";
  url.searchParams.set("connected", provider);
  res.writeHead(302, {
    Location: url.toString(),
    ...CORS_HEADERS,
  });
  res.end();
}

async function exchangeMetaCode(code) {
  if (!META_APP_ID || !META_APP_SECRET) {
    throw new Error("Meta app credentials are not configured");
  }

  const tokenUrl = new URL(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", META_APP_ID);
  tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
  tokenUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
  tokenUrl.searchParams.set("code", code);

  const response = await fetch(tokenUrl);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || "Failed to exchange Meta code");
  }
  return body;
}

async function fetchMetaProfile(accessToken) {
  const profileUrl = new URL(`https://graph.facebook.com/${META_API_VERSION}/me`);
  profileUrl.searchParams.set("fields", "id,name");
  profileUrl.searchParams.set("access_token", accessToken);
  const response = await fetch(profileUrl);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return null;
  }
  return body;
}

async function handleMetaConnectStart(req, res, query) {
  const token = connectionTokenFromQuery(req.url);
  if (!token) {
    send(res, 401, { ok: false, error: "Token de sessão ausente" }, {}, req);
    return;
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    send(res, 400, {
      ok: false,
      error: "Meta app credentials are not configured",
      hint: "Defina META_APP_ID e META_APP_SECRET no backend.",
    }, {}, req);
    return;
  }
  const authUrl = buildMetaAuthorizationUrl(token);
  res.writeHead(302, { Location: authUrl, ...corsHeadersFor(req) });
  res.end();
}

async function handleMetaConnectCallback(req, res, query) {
  const token = String(query.state || "").trim();
  const code = String(query.code || "").trim();
  if (!token || !code) {
    send(res, 400, { ok: false, error: "Missing OAuth state or code" }, {}, req);
    return;
  }

  const state = await readState();
  const user = getUserByToken(state, token);
  if (!user) {
    send(res, 401, { ok: false, error: "Invalid session token" }, {}, req);
    return;
  }

  const exchange = await exchangeMetaCode(code);
  const accessToken = String(exchange.access_token || "").trim();
  if (!accessToken) {
    send(res, 502, { ok: false, error: "Meta authorization did not return an access token" }, {}, req);
    return;
  }

  const profile = await fetchMetaProfile(accessToken);
  state.integrations.meta = {
    ...state.integrations.meta,
    status: "connected",
    tokenStatus: "connected",
    accessToken: encryptSecret(accessToken),
    lastSyncAt: new Date().toISOString(),
    connectedAccount: profile?.name || state.integrations.meta.connectedAccount || "Meta user",
    errors: [],
  };
  appendAuditLog(state, {
    actorUserId: user.id,
    action: "integration.meta.oauth_connected",
    resourceType: "integration",
    resourceId: "meta",
  });
  await writeState(state);
  redirectConnected(res, "meta");
}

async function handlePerfectPayConnectStart(req, res) {
  const token = connectionTokenFromQuery(req.url);
  if (!token) {
    send(res, 401, { ok: false, error: "Token de sessão ausente" }, {}, req);
    return;
  }
  send(res, 200, renderPerfectPayConnectPage({ token }), {
    "Content-Type": "text/html; charset=utf-8",
  }, req);
}

async function handlePerfectPayConnectSubmit(req, res) {
  const body = await parseBody(req);
  const email = String(body?.email || "").trim();
  const password = String(body?.password || "");
  const token = String(body?.token || "").trim() || connectionTokenFromQuery(req.url);

  if (!token) {
    send(res, 401, { ok: false, error: "Token de sessão ausente" }, {}, req);
    return;
  }
  if (!email || !password) {
    send(res, 400, renderPerfectPayConnectPage({ token, error: "Preencha e-mail e senha para continuar." }), {
      "Content-Type": "text/html; charset=utf-8",
    }, req);
    return;
  }

  const state = await readState();
  const user = getUserByToken(state, token);
  if (!user) {
    send(res, 401, { ok: false, error: "Sessão inválida" }, {}, req);
    return;
  }

  const response = await fetch("https://app.perfectpay.com.br/api/auth/login", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || "Falha ao autenticar na Perfect Pay";
    send(res, 400, renderPerfectPayConnectPage({ token, error: message }), {
      "Content-Type": "text/html; charset=utf-8",
    }, req);
    return;
  }

  const accessToken = String(payload.access_token || payload.token || "").trim();
  if (!accessToken) {
    send(res, 502, renderPerfectPayConnectPage({ token, error: "A Perfect Pay não retornou um token de acesso." }), {
      "Content-Type": "text/html; charset=utf-8",
    }, req);
    return;
  }

  state.integrations.perfectPay = {
    ...state.integrations.perfectPay,
    status: "connected",
    apiStatus: "connected",
    accessToken: encryptSecret(accessToken),
    retryStatus: "idle",
    errors: [],
  };
  appendAuditLog(state, {
    actorUserId: user.id,
    action: "integration.perfectpay.connected",
    resourceType: "integration",
    resourceId: "perfectpay",
  });
  await writeState(state);
  redirectConnected(res, "perfectpay");
}

function safeEventType(raw) {
  return String(raw || "").trim().toLowerCase();
}

const loginAttempts = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttempt > windowMs) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= maxAttempts;
}

function recordLoginAttempt(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > windowMs) {
    loginAttempts.set(ip, { firstAttempt: now, count: 1 });
    return;
  }
  entry.count += 1;
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function createCsrfToken(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  csrfTokens.set(token, { userId, createdAt: Date.now() });
  return token;
}

function verifyCsrfToken(token, userId) {
  if (!token) return false;
  const entry = csrfTokens.get(token);
  if (!entry) return false;
  if (entry.userId !== userId) return false;
  if (Date.now() - entry.createdAt > 24 * 60 * 60 * 1000) {
    csrfTokens.delete(token);
    return false;
  }
  return true;
}

async function handleAuthLogin(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    send(res, 429, { ok: false, error: "Muitas tentativas de login. Aguarde 15 minutos." }, {}, req);
    return;
  }
  const body = await parseBody(req);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const state = await readState();
  const user = state.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.password)) {
    recordLoginAttempt(ip);
    send(res, 401, { ok: false, error: "Credenciais inválidas" }, {}, req);
    return;
  }

  resetLoginAttempts(ip);
  pruneExpiredSessions(state);
  const session = createSession(user.id);
  state.sessions.push(session);
  appendAuditLog(state, { actorUserId: user.id, action: "auth.login", resourceType: "session", resourceId: session.id });
  await writeState(state);

  send(res, 200, {
    ok: true,
    token: session.token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    csrfToken: createCsrfToken(user.id),
    expiresAt: session.expiresAt,
  }, {}, req);
}

async function handleAuthStatus(req, res) {
  const state = await readState();
  send(res, 200, { ok: true, hasUsers: state.users.length > 0 }, {}, req);
}

async function handleAuthRegister(req, res) {
  if (!ALLOW_REGISTRATION) {
    send(res, 403, { ok: false, error: "Cadastro desativado. Use a conta de administrador fornecida." }, {}, req);
    return;
  }
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    send(res, 429, { ok: false, error: "Muitas tentativas. Aguarde 15 minutos." }, {}, req);
    return;
  }
  const body = await parseBody(req);
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

  const state = await readState();
  if (state.users.some((u) => u.email === email)) {
    send(res, 409, { ok: false, error: "Este e-mail já está cadastrado" }, {}, req);
    return;
  }

  const role = state.users.length === 0 ? "admin" : "member";
  const user = createUserRecord({ name, email, password, role });
  state.users.push(user);
  pruneExpiredSessions(state);
  const session = createSession(user.id);
  state.sessions.push(session);
  appendAuditLog(state, { actorUserId: user.id, action: "auth.register", resourceType: "user", resourceId: user.id });
  appendAuditLog(state, { actorUserId: user.id, action: "auth.login", resourceType: "session", resourceId: session.id });
  await writeState(state);

  send(res, 201, {
    ok: true,
    token: session.token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    csrfToken: createCsrfToken(user.id),
    expiresAt: session.expiresAt,
  }, {}, req);
}

async function handleAuthMe(req, res) {
  const { user } = await requireAuth(req);
  if (!user) {
    send(res, 401, { ok: false, error: "Não autenticado" }, {}, req);
    return;
  }
  send(res, 200, {
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    csrfToken: createCsrfToken(user.id),
  }, {}, req);
}

async function handleAuthLogout(req, res) {
  const { state, token, user } = await requireAuth(req);
  if (!token || !user) {
    send(res, 200, { ok: true }, {}, req);
    return;
  }
  state.sessions = state.sessions.filter((session) => session.token !== token);
  pruneExpiredSessions(state);
  appendAuditLog(state, { actorUserId: user.id, action: "auth.logout", resourceType: "session", resourceId: token });
  await writeState(state);
  send(res, 200, { ok: true }, {}, req);
}

function verifyPerfectPaySignature(secret, rawBody, signatureHeader) {
  if (!secret || !rawBody || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = String(signatureHeader).trim();
  if (!received) return false;
  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function handlePerfectPayWebhook(req, res) {
  const body = await parseBody(req);
  if (!body || typeof body !== "object") {
    send(res, 400, { ok: false, error: "Missing JSON payload" }, {}, req);
    return;
  }

  const state = await readState();
  const secret = state.integrations.perfectPay.webhookSecret;
  if (secret) {
    const signature = String(req.headers["x-perfectpay-signature"] || req.headers["perfectpay-signature"] || "").trim();
    if (!verifyPerfectPaySignature(secret, JSON.stringify(body), signature)) {
      appendAuditLog(state, {
        action: "webhook.invalid_signature",
        resourceType: "webhook_event",
        resourceId: makeId("we"),
        metadata: { reason: "signature_mismatch" },
      });
      await writeState(state);
      send(res, 401, { ok: false, error: "Invalid signature" }, {}, req);
      return;
    }
  }

  const transactionId = String(body.transaction_id || body.transactionId || body.id || "").trim();
  const eventType = safeEventType(body.event_type || body.eventType || body.event);
  const amountCents = Number(body.amount_cents ?? body.amountCents ?? 0);
  const currency = String(body.currency || "BRL").toUpperCase();
  const trackroiClickId = String(body.trackroi_click_id || body.click_id || "").trim() || null;

  if (!transactionId || !eventType) {
    send(res, 400, { ok: false, error: "transaction_id and event_type are required" }, {}, req);
    return;
  }

  const supportedEvents = new Set(["approved", "pending", "refunded", "chargeback", "cancelled", "rejected"]);
  if (!supportedEvents.has(eventType)) {
    send(res, 400, { ok: false, error: "Unsupported event_type", supported_events: Array.from(supportedEvents) }, {}, req);
    return;
  }

  const gateway = "perfectpay";
  const idempotencyKey = `${gateway}:${transactionId}:${eventType}`;
  const receivedAt = new Date().toISOString();
  const duplicate = state.webhookEvents.some((event) => event.idempotencyKey === idempotencyKey);
  if (duplicate) {
    send(res, 200, { ok: true, duplicate: true, idempotency_key: idempotencyKey }, {}, req);
    return;
  }

  const webhookEvent = {
    id: makeId("we"),
    gateway,
    transactionId,
    eventType,
    idempotencyKey,
    receivedAt,
    status: "received",
    rawPayload: body,
  };
  state.webhookEvents.push(webhookEvent);
  state.integrations.perfectPay.lastReceivedEventAt = receivedAt;

  let sale = state.sales.find((item) => item.gateway === gateway && item.gatewayTransactionId === transactionId);
  if (!sale) {
    sale = {
      id: makeId("sa"),
      gateway,
      gatewayTransactionId: transactionId,
      eventType,
      status: eventType,
      amountCents: Number.isFinite(amountCents) ? amountCents : 0,
      currency,
      trackroiClickId,
      source: trackroiClickId ? "direct" : "meta",
      createdAt: receivedAt,
      updatedAt: receivedAt,
    };
    state.sales.push(sale);
  } else {
    sale.status = eventType;
    sale.eventType = eventType;
    sale.amountCents = Number.isFinite(amountCents) ? amountCents : sale.amountCents;
    sale.currency = currency || sale.currency;
    sale.trackroiClickId = trackroiClickId || sale.trackroiClickId;
    sale.updatedAt = receivedAt;
  }

  appendAuditLog(state, {
    action: "webhook.received",
    resourceType: "webhook_event",
    resourceId: webhookEvent.id,
    metadata: { eventType, transactionId, duplicate: false },
  });

  if (eventType === "approved") {
    appendAuditLog(state, {
      action: "sale.approved",
      resourceType: "sale",
      resourceId: sale.id,
      metadata: { amountCents, currency },
    });
  }

  await writeState(state);
  send(res, 200, { ok: true, duplicate: false, idempotency_key: idempotencyKey, sale_status: eventType }, {}, req);
}

function paginate(items, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const total = items.length;
  const start = (page - 1) * limit;
  const pageItems = items.slice(start, start + limit);
  return {
    items: pageItems,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

function sanitizeIntegrations(integrations) {
  const meta = { ...(integrations.meta || {}) };
  delete meta.accessToken;
  const perfectPay = { ...(integrations.perfectPay || {}) };
  delete perfectPay.accessToken;
  delete perfectPay.webhookSecret;
  return { meta, perfectPay };
}

async function main() {
  await createEmptyState();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, "", {}, req);
        return;
      }

      const path = getPath(req.url);
      const query = getQuery(req.url);

      if (req.method === "GET" && path === "/health") {
        let storageOk = true;
        try {
          await readState();
        } catch {
          storageOk = false;
        }
        send(res, storageOk ? 200 : 503, {
          ok: storageOk,
          service: "trackroi-backend",
          port: PORT,
          uptime: Math.round(process.uptime()),
        }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/integrations/connect/meta") {
        await handleMetaConnectStart(req, res, query);
        return;
      }

      if (req.method === "GET" && path === "/api/integrations/connect/meta/callback") {
        await handleMetaConnectCallback(req, res, query);
        return;
      }

      if (req.method === "GET" && path === "/api/integrations/connect/perfectpay") {
        await handlePerfectPayConnectStart(req, res, query);
        return;
      }

      if (req.method === "POST" && path === "/api/integrations/connect/perfectpay") {
        await handlePerfectPayConnectSubmit(req, res, query);
        return;
      }

      if (req.method === "POST" && path === "/api/auth/login") {
        await handleAuthLogin(req, res);
        return;
      }

      if (req.method === "POST" && path === "/api/auth/register") {
        await handleAuthRegister(req, res);
        return;
      }

      if (req.method === "GET" && path === "/api/auth/status") {
        await handleAuthStatus(req, res);
        return;
      }

      if (req.method === "GET" && path === "/api/auth/me") {
        await handleAuthMe(req, res);
        return;
      }

      if (req.method === "POST" && path === "/api/auth/logout") {
        await handleAuthLogout(req, res);
        return;
      }

      if (req.method === "POST" && path === "/api/webhooks/perfectpay") {
        await handlePerfectPayWebhook(req, res);
        return;
      }

      const { state, user } = await requireAuth(req);
      if (!user) {
        send(res, 401, { ok: false, error: "Não autenticado" }, {}, req);
        return;
      }

      if (req.method !== "GET") {
        const csrfHeader = String(req.headers["x-csrf-token"] || "").trim();
        if (!verifyCsrfToken(csrfHeader, user.id)) {
          send(res, 403, { ok: false, error: "Invalid CSRF token" }, {}, req);
          return;
        }
      }

      if (req.method === "GET" && path === "/api/dashboard") {
        send(res, 200, buildDashboard(state, query), {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/metrics") {
        const dashboard = buildDashboard(state, query);
        send(res, 200, { ok: true, metrics: dashboard.summary, cards: dashboard.cards, funnel: dashboard.funnel }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/sales") {
        const paginated = paginate(state.sales.slice().reverse(), query);
        send(res, 200, { ok: true, ...paginated }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/clicks") {
        const paginated = paginate(state.clicks.slice().reverse(), query);
        send(res, 200, { ok: true, ...paginated }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/checkouts") {
        const paginated = paginate(state.checkouts.slice().reverse(), query);
        send(res, 200, { ok: true, ...paginated }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/products") {
        send(res, 200, { ok: true, items: state.products }, {}, req);
        return;
      }

      if (req.method === "POST" && path === "/api/products") {
        const body = await parseBody(req);
        const now = new Date().toISOString();
        const product = {
          id: makeId("pr"),
          name: String(body?.name || "").trim(),
          priceCents: Number(body?.priceCents || 0),
          createdAt: now,
        };
        if (!product.name) {
          send(res, 400, { ok: false, error: "name is required" }, {}, req);
          return;
        }
        state.products.push(product);
        appendAuditLog(state, { actorUserId: user.id, action: "product.create", resourceType: "product", resourceId: product.id });
        await writeState(state);
        send(res, 201, { ok: true, item: product }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/settings") {
        send(res, 200, { ok: true, settings: state.settings }, {}, req);
        return;
      }

      if (req.method === "PUT" && path === "/api/settings") {
        const body = await parseBody(req);
        state.settings = {
          ...state.settings,
          ...body,
          general: { ...state.settings.general, ...(body?.general || {}) },
          appearance: { ...state.settings.appearance, ...(body?.appearance || {}) },
          dashboard: { ...state.settings.dashboard, ...(body?.dashboard || {}) },
        };
        appendAuditLog(state, { actorUserId: user.id, action: "settings.update", resourceType: "settings", resourceId: "global" });
        await writeState(state);
        send(res, 200, { ok: true, settings: state.settings }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/integrations") {
        const integrations = sanitizeIntegrations(state.integrations);
        send(res, 200, { ok: true, items: integrations }, {}, req);
        return;
      }

      if (req.method === "PUT" && path === "/api/integrations/meta") {
        const body = await parseBody(req);
        const allowedFields = ["status", "adAccountId"];
        const sanitized = {};
        for (const field of allowedFields) {
          if (body?.[field] !== undefined) sanitized[field] = body[field];
        }
        state.integrations.meta = {
          ...state.integrations.meta,
          ...sanitized,
        };
        appendAuditLog(state, { actorUserId: user.id, action: "integration.meta.update", resourceType: "integration", resourceId: "meta" });
        await writeState(state);
        send(res, 200, { ok: true, item: sanitizeIntegrations(state.integrations).meta }, {}, req);
        return;
      }

      if (req.method === "PUT" && path === "/api/integrations/perfectpay") {
        const body = await parseBody(req);
        const allowedFields = ["status", "webhookUrl"];
        const sanitized = {};
        for (const field of allowedFields) {
          if (body?.[field] !== undefined) sanitized[field] = body[field];
        }
        state.integrations.perfectPay = {
          ...state.integrations.perfectPay,
          ...sanitized,
        };
        appendAuditLog(state, { actorUserId: user.id, action: "integration.perfectpay.update", resourceType: "integration", resourceId: "perfectpay" });
        await writeState(state);
        send(res, 200, { ok: true, item: sanitizeIntegrations(state.integrations).perfectPay }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/webhook-events") {
        const paginated = paginate(state.webhookEvents.slice().reverse(), query);
        send(res, 200, { ok: true, ...paginated }, {}, req);
        return;
      }

      if (req.method === "GET" && path === "/api/audit-logs") {
        const paginated = paginate(state.auditLogs.slice().reverse(), query);
        send(res, 200, { ok: true, ...paginated }, {}, req);
        return;
      }

      if (req.method === "POST" && path === "/api/dev/click") {
        const body = await parseBody(req);
        const now = new Date().toISOString();
        const click = {
          id: makeId("cl"),
          trackroiClickId: String(body?.trackroi_click_id || makeId("trk")),
          source: String(body?.source || "direct"),
          campaignId: body?.campaign_id || null,
          adsetId: body?.adset_id || null,
          adId: body?.ad_id || null,
          landingPage: body?.landing_page || "/",
          referrer: body?.referrer || null,
          fbclid: body?.fbclid || null,
          createdAt: now,
        };
        state.clicks.push(click);
        appendAuditLog(state, { actorUserId: user.id, action: "click.create", resourceType: "click", resourceId: click.id });
        await writeState(state);
        send(res, 201, { ok: true, item: click }, {}, req);
        return;
      }

      if (req.method === "POST" && path === "/api/dev/checkout") {
        const body = await parseBody(req);
        const now = new Date().toISOString();
        const checkout = {
          id: makeId("co"),
          trackroiClickId: String(body?.trackroi_click_id || ""),
          status: String(body?.status || "initiated"),
          createdAt: now,
        };
        state.checkouts.push(checkout);
        appendAuditLog(state, { actorUserId: user.id, action: "checkout.create", resourceType: "checkout", resourceId: checkout.id });
        await writeState(state);
        send(res, 201, { ok: true, item: checkout }, {}, req);
        return;
      }

      if (req.method === "POST" && path === "/api/dev/spend") {
        const body = await parseBody(req);
        const now = new Date().toISOString();
        const spend = {
          id: makeId("sp"),
          source: String(body?.source || "meta"),
          amountCents: Number(body?.amountCents || 0),
          currency: String(body?.currency || "BRL"),
          createdAt: now,
        };
        state.advertisingSpend.push(spend);
        appendAuditLog(state, { actorUserId: user.id, action: "spend.create", resourceType: "spend", resourceId: spend.id });
        await writeState(state);
        send(res, 201, { ok: true, item: spend }, {}, req);
        return;
      }

      send(res, 404, { ok: false, error: "Not found" }, {}, req);
    } catch (error) {
      logEvent("error", "Unhandled request error", { error: error.message });
      send(res, 500, { ok: false, error: error.message || "Internal server error" }, {}, req);
    }
  });

  const certFile = process.env.TLS_CERT || path.join(__dirname, "certs", "cert.pem");
  const keyFile = process.env.TLS_KEY || path.join(__dirname, "certs", "key.pem");
  const hasTls = process.env.ENABLE_TLS === "true" && fs.existsSync(certFile) && fs.existsSync(keyFile);
  const protocol = hasTls ? "https" : "http";

  const requestHandler = (req, res) => server.emit("request", req, res);
  const onListen = () => logEvent("info", "Backend listening", { protocol, port: PORT });
  const onError = (error) => {
    if (error.code === "EADDRINUSE") {
      logEvent("error", `A porta ${PORT} já está em uso`, {
        hint: "Feche o processo anterior ou mude a variável PORT no backend/.env",
      });
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
    logEvent("info", "Backend encerrado", { signal });
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
