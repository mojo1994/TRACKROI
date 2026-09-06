const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const API_BASE = process.env.API_BASE || "";
const NOTIFICACAO_DIR = path.join(__dirname, "..", "notificacao");

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const server = http.createServer((req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath;
  if (requestPath.startsWith("/notificacao/")) {
    const name = safePath.split(/[\\/]/).pop();
    filePath = path.join(NOTIFICACAO_DIR, name);
  } else {
    filePath = path.join(ROOT, safePath);
  }
  if (!path.extname(filePath)) {
    const htmlCandidate = `${filePath}.html`;
    if (fs.existsSync(htmlCandidate)) filePath = htmlCandidate;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": requestPath.startsWith("/notificacao/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
    });

    if (filePath.endsWith(".html")) {
      const html = data.toString("utf8").replace("</head>", `<script>window.__API_BASE__=${JSON.stringify(API_BASE)};</script></head>`);
      res.end(html);
      return;
    }
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Frontend listening on http://localhost:${PORT}`);
});

function shutdown() {
  console.log("Frontend server encerrado");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
