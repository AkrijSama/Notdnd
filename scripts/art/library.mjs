// ---------------------------------------------------------------------------
// ASSET LIBRARY (art-week phase 1) — economy-law Law 5.
//
// One JSON sidecar per image: <id>.png + <id>.json. The sidecar is the law; the
// PNG is runtime data (data/assets/ is gitignored). This module owns the sidecar
// schema and the add/query/tag/checkout/rate operations. Pure filesystem, no GPU,
// no network — the generator (generate.mjs) calls addAsset after a cook; the
// review tool (review.mjs) calls rateAsset; the engine (phase 2) will query.
//
// FACE-CHECKOUT RULE (Law 5): a face image (kind portrait | fullbody) may hold
// AT MOST ONE checkout {runId, npcId}; scenery (every other kind) never checks
// out. TOSS-rated images are excluded from query results.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

// Library root — env-overridable so tests run against a temp dir. data/assets is
// gitignored, so library/<id>.{png,json} never enters version control.
export function libraryRoot() {
  return (
    process.env.NOTDND_ASSET_LIBRARY_ROOT ||
    path.resolve(process.cwd(), "data/assets/library")
  );
}

export const ASSET_ORIGINS = Object.freeze(["authored", "generated", "player-commissioned"]);
// The four generation lanes ("waiters") + world-card. portrait = faces (VN/status
// framing); fullbody = tall standing VN sprites; scene = locations/environments;
// item = objects on a clean background; world-card = the wide world-select cover.
// (Replaced the old npc-body/npc-portrait/decor vocab — see art-pipeline-v2.md.)
export const ASSET_KINDS = Object.freeze(["world-card", "scene", "portrait", "fullbody", "item"]);
export const ASSET_RATINGS = Object.freeze(["keep", "toss", null]);
// The kinds that carry a FACE and may be checked out to exactly one NPC — now
// BOTH portrait (the bust) AND fullbody (the sprite share one identity).
export const FACE_KINDS = Object.freeze(["portrait", "fullbody"]);

function ensureRoot() {
  const root = libraryRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sidecarPath(id) {
  return path.join(libraryRoot(), `${String(id)}.json`);
}

function isString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// The canonical sidecar shape (Law 5 fields, verbatim). Every field is present so
// the schema is stable from day one — creator/origin are load-bearing for the
// future multiplayer economy even while empty/default now.
export function buildSidecar(input = {}) {
  const id = isString(input.id) ? input.id : null;
  if (!id) {
    throw new Error("library: an asset id is required");
  }
  const origin = ASSET_ORIGINS.includes(input.origin) ? input.origin : "generated";
  const kind = ASSET_KINDS.includes(input.kind) ? input.kind : "scene";
  return {
    id,
    createdAt: isString(input.createdAt) ? input.createdAt : new Date().toISOString(),
    origin, // "authored" | "generated" | "player-commissioned" (default "generated")
    creator: input.creator ?? null, // load-bearing for multiplayer economy; null now
    world: isString(input.world) ? input.world : null, // null = world-agnostic
    style: isString(input.style) ? input.style : "",
    kind, // world-card | scene | portrait | fullbody | item
    tags: Array.isArray(input.tags) ? input.tags.filter(isString) : [],
    checkout: input.checkout && typeof input.checkout === "object" ? input.checkout : null,
    rating: ASSET_RATINGS.includes(input.rating) ? input.rating : null,
    // TAILOR seam (art-pipeline-v2): the identity reference this asset was
    // generated FROM — e.g. a fullbody sprite records the portrait assetId whose
    // face it must match (IP-Adapter identity-reference). null = self-originated.
    identityRef: isString(input.identityRef) ? input.identityRef : null,
    workflow: isString(input.workflow) ? input.workflow : "",
    promptUsed: isString(input.promptUsed) ? input.promptUsed : "",
    // PROMPT-CONTRACT audit (art-pipeline-v2): the template + block versions and
    // the slot values this image was assembled from, so a bad image points at a
    // specific slot/template, not an opaque freehand sentence. null for assets
    // predating the contract (or added without an assembly meta).
    meta: input.meta && typeof input.meta === "object" ? input.meta : null,
    // FRIDGE TASTER quarantine marker (server/solo/fridgeTaster.js). A NON-null
    // object = this asset is in the HOLDING PEN: it failed the pre-keep taste check
    // and is served to NOTHING (queryAssets drops it) until owner review resolves it
    // to the fridge (keep) or the trash (destroy). Orthogonal to `rating` — a
    // quarantined asset also carries rating != "keep". null = not quarantined.
    quarantine: input.quarantine && typeof input.quarantine === "object" ? input.quarantine : null
  };
}

// Add (or overwrite) an asset's sidecar. Idempotent by id — re-adding the same id
// rewrites the sidecar, which is how a resumed batch stays clean. Returns the
// written sidecar object.
export function addAsset(input) {
  ensureRoot();
  const sidecar = buildSidecar(input);
  fs.writeFileSync(sidecarPath(sidecar.id), `${JSON.stringify(sidecar, null, 2)}\n`);
  return sidecar;
}

export function assetExists(id) {
  return fs.existsSync(sidecarPath(id));
}

export function getAsset(id) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(id), "utf8"));
  } catch {
    return null;
  }
}

