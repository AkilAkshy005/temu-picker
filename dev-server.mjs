// Run locally:  node dev-server.mjs   (reads keys from .dev.vars)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { onRequestPost } from "./functions/api/suggest.js";

try {
  for (const line of fs.readFileSync(".dev.vars", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const port = process.env.PORT || 8788;

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/suggest") {
      let body = "";
      for await (const c of req) body += c;
      const r = await onRequestPost({ request: new Request("http://x/api/suggest", { method: "POST", body }), env: process.env });
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(await r.text());
    }
    const pathname = req.url.split("?")[0];
    const file = path.join(".", pathname === "/" ? "index.html" : pathname);
    if (!types[path.extname(file)] || file.startsWith("functions") || file.startsWith(".") || !fs.existsSync(file)) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
