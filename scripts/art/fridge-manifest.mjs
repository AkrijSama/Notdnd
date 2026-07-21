#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FRIDGE MANIFEST (R1) — a READ-ONLY audit of the curated art library.
//
// Enumerates every sidecar in data/assets/library and prints, per asset: its id,
// kind, world, style lane, recipe epoch (the live ART_RECIPE_VERSION for draft-
// cooked ids, else the prompt-contract meta version the sidecar records),
// provenance (workflow + any recorded checkpoint), rating, and WHY it is kept
// (its intake reason / binding tags). Anything that looks stale or unattributable
// is called out in a SUSPECTS section with the reason.
//
// This is a REPORT TOOL. It never writes, tags, rates, or destroys an asset — it
// only reads sidecars via scripts/art/library.mjs (allAssets) and the current
// recipe epoch from server/solo/artStyle.js. Run:
//     node scripts/art/fridge-manifest.mjs
// (respects NOTDND_ASSET_LIBRARY_ROOT, like the rest of the library tooling).
// ---------------------------------------------------------------------------

import { allAssets, libraryRoot } from "./library.mjs";
import { ART_RECIPE_VERSION } from "../../server/solo/artStyle.js";

// The current live-recipe epoch as the id-embedded slug (imageWorker.recipeVersionSlug).
const CURRENT_EPOCH = String(ART_RECIPE_VERSION);
const CURRENT_EPOCH_SLUG = CURRENT_EPOCH.replace(/[^a-z0-9]/gi, "").toLowerCase();

const DRAFT_EPOCH_RE = /^draft_([a-z0-9]+)_/i;

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// The recipe epoch a sidecar records. Live drafts embed the recipe slug in the id
// (draft_<slug>_<hash>); batch-cooked assets record the prompt-contract template +
// block versions in `meta`. Returns { label, slug|null, kind }.
function recipeEpoch(asset) {
  const m = DRAFT_EPOCH_RE.exec(String(asset.id || ""));
  if (m) {
    return { label: `rv:${m[1]}`, slug: m[1].toLowerCase(), kind: "draft" };
  }
  if (isPlainObject(asset.meta)) {
    const tv = asset.meta.templateVersion;
    const bv = isPlainObject(asset.meta.blockVersions) ? asset.meta.blockVersions.blockVersion : undefined;
    if (tv !== undefined || bv !== undefined) {
      const parts = [];
      if (tv !== undefined) parts.push(`tmpl-v${tv}`);
      if (bv !== undefined) parts.push(`blk-v${bv}`);
      return { label: parts.join("/"), slug: null, kind: "contract" };
    }
  }
  return { label: "—", slug: null, kind: "none" };
}

// The provenance string: the validated workflow export, plus any recorded checkpoint.
function provenance(asset) {
  const wf = typeof asset.workflow === "string" && asset.workflow ? asset.workflow : "(none)";
  const ckpt = isPlainObject(asset.meta) && typeof asset.meta.checkpoint === "string" ? asset.meta.checkpoint : null;
  return ckpt ? `${wf} · ${ckpt}` : wf;
}

// The serve-attribution provider, if the sidecar records one (a tag `provider:<x>`
// or meta.provider). The intake guard refuses non-comfyui, so anything else here is
// a leak past the guard. null = not recorded (assume the validated comfyui path).
function providerOf(asset) {
  const tags = Array.isArray(asset.tags) ? asset.tags : [];
  const tag = tags.map(String).find((t) => t.startsWith("provider:"));
  if (tag) return tag.slice("provider:".length).toLowerCase();
  if (isPlainObject(asset.meta) && typeof asset.meta.provider === "string") return asset.meta.provider.toLowerCase();
  return null;
}

// A compact "why kept" from rating + the binding/intake tags that explain the keep.
const WHY_TAGS = ["auto-keep", "authored", "tailor", "live", "pool"];
function whyKept(asset) {
  const rating = asset.rating === "keep" ? "KEEP" : asset.rating === "toss" ? "TOSS" : "unrated";
  const tags = (Array.isArray(asset.tags) ? asset.tags : []).map(String);
  const reasons = [];
  const binding = tags.find((t) => /^(role|loc|subject):/.test(t));
  if (binding) reasons.push(binding);
  for (const t of WHY_TAGS) if (tags.includes(t)) reasons.push(t);
  if (asset.origin && asset.origin !== "generated") reasons.push(`origin:${asset.origin}`);
  if (asset.checkout) reasons.push("checked-out");
  return `${rating}${reasons.length ? " · " + reasons.join(",") : ""}`;
}

// The suspect reasons for one asset (empty array = clean). A suspect is anything a
// fridge-clean library would not contain: stale/destroyable debris, unattributable
// provenance, or an off-epoch recipe.
function suspectReasons(asset) {
  const reasons = [];
  if (asset.rating === "toss") {
    reasons.push("TOSS-rated but still on disk (lifecycle law: toss = DESTROY; this is debris)");
  }
  if (asset.quarantine) {
    const why = isPlainObject(asset.quarantine) && asset.quarantine.reason ? ` (${asset.quarantine.reason})` : "";
    reasons.push(`QUARANTINED holding-pen — served to nothing${why}`);
  }
  const prov = providerOf(asset);
  if (prov && prov !== "comfyui") {
    reasons.push(`non-comfyui provider "${prov}" — leaked past the validated-recipe intake guard`);
  }
  if ((!asset.workflow || !String(asset.workflow).trim()) && asset.origin === "generated") {
    reasons.push("no workflow provenance (opaque recipe — cannot attribute to a validated export)");
  }
  const epoch = recipeEpoch(asset);
  if (epoch.kind === "draft" && epoch.slug !== CURRENT_EPOCH_SLUG) {
    reasons.push(`pre-current-recipe-epoch (${epoch.label} != rv:${CURRENT_EPOCH_SLUG})`);
  }
  if (epoch.kind === "none" && asset.origin === "generated") {
    reasons.push("no recipe meta (pre prompt-contract — epoch unverifiable)");
  }
  return reasons;
}

