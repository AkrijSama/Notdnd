// ─────────────────────────────────────────────────────────────────────────────
// BETA THUMB — owner-feedback calibration dataset for the auto art taster.
//
// WHY THIS EXISTS: the taster (auto art judge) has never been validated against
// the owner's taste. This module collects the owner's real up/down verdicts on
// generated images so the taster can later be SCORED against them ("on assets the
// owner judged, how often did the taster agree?"). THE DATA IS THE DELIVERABLE —
// the button is disposable, the verdicts are not.
//
// DEATH DATE (JOB 4): the whole surface is gated behind NOTDND_BETA_THUMB (default
// ON). REMOVAL CONDITION — turn this off only once BOTH are true: (1) the taster is
// validated against the collected dataset (scripts/art/taster-agreement.mjs) at a
// sample large enough to matter AND an agreement rate the owner accepts, and (2) the
// auto-sorter's quarantine is trusted to catch what the taster waves through. Killing
// the flag hides the UI; it NEVER deletes data/owner-verdicts.jsonl — the dataset
// outlives the control (JOB 4.2). See docs/design/beta-thumb.md.
//
// LIFECYCLE LAW (JOB 3): a thumbs-DOWN is a SIGNAL, never a destruction order. It sets
// an eviction flag that KEEPS the asset serving (rating stays "keep", NO taster
// `quarantine` marker — which would blank live art AND feed the 30-day auto-trash
// sweep). Destruction requires the owner's stamp in the sweep view. The 30-day fuse
// here escalates ("needs owner stamp, surfaced loudly"), it NEVER auto-trashes.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAsset, assetExists, destroyAsset, libraryRoot } from "../../scripts/art/library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// The append-only calibration dataset. One JSON object per line. Immutable history:
// a verdict is a record of a judgment on a specific image at a specific recipe
// version — it survives the asset being destroyed/redone and the button being removed.
export function verdictLogPath() {
  return process.env.NOTDND_OWNER_VERDICTS_PATH || path.join(REPO_ROOT, "data", "owner-verdicts.jsonl");
}

// Days a down-flag may sit before the sweep surfaces it LOUDLY. Never auto-trashes.
export const OWNER_DOWN_ESCALATE_DAYS = Math.max(
  1,
  Number(process.env.NOTDND_OWNER_DOWN_ESCALATE_DAYS) || 30
);

export const REASON_CHIPS = Object.freeze(["wrong subject", "bad crop", "wrong camera", "wrong style", "just ugly"]);

// JOB 4.1 — the single kill switch. Default ON.
export function betaThumbEnabled() {
  const v = String(process.env.NOTDND_BETA_THUMB ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

// ── URI ⇆ asset resolution ───────────────────────────────────────────────────
// The client holds a URI everywhere (only the entity sheet has a true asset id), so
// URI is the universal key. Map it to a file path (traversal-guarded, must live under
// data/assets) and, when it is a library asset, its id.
function normUri(uri) {
  return String(uri || "").split("?")[0].split("#")[0].trim();
}
export function pngPathForUri(uri) {
  const u = normUri(uri);
  if (!u.startsWith("/data/assets/")) return null;
  const abs = path.resolve(REPO_ROOT, "." + decodeURIComponent(u));
  const base = path.join(REPO_ROOT, "data", "assets");
  if (!abs.startsWith(base + path.sep)) return null; // traversal guard
  return abs;
}
// A stable id for the verdict record + the sidecar flag. Library assets → their id
// (sidecar-backed, evictable); run-local cooks → the URI itself (dataset-only, no
// fridge lifecycle — there is no sidecar to flag).
export function assetKeyForUri(uri) {
  const u = normUri(uri);
  const m = /^\/data\/assets\/library\/(.+)\.png$/.exec(u);
  if (m) return { assetId: decodeURIComponent(m[1]), library: true };
  return { assetId: u, library: false };
}

// ── PNG tEXt cook receipt ────────────────────────────────────────────────────
// A cooked ComfyUI PNG embeds the executed graph in a `prompt` tEXt chunk. That graph
// is the exact recipe: checkpoint (CheckpointLoaderSimple.ckpt_name), size
// (EmptyLatentImage w/h), and steps/cfg/sampler/seed (KSampler). This recovers the
// checkpoint + cook params for ANY generated asset — past or future — with no change
// to the cook pipeline. Best-effort: returns {} when the PNG carries no receipt.
function readPngTextChunks(absPath) {
  const out = {};
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return out; }
  if (buf.length < 8) return out;
  let i = 8; // skip PNG signature
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const dataStart = i + 8;
    if (type === "IDAT" || type === "IEND") break;
    if (type === "tEXt") {
      const chunk = buf.slice(dataStart, dataStart + len);
      const nul = chunk.indexOf(0);
      if (nul > 0) out[chunk.toString("latin1", 0, nul)] = chunk.toString("latin1", nul + 1);
    }
    i = dataStart + len + 4; // +4 CRC
    if (len < 0 || i <= dataStart) break;
  }
  return out;
}
export function parseCookReceipt(absPath) {
  const chunks = readPngTextChunks(absPath);
  const receipt = { checkpoint: null, width: null, height: null, steps: null, cfg: null, sampler: null, scheduler: null, seed: null, positive: null, negative: null };
  if (!chunks.prompt) return receipt;
  let graph;
  try { graph = JSON.parse(chunks.prompt); } catch { return receipt; }
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object") continue;
    const ct = node.class_type, inp = node.inputs || {};
    if (ct === "CheckpointLoaderSimple" && inp.ckpt_name) receipt.checkpoint = inp.ckpt_name;
    if (ct === "EmptyLatentImage") { receipt.width = inp.width ?? receipt.width; receipt.height = inp.height ?? receipt.height; }
    if (ct === "KSampler" || ct === "KSamplerAdvanced") {
      receipt.steps = inp.steps ?? receipt.steps;
      receipt.cfg = inp.cfg ?? receipt.cfg;
      receipt.sampler = inp.sampler_name ?? receipt.sampler;
      receipt.scheduler = inp.scheduler ?? receipt.scheduler;
      if (typeof inp.seed === "number") receipt.seed = inp.seed;
      if (typeof inp.noise_seed === "number") receipt.seed = inp.noise_seed;
    }
  }
  return receipt;
}

