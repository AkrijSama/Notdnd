// ---------------------------------------------------------------------------
// REVIEW TOOL (art-week phase 1, PART 4 acceptance) — a dead-simple local page
// for the owner's keep/toss pass. Serves every library image with Keep / Toss
// buttons; a click records the rating straight into the sidecar (library.rateAsset).
// Zero build, zero deps, local-only.
//
//   node scripts/art/review.mjs           # http://127.0.0.1:8791
//
// Toss-rated images stay on disk (curation is reversible) but are excluded from
// engine queries (queryAssets). Nothing here touches the GPU.
// ---------------------------------------------------------------------------

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { allAssets, getAsset, rateAsset, libraryRoot } from "./library.mjs";

function html() {
  const assets = allAssets().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cards = assets
    .map((a) => {
      const png = fs.existsSync(path.join(libraryRoot(), `${a.id}.png`));
      const rated = a.rating ? `<span class="r r-${a.rating}">${a.rating.toUpperCase()}</span>` : "";
      const img = png
        ? `<img src="/img/${encodeURIComponent(a.id)}.png" loading="lazy" alt="${a.id}">`
        : `<div class="noimg">no PNG on disk</div>`;
      return `<figure class="card" data-id="${a.id}">
        ${img}
        <figcaption>
          <div class="id">${a.id} ${rated}</div>
          <div class="meta">${a.kind} · ${a.style || "?"} · ${a.world || "world-agnostic"}${a.checkout ? " · CHECKED-OUT" : ""}</div>
          <div class="tags">${(a.tags || []).map((t) => `<span>${t}</span>`).join("")}</div>
          <div class="btns">
            <button onclick="rate('${a.id}','keep')">Keep</button>
            <button onclick="rate('${a.id}','toss')">Toss</button>
            <button onclick="rate('${a.id}','')">Clear</button>
          </div>
        </figcaption>
      </figure>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Inkborne art review (${assets.length})</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:16px}
  h1{font-size:16px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
  .card{background:#1b1b1e;border:1px solid #2a2a30;border-radius:10px;margin:0;overflow:hidden}
  .card img{width:100%;display:block;background:#000}
  .noimg{padding:40px;text-align:center;color:#888}
  figcaption{padding:10px 12px;font-size:12px}
  .id{font-weight:700;word-break:break-all}
  .meta{color:#9a9aa2;margin:4px 0}
  .tags span{display:inline-block;background:#26262c;border-radius:4px;padding:1px 6px;margin:2px 3px 0 0;font-size:10px;color:#bbb}
  .btns{margin-top:8px;display:flex;gap:8px}
  .btns button{flex:1;padding:6px;border:1px solid #34343c;background:#232329;color:#eee;border-radius:6px;cursor:pointer}
  .r{font-size:10px;padding:1px 6px;border-radius:4px}
  .r-keep{background:#1f5130;color:#9fe6b4}.r-toss{background:#5a2020;color:#f0a0a0}
</style>
<h1>Inkborne art review — ${assets.length} images · Keep/Toss writes to the sidecar</h1>
<div class="grid">${cards || "<p>Library is empty. Cook a batch first: node scripts/art/proof-batch.mjs</p>"}</div>
<script>
async function rate(id, rating){
  const r = await fetch('/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,rating})});
  if(r.ok){ location.reload(); } else { alert('rate failed: '+await r.text()); }
}
</script>`;
}

// Records a rating into the sidecar. "" clears the rating to null. Exported so a
// test can exercise the exact path the button hits.
export function recordRating(id, rating) {
  return rateAsset(id, rating === "" || rating == null ? null : rating);
}

export function createReviewServer() {
  return http.createServer((req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html());
      }
      if (req.method === "GET" && req.url.startsWith("/img/")) {
        const id = decodeURIComponent(req.url.slice("/img/".length).replace(/\.png$/, ""));
        // Guard against traversal: id must resolve inside the library root.
        const file = path.join(libraryRoot(), `${id}.png`);
        if (!path.resolve(file).startsWith(path.resolve(libraryRoot())) || !fs.existsSync(file)) {
          res.writeHead(404);
          return res.end("not found");
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "POST" && req.url === "/rate") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { id, rating } = JSON.parse(body || "{}");
            if (!getAsset(id)) {
              res.writeHead(404);
              return res.end(`no asset ${id}`);
            }
            recordRating(id, rating);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, id, rating: rating || null }));
          } catch (e) {
            res.writeHead(400);
            res.end(String(e.message || e));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message || e));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.REVIEW_PORT || 8791);
  createReviewServer().listen(port, "127.0.0.1", () => {
    console.log(`art review at http://127.0.0.1:${port}  (library: ${libraryRoot()})`);
  });
}