function writeAsset(sidecar) {
  fs.writeFileSync(sidecarPath(sidecar.id), `${JSON.stringify(sidecar, null, 2)}\n`);
  return sidecar;
}

// All sidecars on disk (unfiltered).
export function allAssets() {
  const root = libraryRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Query the library. TOSS-rated images are ALWAYS excluded (Law 5 curation).
// Filters: { kind, world, style, origin, tag, available } — `available:true`
// returns only face-kinds with no checkout (the face-pool for a new NPC).
export function queryAssets(filter = {}) {
  return allAssets().filter((a) => {
    if (a.rating === "toss") return false; // tossed images never surface
    // QUARANTINE (fridge taster): a suspect asset in the holding pen is served to
    // NOTHING — dropped from every engine query regardless of rating, so it can
    // never leak onto a serve path while it awaits owner review.
    if (a.quarantine && typeof a.quarantine === "object") return false;
    if (isString(filter.kind) && a.kind !== filter.kind) return false;
    if (isString(filter.world) && a.world !== filter.world) return false;
    if (isString(filter.style) && a.style !== filter.style) return false;
    if (isString(filter.origin) && a.origin !== filter.origin) return false;
    if (isString(filter.tag) && !(Array.isArray(a.tags) && a.tags.includes(filter.tag))) return false;
    if (filter.available === true && (a.checkout !== null || !FACE_KINDS.includes(a.kind))) return false;
    return true;
  });
}

// Merge new tags onto an asset (deduped). Returns the updated sidecar.
export function tagAsset(id, tags = []) {
  const sidecar = getAsset(id);
  if (!sidecar) {
    throw new Error(`library: no asset ${id}`);
  }
  const add = (Array.isArray(tags) ? tags : [tags]).filter(isString);
  sidecar.tags = [...new Set([...(sidecar.tags || []), ...add])];
  return writeAsset(sidecar);
}

// Check a FACE out to an NPC. Enforces Law 5:
//  - only portrait / fullbody may check out (scenery never does);
//  - an image holds AT MOST ONE checkout — re-checkout while held throws.
// Returns the updated sidecar.
export function checkoutFace(id, { runId, npcId } = {}) {
  const sidecar = getAsset(id);
  if (!sidecar) {
    throw new Error(`library: no asset ${id}`);
  }
  if (!FACE_KINDS.includes(sidecar.kind)) {
    throw new Error(`library: ${sidecar.kind} images never check out (scenery is shared freely)`);
  }
  if (sidecar.checkout !== null) {
    throw new Error(`library: ${id} is already checked out to ${JSON.stringify(sidecar.checkout)} (one checkout per face)`);
  }
  if (!isString(runId) || !isString(npcId)) {
    throw new Error("library: checkout requires { runId, npcId }");
  }
  sidecar.checkout = { runId, npcId };
  return writeAsset(sidecar);
}

// Release a face back to the pool (an NPC despawns / a run ends).
export function releaseFace(id) {
  const sidecar = getAsset(id);
  if (!sidecar) {
    throw new Error(`library: no asset ${id}`);
  }
  sidecar.checkout = null;
  return writeAsset(sidecar);
}

// Owner curation: keep | toss | null.
// ASSET LIFECYCLE LAW (owner 2026-07-20): two fates only — library-KEPT or DESTROYED.
// Rating an asset "toss" is a DESTROY, not a retained flag: the image (png) + its sidecar
// record are deleted on the spot. There is no third "tossed-but-kept" state on disk.
export function destroyAsset(id) {
  const png = path.join(libraryRoot(), `${String(id)}.png`);
  let removed = false;
  try { if (fs.existsSync(png)) { fs.rmSync(png, { force: true }); removed = true; } } catch { /* best-effort */ }
  try { if (fs.existsSync(sidecarPath(id))) { fs.rmSync(sidecarPath(id), { force: true }); removed = true; } } catch { /* best-effort */ }
  return removed;
}

export function rateAsset(id, rating) {
  if (!ASSET_RATINGS.includes(rating)) {
    throw new Error(`library: rating must be one of ${ASSET_RATINGS.map(String).join(", ")}`);
  }
  const sidecar = getAsset(id);
  if (!sidecar) {
    throw new Error(`library: no asset ${id}`);
  }
  // TOSS = DESTROY: the file + record are deleted, never retained with a flag.
  if (rating === "toss") {
    destroyAsset(id);
    return { id, destroyed: true };
  }
  sidecar.rating = rating;
  return writeAsset(sidecar);
}

// TAILOR seam (art-pipeline-v2): record that `childId` was generated from the
// identity of `refId` (e.g. a fullbody sprite ← the portrait whose face it must
// match). Pure data — it stores the link; the consistency engine (IP-Adapter
// wake-up, gated on the owner's tuned per-lane workflows) reads it later. Both
// assets must exist. Returns the updated child sidecar.
export function linkIdentity(childId, refId) {
  const child = getAsset(childId);
  if (!child) {
    throw new Error(`library: no asset ${childId}`);
  }
  if (!isString(refId)) {
    throw new Error("library: linkIdentity requires a reference assetId");
  }
  if (!assetExists(refId)) {
    throw new Error(`library: identity reference ${refId} does not exist`);
  }
  child.identityRef = refId;
  return writeAsset(child);
}