// ── taster verdict lookup (the OTHER half of the agreement pair) ──────────────
// The taster's recorded verdicts live in data/assets/quarantine-verdicts.json (the
// last taster batch). Returns the row for an id, or null when the taster never judged
// it. Storing this ALONGSIDE the owner verdict is what makes the agreement rate
// computable — the entire point (JOB 2).
export function tasterVerdictFor(assetId) {
  try {
    const p = path.join(libraryRoot(), "..", "quarantine-verdicts.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = Array.isArray(doc.rows) ? doc.rows : (Array.isArray(doc) ? doc : []);
    const row = rows.find((r) => r && r.id === assetId);
    if (!row) return null;
    return { verdict: row.verdict ?? null, recommend: row.recommend ?? null, reason: row.reason ?? null, observedSubject: row.observedSubject ?? null, model: doc.model ?? null };
  } catch { return null; }
}

// ── recipe version (non-negotiable — a down goes stale the instant a recipe changes
//    unless we know which recipe judged the picture) ──────────────────────────────
function recipeVersionFor(sidecar, receipt) {
  const m = (sidecar && sidecar.meta) || {};
  const parts = [];
  if (m.templateVersion != null) parts.push("tmpl" + m.templateVersion);
  if (m.blockVersions && m.blockVersions.blockVersion != null) parts.push("blk" + m.blockVersions.blockVersion);
  if (sidecar && sidecar.workflow) parts.push(sidecar.workflow);
  if (parts.length) return parts.join("/");
  // Run-local cook (no sidecar): the checkpoint + sampler config IS the recipe identity.
  if (receipt && receipt.checkpoint) return "cook:" + receipt.checkpoint + (receipt.sampler ? "/" + receipt.sampler : "");
  return null;
}

// ── the full verdict record (JOB 2) ──────────────────────────────────────────
export function buildVerdictRecord({ uri, kind, world, verdict, reasons, at }) {
  const { assetId, library } = assetKeyForUri(uri);
  const png = pngPathForUri(uri);
  const sidecar = library && assetExists(assetId) ? getAsset(assetId) : null;
  const receipt = png ? parseCookReceipt(png) : {};
  const taster = tasterVerdictFor(assetId);
  return {
    at: at || null, // stamped by the caller (Date.now unavailable in some contexts)
    assetId,
    uri: normUri(uri),
    library,
    kind: kind || (sidecar && sidecar.kind) || null,
    world: world || (sidecar && sidecar.world) || null,
    verdict, // "up" | "down"
    reasons: Array.isArray(reasons) ? reasons.filter((r) => REASON_CHIPS.includes(r)) : [],
    recipeVersion: recipeVersionFor(sidecar, receipt), // NON-NEGOTIABLE
    checkpoint: receipt.checkpoint || null,
    cook: { width: receipt.width, height: receipt.height, steps: receipt.steps, cfg: receipt.cfg, sampler: receipt.sampler, scheduler: receipt.scheduler, seed: receipt.seed },
    prompt: (sidecar && sidecar.promptUsed) || receipt.positive || null,
    style: (sidecar && sidecar.style) || null,
    tasterVerdict: taster ? (taster.recommend || taster.verdict) : null, // NON-NEGOTIABLE (null = never tasted)
    tasterReason: taster ? taster.reason : null
  };
}

// Append to the immutable dataset. Never rewrites — a verdict is history.
export function appendVerdict(record) {
  const p = verdictLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(record) + "\n");
  return record;
}

