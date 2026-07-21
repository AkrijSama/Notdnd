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
import {
  listQuarantined,
  resolveQuarantine,
  sweepQuarantine,
  isQuarantined,
  QUARANTINE_MAX_AGE_DAYS
} from "../../server/solo/fridgeTaster.js";

function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

// The QUARANTINE holding-pen queue: assets the fridge taster flagged, served to
// NOTHING, awaiting an owner call. Each card shows the taste reason + the failed
// canon checks and offers Fridge (keep) / Trash (destroy).
function quarantineCards() {
  const pen = listQuarantined().sort((a, b) => String(b?.quarantine?.at || "").localeCompare(String(a?.quarantine?.at || "")));
  if (!pen.length) {
    return `<p class="empty">Quarantine is empty — nothing is waiting for review.</p>`;
  }
  return pen
    .map((a) => {
      const png = fs.existsSync(path.join(libraryRoot(), `${a.id}.png`));
      const img = png
        ? `<img src="/img/${encodeURIComponent(a.id)}.png" loading="lazy" alt="${esc(a.id)}">`
        : `<div class="noimg">no PNG on disk</div>`;
      const q = a.quarantine || {};
      const failed = Array.isArray(q.checks) ? q.checks : [];
      const checkList = failed.length
        ? `<ul class="checks">${failed.map((c) => `<li>${esc(c.question)}${c.note ? ` — ${esc(c.note)}` : ""}</li>`).join("")}</ul>`
        : "";
      return `<figure class="card q" data-id="${esc(a.id)}">
        ${img}
        <figcaption>
          <div class="id">${esc(a.id)} <span class="r r-q">QUARANTINE</span></div>
          <div class="meta">${esc(a.kind)} · ${esc(a.style || "?")} · ${esc(a.world || "world-agnostic")}</div>
          <div class="reason">taste: ${esc(q.reason || "flagged")} <span class="model">(${esc(q.model || "mock")}, ${esc(q.at || "")})</span></div>
          ${checkList}
          <div class="btns">
            <button onclick="resolve('${esc(a.id)}','fridge')">Fridge (keep)</button>
            <button class="danger" onclick="resolve('${esc(a.id)}','trash')">Trash</button>
          </div>
        </figcaption>
      </figure>`;
    })
    .join("\n");
}

function html() {
  // The main keep/toss grid never shows quarantined assets — they live in the
  // holding-pen section above and are unservable until resolved.
  const assets = allAssets()
    .filter((a) => !isQuarantined(a))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const qCards = quarantineCards();
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
  .r-q{background:#5a4a12;color:#f0d98a}
  h2{font-size:14px;font-weight:600;margin:20px 0 8px}
  .quarantine .card.q{border-color:#5a4a12}
  .reason{color:#e0c46a;margin:4px 0;font-size:11px}
  .reason .model{color:#8a8a92}
  .checks{margin:4px 0 0;padding-left:16px;color:#c9a3a3;font-size:11px}
  .btns button.danger{border-color:#5a2020;background:#3a1c1c;color:#f0a0a0}
  .empty{color:#888}
  .sweep{margin-top:6px;color:#9a9aa2;font-size:12px}
  .sweep button{padding:4px 10px;border:1px solid #34343c;background:#232329;color:#eee;border-radius:6px;cursor:pointer}
</style>
<h1>Inkborne art review — ${assets.length} kept/unreviewed · Keep/Toss writes to the sidecar</h1>
<section class="quarantine">
  <h2>Quarantine (holding pen) — served to nothing · auto-trashed after ${QUARANTINE_MAX_AGE_DAYS} days</h2>
  <div class="sweep"><button onclick="sweep()">Run 30-day auto-trash sweep now</button></div>
  <div class="grid">${qCards}</div>
</section>
<h2>Library</h2>
<div class="grid">${cards || "<p class='empty'>Library is empty. Cook a batch first: node scripts/art/proof-batch.mjs</p>"}</div>
<script>
async function rate(id, rating){
  const r = await fetch('/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,rating})});
  if(r.ok){ location.reload(); } else { alert('rate failed: '+await r.text()); }
}
async function resolve(id, outcome){
  const r = await fetch('/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,outcome})});
  if(r.ok){ location.reload(); } else { alert('resolve failed: '+await r.text()); }
}
async function sweep(){
  const r = await fetch('/sweep',{method:'POST'});
  if(r.ok){ const j = await r.json(); alert('swept '+j.count+' aged quarantine entr'+(j.count===1?'y':'ies')); location.reload(); }
  else { alert('sweep failed: '+await r.text()); }
}
</script>`;
}

// Records a rating into the sidecar. "" clears the rating to null. Exported so a
// test can exercise the exact path the button hits.
export function recordRating(id, rating) {
  return rateAsset(id, rating === "" || rating == null ? null : rating);
}

// Resolves a quarantined asset to the fridge (keep) or the trash (destroy).
// Exported so a test can exercise the exact path the buttons hit.
export function recordResolve(id, outcome) {
  return resolveQuarantine(id, outcome);
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
      if (req.method === "POST" && req.url === "/resolve") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { id, outcome } = JSON.parse(body || "{}");
            const result = recordResolve(id, outcome);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (e) {
            res.writeHead(400);
            res.end(String(e.message || e));
          }
        });
        return;
      }
      if (req.method === "POST" && req.url === "/sweep") {
        const result = sweepQuarantine();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, ...result }));
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
  // LAW-6: drain the holding pen of anything older than the max age on startup, so
  // the quarantine never accumulates stale entries the owner forgot about.
  const swept = sweepQuarantine();
  if (swept.count) {
    console.log(`fridge taster: auto-trashed ${swept.count} quarantine entr${swept.count === 1 ? "y" : "ies"} older than ${QUARANTINE_MAX_AGE_DAYS}d`);
  }
  createReviewServer().listen(port, "127.0.0.1", () => {
    console.log(`art review at http://127.0.0.1:${port}  (library: ${libraryRoot()})`);
  });
}