// ── fixed-width table helpers ────────────────────────────────────────────────
function pad(s, w) {
  s = String(s == null ? "" : s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}
function truncMid(s, w) {
  s = String(s == null ? "" : s);
  if (s.length <= w) return s;
  const head = Math.ceil((w - 1) / 2);
  const tail = Math.floor((w - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function main() {
  const assets = allAssets().slice().sort((a, b) => {
    return String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id));
  });

  const cols = [
    { key: "id", head: "ID", w: 40, mid: true },
    { key: "kind", head: "KIND", w: 10 },
    { key: "world", head: "WORLD", w: 8 },
    { key: "style", head: "STYLE", w: 12 },
    { key: "epoch", head: "EPOCH", w: 14 },
    { key: "prov", head: "PROVENANCE (workflow · checkpoint)", w: 34, mid: true },
    { key: "why", head: "WHY KEPT (rating · intake tags)", w: 46, full: true }
  ];

  const rows = assets.map((a) => ({
    _asset: a,
    id: a.id,
    kind: a.kind,
    world: a.world || "—",
    style: a.style || "—",
    epoch: recipeEpoch(a).label,
    prov: provenance(a),
    why: whyKept(a),
    _suspect: suspectReasons(a)
  }));

  const out = [];
  const line = (n = 128) => "-".repeat(n);

  out.push("FRIDGE MANIFEST — curated art library audit (read-only)");
  out.push(`generated:            ${new Date().toISOString()}`);
  out.push(`library root:         ${libraryRoot()}`);
  out.push(`current recipe epoch: ${CURRENT_EPOCH}  (live-draft id slug: ${CURRENT_EPOCH_SLUG})`);
  out.push(`assets on disk:       ${assets.length}`);

  // breakdowns
  const tally = (f) => {
    const m = {};
    for (const a of assets) { const k = f(a); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort().map(([k, v]) => `${k}=${v}`).join("  ");
  };
  out.push(`by kind:              ${tally((a) => a.kind)}`);
  out.push(`by rating:            ${tally((a) => a.rating == null ? "unrated" : a.rating)}`);
  out.push(`by world:             ${tally((a) => a.world || "—")}`);
  out.push(`by style lane:        ${tally((a) => a.style || "—")}`);

  const suspects = rows.filter((r) => r._suspect.length);
  out.push(`SUSPECTS:             ${suspects.length} of ${assets.length} flagged (see SUSPECTS section below)`);
  out.push("");

  // ── main table ──
  out.push("== MANIFEST ==");
  out.push(cols.map((c) => pad(c.head, c.w)).join(" | "));
  out.push(cols.map((c) => line(c.w)).join("-+-"));
  for (const r of rows) {
    const flag = r._suspect.length ? " ⚑" : "";
    out.push(cols.map((c) => {
      const v = r[c.key];
      if (c.full) return String(v == null ? "" : v); // last column: print in full, never truncate
      const val = c.mid ? truncMid(v, c.w) : v;
      return pad(val, c.w);
    }).join(" | ") + flag);
  }
  out.push("");

  // ── suspects section ──
  out.push("== SUSPECTS (pre-current-epoch / debris / unattributable / non-comfyui) ==");
  if (!suspects.length) {
    out.push("(none — every asset is current-epoch, comfyui-attributed, and non-debris)");
  } else {
    // group by primary reason class for a quick read
    const classOf = (reasons) =>
      reasons.some((x) => x.startsWith("TOSS-rated")) ? "toss-debris"
      : reasons.some((x) => x.startsWith("QUARANTINED")) ? "quarantined"
      : reasons.some((x) => x.startsWith("non-comfyui")) ? "non-comfyui"
      : reasons.some((x) => x.startsWith("pre-current-recipe-epoch")) ? "stale-epoch"
      : reasons.some((x) => x.startsWith("no recipe meta")) ? "no-recipe-meta"
      : reasons.some((x) => x.startsWith("no workflow")) ? "no-workflow"
      : "other";
    const byClass = {};
    for (const r of suspects) {
      const cl = classOf(r._suspect);
      (byClass[cl] = byClass[cl] || []).push(r);
    }
    out.push("summary by class:");
    for (const [cl, rs] of Object.entries(byClass).sort()) {
      out.push(`  ${pad(cl, 16)} ${rs.length}`);
    }
    out.push("");
    for (const r of suspects) {
      out.push(`⚑ ${r.id}  [${r.kind}/${r.style || "—"}/${r.world || "—"}]  rating=${r._asset.rating ?? "unrated"}`);
      for (const reason of r._suspect) out.push(`    - ${reason}`);
    }
  }
  out.push("");
  out.push(`END — ${assets.length} assets, ${suspects.length} suspects. This tool made NO changes to the library.`);

  process.stdout.write(out.join("\n") + "\n");
}

main();