// ── the sidecar eviction flag (library assets only) ──────────────────────────
// Keeps rating="keep" (KEEPS SERVING — JOB 3.2). No taster `quarantine` marker, so
// queryAssets does not drop it and the 30-day auto-trash sweep never touches it.
function writeSidecar(assetId, mutate) {
  if (!assetExists(assetId)) return null;
  const s = getAsset(assetId);
  mutate(s);
  fs.writeFileSync(path.join(libraryRoot(), assetId + ".json"), JSON.stringify(s, null, 2) + "\n");
  return s;
}
export function setOwnerDown(assetId, reasons, at) {
  return writeSidecar(assetId, (s) => { s.ownerFeedback = { verdict: "down", reasons: Array.isArray(reasons) ? reasons : [], at: at || null }; });
}
export function setOwnerUp(assetId, at) {
  // Up is not an eviction signal; record it on the sidecar for the toggle state, clear any down.
  return writeSidecar(assetId, (s) => { s.ownerFeedback = { verdict: "up", reasons: [], at: at || null }; });
}
export function clearOwnerFeedback(assetId) {
  return writeSidecar(assetId, (s) => { delete s.ownerFeedback; });
}
export function currentOwnerFeedback(assetId) {
  if (!assetExists(assetId)) return null;
  const s = getAsset(assetId);
  return s.ownerFeedback || null;
}

// The current toggle state for a served URI ("up"|"down"|null) — so the thumb renders
// correctly after every scene re-render (library assets only carry a persisted flag).
export function ownerStateForUri(uri) {
  const { assetId, library } = assetKeyForUri(uri);
  if (!library) return null;
  const fb = currentOwnerFeedback(assetId);
  return fb && fb.verdict ? fb.verdict : null;
}

// Batch: { uri: "up"|"down" } for a list of URIs (skips neutral). Feeds scene.artFeedback.
export function ownerFeedbackMap(uris = []) {
  const out = {};
  for (const uri of uris) {
    if (!uri) continue;
    const st = ownerStateForUri(uri);
    if (st) out[normUri(uri)] = st;
  }
  return out;
}

// ── the sweep (JOB 3.4) + escalation (JOB 3.3) ───────────────────────────────
export function listOwnerDown({ now = null } = {}) {
  const root = libraryRoot();
  let files = [];
  try { files = fs.readdirSync(root).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")); } catch { continue; }
    if (!s.ownerFeedback || s.ownerFeedback.verdict !== "down") continue;
    const at = Number(s.ownerFeedback.at) || null;
    const ageDays = (now && at) ? (now - at) / 86400000 : null;
    out.push({
      assetId: s.id,
      uri: "/data/assets/library/" + encodeURIComponent(s.id) + ".png",
      kind: s.kind || null,
      world: s.world || null,
      reasons: s.ownerFeedback.reasons || [],
      at,
      serving: s.rating === "keep" && !s.quarantine, // proof it KEPT serving (JOB 3.2)
      overdue: ageDays != null && ageDays >= OWNER_DOWN_ESCALATE_DAYS, // LOUD, never auto-trash (JOB 3.3)
      taster: tasterVerdictFor(s.id)
    });
  }
  return out;
}

// Owner-stamped resolution from the sweep. "fridge" clears the flag (keeps serving);
// "trash" is the ONLY path to destruction, and it is the owner's explicit stamp.
export function stampOwnerDown(assetId, outcome) {
  if (!assetExists(assetId)) return { ok: false, reason: "asset not found (already destroyed/redone — its verdict remains in the dataset)" };
  if (outcome === "fridge") { clearOwnerFeedback(assetId); return { ok: true, outcome: "fridge", serving: true }; }
  if (outcome === "trash") { destroyAsset(assetId); return { ok: true, outcome: "trash", destroyed: true }; }
  return { ok: false, reason: "outcome must be 'fridge' or 'trash'" };
}
