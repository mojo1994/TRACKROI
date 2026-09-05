const meta = require("./meta");
const perfectpay = require("./perfectpay");

const registry = new Map();

function register(provider) {
  registry.set(provider.id, provider);
}

function get(providerId) {
  return registry.get(String(providerId || "")) || null;
}

function list() {
  return Array.from(registry.values());
}

register(meta);
register(perfectpay);

module.exports = { register, get, list };