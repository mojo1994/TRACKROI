const crypto = require("crypto");

function newRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

function write(level, message, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  if (level === "error" || level === "warn") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

const logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
  debug: (message, fields) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", message, fields);
  },
};

module.exports = { logger, newRequestId };