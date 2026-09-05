const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
let writeQueue = Promise.resolve();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "";

function encryptSecret(value) {
  if (!value) return value;
  if (!ENCRYPTION_KEY) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "base64"), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  if (!value || typeof value !== "string") return value;
  if (!value.startsWith("enc:v1:")) return value;
  const [, , ivB64, tagB64, dataB64] = value.split(":");
  if (!ENCRYPTION_KEY) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "base64"), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, record.salt), "hex"),
    Buffer.from(record.hash, "hex"),
  );
}

function createDefaultUser() {
  const email = String(process.env.ADMIN_EMAIL || "admin@trackroi.local").toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "TrackROI!2026");
  const record = createPasswordRecord(password);
  return {
    id: "user_admin",
    name: "Administrador",
    email,
    role: "admin",
    password: record,
    createdAt: new Date().toISOString(),
  };
}

function createUserRecord({ name, email, password, role = "admin" }) {
  return {
    id: `user_${crypto.randomUUID()}`,
    name: String(name || "").trim(),
    email: String(email || "").trim().toLowerCase(),
    role,
    password: createPasswordRecord(password),
    createdAt: new Date().toISOString(),
  };
}

function createEmptyState() {
  return {
    users: [],
    sessions: [],
    clicks: [],
    checkouts: [],
    sales: [],
    webhookEvents: [],
    advertisingSpend: [],
    auditLogs: [],
    products: [],
    settings: {
      general: {
        companyName: "TrackROI",
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        locale: "pt-BR",
      },
      appearance: {
        theme: "dark-hybrid",
      },
      dashboard: {
        layout: ["spend", "revenue", "profit", "roas", "roi", "cpa"],
      },
    },
    integrations: {
      meta: {
        status: "not_connected",
        connectedAccount: null,
        lastSyncAt: null,
        tokenStatus: "missing",
        accessToken: null,
        errors: [],
      },
      perfectPay: {
        status: "not_connected",
        webhookStatus: "not_configured",
        apiStatus: "not_configured",
        lastReceivedEventAt: null,
        failedEvents: 0,
        retryStatus: "idle",
        webhookUrl: "http://localhost:4000/api/webhooks/perfectpay",
        accessToken: null,
      },
    },
  };
}

function normalizeState(input) {
  const defaults = createEmptyState();
  const state = input && typeof input === "object" ? input : {};
  return {
    ...defaults,
    ...state,
    users: Array.isArray(state.users) && state.users.length ? state.users : defaults.users,
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    clicks: Array.isArray(state.clicks) ? state.clicks : [],
    checkouts: Array.isArray(state.checkouts) ? state.checkouts : [],
    sales: Array.isArray(state.sales) ? state.sales : [],
    webhookEvents: Array.isArray(state.webhookEvents) ? state.webhookEvents : [],
    advertisingSpend: Array.isArray(state.advertisingSpend) ? state.advertisingSpend : [],
    auditLogs: Array.isArray(state.auditLogs) ? state.auditLogs : [],
    products: Array.isArray(state.products) ? state.products : [],
    settings: {
      ...defaults.settings,
      ...(state.settings || {}),
      general: { ...defaults.settings.general, ...((state.settings || {}).general || {}) },
      appearance: { ...defaults.settings.appearance, ...((state.settings || {}).appearance || {}) },
      dashboard: { ...defaults.settings.dashboard, ...((state.settings || {}).dashboard || {}) },
    },
    integrations: {
      ...defaults.integrations,
      ...(state.integrations || {}),
      meta: { ...defaults.integrations.meta, ...((state.integrations || {}).meta || {}) },
      perfectPay: { ...defaults.integrations.perfectPay, ...((state.integrations || {}).perfectPay || {}) },
    },
  };
}

async function ensureStateFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(createEmptyState(), null, 2), "utf8");
  }
}

async function readState() {
  await ensureStateFile();
  const raw = await fs.readFile(STATE_FILE, "utf8");
  return normalizeState(JSON.parse(raw));
}

async function writeState(state) {
  const payload = JSON.stringify(normalizeState(state), null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await ensureStateFile();
    const tempFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFile, payload, "utf8");
    try {
      await fs.rename(tempFile, STATE_FILE);
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EEXIST")) {
        await fs.writeFile(STATE_FILE, payload, "utf8");
        await fs.unlink(tempFile).catch(() => {});
        return;
      }
      await fs.unlink(tempFile).catch(() => {});
      throw error;
    }
  });
  return writeQueue;
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  return {
    id: `session_${crypto.randomUUID()}`,
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  };
}

function pruneExpiredSessions(state) {
  const now = Date.now();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  return before - state.sessions.length;
}

function getUserByToken(state, token) {
  const session = state.sessions.find((item) => item.token === token);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return state.users.find((user) => user.id === session.userId) || null;
}

function appendAuditLog(state, entry) {
  state.auditLogs.push({
    id: `audit_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

module.exports = {
  createEmptyState,
  ensureStateFile,
  readState,
  writeState,
  createSession,
  pruneExpiredSessions,
  getUserByToken,
  createPasswordRecord,
  createUserRecord,
  verifyPassword,
  appendAuditLog,
  normalizeState,
  encryptSecret,
  decryptSecret,
};
