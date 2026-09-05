const crypto = require("crypto");

const ENCRYPTION_PREFIX = "enc:v1:";
const PBKDF2_ITERATIONS = 120000;

let prodDetected = null;

function isProduction() {
  if (prodDetected === null) {
    prodDetected =
      process.env.NODE_ENV === "production" ||
      Object.keys(process.env).some((key) => key.startsWith("RAILWAY_"));
  }
  return prodDetected;
}

function encryptionKeyBuffer() {
  const raw = String(process.env.ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  return Buffer.from(raw, "base64");
}

function assertEncryptionKey() {
  if (isProduction() && !process.env.ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY é obrigatória em produção. Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" e defina a variável no Railway."
    );
  }
}

function encryptSecret(value) {
  if (value == null || value === "") return value;
  const key = encryptionKeyBuffer();
  if (!key) return String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  if (!value || typeof value !== "string") return value;
  if (!value.startsWith(ENCRYPTION_PREFIX)) return value;
  const key = encryptionKeyBuffer();
  if (!key) return null;
  const pieces = value.slice(ENCRYPTION_PREFIX.length).split(":");
  if (pieces.length !== 3) return null;
  const [ivB64, tagB64, dataB64] = pieces;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, 64, "sha512").toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const expected = Buffer.from(record.hash, "hex");
  const candidate = Buffer.from(hashPassword(password, record.salt), "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

module.exports = {
  isProduction,
  assertEncryptionKey,
  encryptSecret,
  decryptSecret,
  createPasswordRecord,
  verifyPassword,
};