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
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
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

/**
 * Reads the full request body as a Buffer, rejecting once it exceeds maxBytes.
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, maxBytes = 0) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (maxBytes && total > maxBytes) {
      const error = new Error("Payload too large.");
      error.code = "PAYLOAD_TOO_LARGE";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Minimal multipart/form-data parser. Returns the first file part
 * ({ filename, contentType, data }) or null. Sufficient for single-file uploads.
 * @param {Buffer} buffer
 * @param {string} contentTypeHeader
 * @returns {{ filename: string, contentType: string, data: Buffer } | null}
 */
export function parseMultipartFile(buffer, contentTypeHeader) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentTypeHeader || ""));
  if (!match || !Buffer.isBuffer(buffer)) {
    return null;
  }
  const boundary = (match[1] || match[2] || "").trim();
  if (!boundary) {
    return null;
  }

  const delim = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");
  let cursor = buffer.indexOf(delim);
  if (cursor === -1) {
    return null;
  }
  cursor += delim.length;

  while (cursor < buffer.length) {
    // Closing boundary "--boundary--".
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) {
      break;
    }
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) {
      cursor += 2;
    }

    const next = buffer.indexOf(delim, cursor);
    if (next === -1) {
      break;
    }
    let partEnd = next;
    if (buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }

    const part = buffer.subarray(cursor, partEnd);
    const sep = part.indexOf(headerSep);
    if (sep !== -1) {
      const headers = part.subarray(0, sep).toString("utf8");
      const data = part.subarray(sep + headerSep.length);
      const disposition = /content-disposition:[^\r\n]*filename="?([^"\r\n]*)"?/i.exec(headers);
      if (disposition) {
        const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
        return {
          filename: disposition[1] || "",
          contentType: ct ? ct[1].trim() : "",
          data: Buffer.from(data)
        };
      }
    }

    cursor = next + delim.length;
  }

  return null;
}

/**
 * Detects a supported raster image type by magic bytes. Returns the canonical
 * extension ("png" | "jpg" | "webp") or null when unsupported.
 * @param {Buffer} buffer
 * @returns {"png" | "jpg" | "webp" | null}
 */
export function detectImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  // RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "webp";
  }
  return null;
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

  // JOB 2 (content-hashed asset URLs): a /data/assets image requested WITH a ?v= content
  // hash is immutable — a changed asset gets a new hash → a new URL, so caching it forever
  // is anti-fossil safe (the old URL is never requested again). Everything else — plain
  // (unversioned) asset paths from old saves, HTML/JS, any dynamic file — keeps no-store,
  // so a re-cook under an unversioned URL (or a purge) can never be served stale. This
  // REPLACES the blanket no-store with something STRONGER, never weaker: only a
  // content-addressed URL is cacheable, and its content can't change under it by definition.
  const hasVersion = /[?&]v=/.test(req.url || "");
  const isVersionedAsset =
    hasVersion && pathname.startsWith("/data/assets/") && /\.(png|jpe?g|webp|gif)$/i.test(ext);
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": isVersionedAsset ? "public, max-age=31536000, immutable" : "no-store"
  });
  fs.createReadStream(absolutePath).pipe(res);
}
