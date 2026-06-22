import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

export function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

export function writeText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

export function serveStatic(req, res, rootDir) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const pathname = decodeURIComponent((requestPath || "/").split("?")[0]);
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const normalized = safePath.replace(/^[/\\]+/, "");

  const candidates = [path.join(rootDir, normalized)];
  if (!path.extname(normalized)) {
    candidates.push(path.join(rootDir, `${normalized}.html`));
  }

  let absolutePath = null;
  for (const candidate of candidates) {
    if (!candidate.startsWith(rootDir)) {
      continue;
    }
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      absolutePath = candidate;
      break;
    }

    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, "index.html");
      if (indexPath.startsWith(rootDir) && fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
        absolutePath = indexPath;
        break;
      }
    }
  }

  if (!absolutePath) {
    writeText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(absolutePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(absolutePath).pipe(res);
}
