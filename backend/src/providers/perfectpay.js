const crypto = require("crypto");

function verifyHmac(rawBody, signatureHeader, secret) {
  if (!secret || !rawBody || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = String(signatureHeader).trim();
  if (!received) return false;
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const STATUS_ENUM_MAP = {
  0: "none",
  1: "pending",
  2: "approved",
  3: "in_process",
  4: "in_mediation",
  5: "rejected",
  6: "cancelled",
  7: "refunded",
  8: "authorized",
  9: "chargeback",
  10: "completed",
  11: "checkout_error",
  12: "precheckout",
  13: "expired",
  16: "in_review",
};

const CHECKOUT_EVENTS = new Set(["initiated", "precheckout", "checkout_error", "expired"]);

function paymentMethodLabel(payload) {
  if (!payload) return null;
  const method = Number(payload.payment_method_enum);
  const type = Number(payload.payment_type_enum);
  const raw = String(payload.payment_method || "").toLowerCase();
  if (raw.includes("pix") || method === 17 || method === 8) return "PIX";
  if (type === 2 || raw.includes("boleto")) return "boleto";
  if (type === 1 || type === 4 || type === 6 || [1, 3, 4, 5, 6, 7, 10, 13, 14, 16].includes(method)) {
    return "cartão de crédito";
  }
  if (type === 3 || method === 11 || raw.includes("paypal")) return "paypal";
  return null;
}

const provider = {
  id: "perfectpay",
  displayName: "Perfect Pay",
  description: "Receba suas vendas aprovadas automaticamente.",
  requiredEnv: [],

  isConfigured() {
    return true;
  },

  health() {
    return {
      ok: true,
      configured: true,
      message: "Pronto para conectar.",
      missingEnv: [],
    };
  },

  getAuthUrl(state) {
    return `/api/integrations/connect/perfectpay?token=${encodeURIComponent(state)}`;
  },

  async handleAuth({ email, password }) {
    if (!email || !password) {
      throw new Error("Preencha e-mail e senha para continuar.");
    }
    const response = await fetch("https://app.perfectpay.com.br/api/auth/login", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error || "Falha ao autenticar na Perfect Pay.");
      error.retryable = true;
      error.providerHint = "bad_credentials";
      throw error;
    }
    const accessToken = String(payload.access_token || payload.token || "").trim();
    if (!accessToken) {
      throw new Error("A Perfect Pay não retornou um token de acesso.");
    }
    return { accessToken, connectedAccount: email };
  },

  verifyWebhookSignature(rawBody, headers, secret) {
    const signatureHeader = String(
      headers["x-perfectpay-signature"] || headers["perfectpay-signature"] || ""
    ).trim();
    return verifyHmac(rawBody, signatureHeader, secret);
  },

  verifyWebhookToken(payload, expectedToken) {
    if (!expectedToken) return false;
    const received = String(payload?.token || "").trim();
    if (!received) return false;
    return received === String(expectedToken).trim();
  },

  isCheckoutEvent(eventType) {
    return CHECKOUT_EVENTS.has(String(eventType || "").toLowerCase());
  },

  normalizeWebhookEvent(payload) {
    const hasNativeFormat =
      payload && (payload.sale_status_enum !== undefined || payload.code !== undefined || payload.webhook_owner !== undefined);
    if (hasNativeFormat) {
      const enumValue = Number(payload.sale_status_enum);
      let eventType = STATUS_ENUM_MAP[enumValue] || "none";
      const detail = String(payload.sale_status_detail || "").toLowerCase();
      if (enumValue === 0 && /checkout|saved|created|initiated/.test(detail)) {
        eventType = "initiated";
      }
      const metadata = payload.metadata || {};
      return {
        transactionId: String(payload.code || "").trim(),
        eventType,
        isCheckout: CHECKOUT_EVENTS.has(eventType),
        amountCents: Math.round(Number(payload.sale_amount || 0) * 100),
        currency: "BRL",
        quantity: Number(payload.quantity || 1),
        trackroiClickId: String(metadata.src || metadata.trackroi_click_id || metadata.click_id || "").trim() || null,
        webhookOwner: String(payload.webhook_owner || "").trim() || null,
        customer: payload.customer || null,
        product: payload.product || null,
        plan: payload.plan || null,
        dateCreated: payload.date_created || null,
        dateApproved: payload.date_approved || null,
        paymentMethod: paymentMethodLabel(payload),
      };
    }
    const transactionId = String(payload?.transaction_id || payload?.transactionId || payload?.id || "").trim();
    const eventType = String(payload?.event_type || payload?.eventType || payload?.event || "").trim().toLowerCase();
    return {
      transactionId,
      eventType,
      isCheckout: CHECKOUT_EVENTS.has(eventType),
      amountCents: Number(payload?.amount_cents ?? payload?.amountCents ?? 0),
      currency: String(payload?.currency || "BRL").toUpperCase(),
      trackroiClickId: String(payload?.trackroi_click_id || payload?.click_id || "").trim() || null,
    };
  },

  defaultStatus() {
    return "not_connected";
  },

  writableFields: ["status", "webhookUrl", "webhookStatus", "apiStatus", "webhookToken"],
};

module.exports = provider;