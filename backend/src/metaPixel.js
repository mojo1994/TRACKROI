const crypto = require("crypto");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const CLIENT_USER_AGENT =
  process.env.META_CAPI_USER_AGENT ||
  "Mozilla/5.0 (compatible; TrackROI/1.0; +https://trackroi-production.up.railway.app)";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

async function graphRequest(path, { method = "GET", body = null, timeoutMs = 8000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${GRAPH_BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      clearTimeout(timer);
      if (response.ok) return { ok: true, status: response.status, body: payload };
      return { ok: false, status: response.status, body: payload };
    } catch (error) {
      lastError = error;
      clearTimeout(timer);
      if (error && error.name !== "AbortError") return undefined;
    }
  }
  clearTimeout(0);
  throw new Error(lastError?.message || "Falha de conexão com a Meta. Tente novamente.");
}

function parseMetaError(payload) {
  const error = payload?.error || {};
  const code = Number(error.code);
  const message = String(error.message || "");
  if (code === 190 || /token.*(invalid|expired)|invalid.*token|expired.*token/.test(message.toLowerCase())) {
    return new Error("Token inválido ou expirado para este Pixel.");
  }
  if (code === 803 || /not exist|could not be loaded|aliases|not found/.test(message.toLowerCase())) {
    return new Error("Pixel ID não encontrado ou o token não tem acesso a esse Pixel.");
  }
  if (code === 100 || /missing permissions?|permission/i.test(message.toLowerCase())) {
    const error100 = new Error("Token sem permissão de leitura para este Pixel.");
    error100.metaCode = 100;
    return error100;
  }
  return new Error(message || "A Meta rejeitou a solicitação.");
}

async function validateCredentials({ pixelId, accessToken }) {
  const id = String(pixelId || "").trim();
  const token = String(accessToken || "").trim();
  if (!id) throw new Error("ID do Pixel é obrigatório.");
  if (!token) throw new Error("Token de acesso é obrigatório.");
  const result = await graphRequest(`/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}&fields=name`);
  if (result && result.ok) {
    return { pixelId: id, name: String(result.body?.name || ""), validatedVia: "read" };
  }
  if (!result) {
    throw new Error("Não foi possível validar o Pixel agora. Verifique sua conexão e tente novamente.");
  }
  const readError = parseMetaError(result.body);
  if (readError.metaCode !== 100) throw readError;
  const testEventCode = `trackroi_connect_validate_${Date.now()}`;
  try {
    const sent = await sendTestEvent({ pixelId: id, accessToken: token, testEventCode });
    return {
      pixelId: id,
      name: null,
      validatedVia: "test_event",
      testEventCode,
      eventsReceived: sent.eventsReceived,
    };
  } catch (eventError) {
    if (eventError.metaCode === 100) {
      throw new Error("O token não tem permissão para este Pixel (nem para envio de eventos). Gere um novo token em Gerenciador de Eventos → API de Conversões.");
    }
    throw eventError;
  }
}

function buildFbc(fbclid, createdAt) {
  if (!fbclid) return null;
  const seconds = Math.floor(new Date(createdAt || Date.now()).getTime() / 1000);
  return `fb.1.${seconds}.${String(fbclid).trim()}`;
}

function buildPurchaseEvent({ eventId, valueCents, currency = "BRL", quantity = 1, contentName, email, fbc, clientIpAddress, eventSourceUrl }) {
  const userData = {
    client_ip_address: clientIpAddress || "127.0.0.1",
    client_user_agent: CLIENT_USER_AGENT,
  };
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) userData.em = [sha256(normalizedEmail)];
  if (fbc) userData.fbc = fbc;
  const event = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    event_id: eventId,
    user_data: userData,
    custom_data: {
      currency,
      value: Math.round((Number(valueCents) || 0) / 100 * 100) / 100,
      quantity: Math.max(1, Number(quantity) || 1),
    },
  };
  if (contentName) event.custom_data.content_name = String(contentName);
  if (eventSourceUrl) event.event_source_url = String(eventSourceUrl);
  return event;
}

async function sendConversionEvent({ pixelId, accessToken, event, testEventCode }) {
  const body = { data: [event] };
  const code = String(testEventCode || "").trim();
  if (code) body.test_event_code = code;
  const result = await graphRequest(`/${encodeURIComponent(pixelId)}/events`, { method: "POST", body });
  if (!result) {
    throw new Error("Não foi possível enviar o evento para a Meta agora. Verifique sua conexão e tente novamente.");
  }
  if (!result.ok) throw parseMetaError(result.body);
  return {
    ok: true,
    eventsReceived: Number(result.body?.events_received ?? 0),
    message: String(result.body?.message || "Evento recebido."),
  };
}

async function sendTestEvent({ pixelId, accessToken, testEventCode }) {
  const code = String(testEventCode || "").trim() || `trackroi_test_event_${Date.now()}`;
  const event = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    event_id: `trackroi-test-${Date.now()}`,
    user_data: {
      client_ip_address: "127.0.0.1",
      client_user_agent: CLIENT_USER_AGENT,
    },
  };
  return sendConversionEvent({ pixelId, accessToken, event, testEventCode: code });
}

async function sendPurchaseForSale({ pixelId, accessToken, event, valueCents, currency, quantity, contentName, email, fbclid, clickCreatedAt, eventSourceUrl, clientIpAddress }) {
  const fbc = buildFbc(fbclid, clickCreatedAt);
  const purchase = buildPurchaseEvent({
    eventId: event,
    valueCents,
    currency,
    quantity,
    contentName,
    email,
    fbc,
    clientIpAddress,
    eventSourceUrl,
  });
  return sendConversionEvent({ pixelId, accessToken, event: purchase });
}

module.exports = {
  validateCredentials,
  sendTestEvent,
  sendPurchaseForSale,
  parseMetaError,
  GRAPH_VERSION,
};