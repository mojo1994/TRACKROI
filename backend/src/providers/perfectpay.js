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

  normalizeWebhookEvent(payload) {
    const transactionId = String(payload?.transaction_id || payload?.transactionId || payload?.id || "").trim();
    const eventType = String(payload?.event_type || payload?.eventType || payload?.event || "").trim().toLowerCase();
    return {
      transactionId,
      eventType,
      amountCents: Number(payload?.amount_cents ?? payload?.amountCents ?? 0),
      currency: String(payload?.currency || "BRL").toUpperCase(),
      trackroiClickId: String(payload?.trackroi_click_id || payload?.click_id || "").trim() || null,
    };
  },

  defaultStatus() {
    return "not_connected";
  },

  writableFields: ["status", "webhookUrl", "webhookStatus", "apiStatus"],
};

module.exports = provider;