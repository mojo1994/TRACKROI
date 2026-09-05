const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const BACKEND_PORT = 4100;
const FRONTEND_PORT = 5180;

const backend = spawn("node", ["server.js"], {
  cwd: path.join(__dirname, "backend"),
  env: {
    ...process.env,
    PORT: String(BACKEND_PORT),
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || `http://localhost:${PORT}`,
  },
  stdio: "inherit",
});

const frontend = spawn("node", ["server.js"], {
  cwd: path.join(__dirname, "frontend"),
  env: { ...process.env, PORT: String(FRONTEND_PORT), API_BASE: "" },
  stdio: "inherit",
});

backend.on("exit", (code) => {
  console.error(`Backend encerrado com código ${code}`);
  process.exit(1);
});

frontend.on("exit", (code) => {
  console.error(`Frontend encerrado com código ${code}`);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  const target = req.url.startsWith("/api/") || req.url.startsWith("/health")
    ? `http://localhost:${BACKEND_PORT}`
    : `http://localhost:${FRONTEND_PORT}`;
  const proxyReq = http.request(target + req.url, { method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (error) => {
    console.error("Proxy error:", error.message);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Erro ao conectar ao serviço interno");
  });
  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`TrackROI rodando em http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`Encerrando (${signal})...`);
  backend.kill("SIGTERM");
  frontend.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
