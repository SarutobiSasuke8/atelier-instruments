// Static server for the instrument workshop. No dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const host = process.env.HOST || "127.0.0.1";
const dsp = process.env.ATELIER_DSP_ROOT ? fs.realpathSync(process.env.ATELIER_DSP_ROOT) : null;
if (dsp && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("The private DSP mount requires a loopback listener.");
}
const port = Number(process.env.PORT || 8080);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mid": "audio/midi",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname); }
  catch { res.writeHead(400).end("Invalid URL"); return; }
  if (pathname.startsWith("/__atelier-dsp/")) {
    const entry = pathname.match(/^\/__atelier-dsp\/(src\/(?:dsp|pedalboard)\/[a-z-]+\.js)$/);
    if (!dsp || !entry || !["GET", "HEAD"].includes(req.method) || !/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(req.headers.host ?? "")) {
      res.writeHead(404).end("Private DSP is unavailable"); return;
    }
    const base = path.join(dsp, "src");
    let filename;
    try { filename = fs.realpathSync.native(path.join(dsp, entry[1])); } catch { /* Optional branch may be missing. */ }
    if (!filename || !filename.startsWith(base + path.sep)) { res.writeHead(404).end("Not found"); return; }
    fs.readFile(filename, (error, data) => {
      if (error) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": types[".js"], "Cache-Control":"no-store" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`atelier-instruments listening on http://${host}:${server.address().port}`);
});
