import fs from "node:fs";
import path from "node:path";
import { generateImage, providerSupportsReference, resolveImageProvider } from "../ai/providers.js";
import { detectImageExt } from "../api/http.js";
import {
  ensureLocationImageAsset,
  ensureNpcImageAssets,
  getSoloRun,
  updateImageAssetStatus,
  updatePlayerPortrait
} from "../db/repository.js";
import { NPC_EXPRESSIONS } from "./schema.js";

// ---------------------------------------------------------------------------
// Async NPC portrait worker.
//
// Generate-once-cache-forever. Never invoked inline from a request path: the
// scene route enqueues jobs and returns immediately. On first NPC encounter a
// job generates only the base portrait; expression variants are generated
// lazily, one at a time, when a talk beat needs them (runVariantImageJob). Each
// slot's bytes are written to disk and its asset status flipped via a narrow
// repository write (never saveSoloRun).
//
// All image generation goes through the provider abstraction
// (server/ai/providers.js → generateImage). No provider endpoints are hardcoded
// here. When no image-provider key is configured — or NOTDND_MOCK_IMAGE=true —
// generateImage returns a tiny placeholder PNG so the pipeline is exercisable
// offline and in tests without network or cost.
// ---------------------------------------------------------------------------

const queue = [];
let processing = false;

// Shared art-direction suffix appended to EVERY character portrait prompt
// (player + NPC) so the whole cast reads as one coherent art set rather than a
// grab-bag of styles.
const PORTRAIT_ART_DIRECTION =
  "fantasy portrait, painterly illustration, dramatic rim lighting, detailed face, upper body, plain dark background";

// Player / character-creation portraits use a full-body composite suited to a
// 5e character-sheet square. Kept SEPARATE from the shared NPC art direction
// above on purpose: NPC portraits render as small thumbnails / VN busts where a
// shrunk full-body reference sheet would make the face unreadable.
const PLAYER_PORTRAIT_ART_DIRECTION =
  "character reference sheet, full-body three-quarter side pose, face close-up inset top-right, " +
  "painterly fantasy illustration, dramatic rim lighting, highly detailed, plain dark background";

// Resolved at call time (not module load) so tests can redirect the root.
function assetsRoot() {
  return process.env.NOTDND_ASSETS_ROOT
    ? path.resolve(process.env.NOTDND_ASSETS_ROOT)
    : path.resolve(process.cwd(), "data/assets");
}

function diskPathFor(runId, npcId, slot, ext = "png") {
  return path.join(assetsRoot(), String(runId), String(npcId), `${slot}.${ext}`);
}

// Public URI served by the existing static handler (serveStatic, repo root).
function servedUriFor(runId, npcId, slot, ext = "png") {
  return `/data/assets/${encodeURIComponent(runId)}/${encodeURIComponent(npcId)}/${slot}.${ext}`;
}

/**
 * Writes a user-uploaded base portrait (arbitrary extension) to the same
 * on-disk asset layout the worker uses, and returns its served URI. Variant
 * generation then anchors on this file via IP-Adapter.
 * @param {string} runId
 * @param {string} npcId
 * @param {string} ext canonical extension without dot (png|jpg|webp)
 * @param {Buffer} bytes
 * @returns {{ fileName: string, uri: string }}
 */
export function writeUploadedBasePortrait(runId, npcId, ext, bytes) {
  const fileName = `base.${ext}`;
  const target = path.join(assetsRoot(), String(runId), String(npcId), fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return {
    fileName,
    uri: `/data/assets/${encodeURIComponent(runId)}/${encodeURIComponent(npcId)}/${fileName}`
  };
}

function logWorker(message, error) {
  // eslint-disable-next-line no-console
  console.error(`[imageWorker] ${message}${error ? `: ${String(error?.message || error)}` : ""}`);
}

// Reference images are served via relative URIs; a remote provider needs an
// absolute URL to fetch them. NOTDND_PUBLIC_ASSET_BASE supplies the public
// origin when one is configured. In mock/offline mode the value is unused.
function referenceUrlFor(servedUri) {
  if (!servedUri) {
    return null;
  }
  const base = String(process.env.NOTDND_PUBLIC_ASSET_BASE || "").trim().replace(/\/+$/, "");
  return base ? `${base}${servedUri}` : servedUri;
}

// Per-type image dimensions: portrait (512x768) for player + NPC faces,
// landscape (768x512) for location establishing shots ("wide establishing
// shot" prompts need a landscape aspect, not a portrait one).
const PORTRAIT_DIMENSIONS = { width: 512, height: 768 };
const LANDSCAPE_DIMENSIONS = { width: 768, height: 512 };
// Square for the character-sheet composite (player + draft portraits only).
const PLAYER_PORTRAIT_DIMENSIONS = { width: 1024, height: 1024 };

// ---------------------------------------------------------------------------
// Player / draft (character-creation) portrait helpers.
// ---------------------------------------------------------------------------
function isStr(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hashOf(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Normalizes a character object (client sends characterClass; the run stores
// class) into the fields the prompt + seed need.
function normalizePortraitCharacter(character = {}) {
  return {
    name: isStr(character.name) ? character.name.trim() : null,
    race: isStr(character.race) ? character.race.trim() : null,
    characterClass: isStr(character.class)
      ? character.class.trim()
      : isStr(character.characterClass)
        ? character.characterClass.trim()
        : null,
    background: isStr(character.background) ? character.background.trim() : null,
    pronouns: isStr(character.pronouns) ? character.pronouns.trim() : null
  };
}

// Shared prompt for the player + draft full-body character-sheet portrait.
function buildPlayerPortraitPrompt(character = {}, world = {}) {
  const c = normalizePortraitCharacter(character);
  const tone = isStr(world.tone) ? world.tone.trim() : "dark fantasy";
  const subject =
    [
      c.name ? `${c.name},` : null,
      c.pronouns ? `${c.pronouns},` : null,
      c.race,
      c.characterClass,
      c.background ? `${c.background} background` : null
    ]
      .filter(Boolean)
      .join(" ") || "wanderer";
  return `character portrait of ${subject}, ${tone}, ${PLAYER_PORTRAIT_ART_DIRECTION}`;
}

// Deterministic seed from name+race+class so identical core choices reproduce
// the same image (per spec). Independent of the draft-namespace id below.
function playerPortraitSeed(character = {}) {
  const c = normalizePortraitCharacter(character);
  return hashOf(`${c.name || ""}|${c.race || ""}|${c.characterClass || ""}`);
}

// Draft asset namespace id: hashed over EVERY prompt-affecting field so any
// change (race/class/background/pronouns/name) yields a fresh namespace and a
// regeneration, while identical choices reuse the cached asset.
export function computeDraftPortraitId(character = {}) {
  const c = normalizePortraitCharacter(character);
  return `draft_${hashOf(`${c.name || ""}|${c.race || ""}|${c.characterClass || ""}|${c.background || ""}|${c.pronouns || ""}`)}`;
}

// In-process status for draft portraits being generated (poll source of truth;
// disk is the fallback so a completed asset survives a process restart).
const draftPortraits = new Map();

// Generates one slot, writes bytes to disk, and flips the asset's status.
// On any failure the asset is marked `failed`; the error is swallowed so a
// single bad variant never aborts the rest of the job. The base portrait
// (referenceImageUrl null) is produced via text-to-image; expression variants
// pass the base portrait as the IP-Adapter reference (image-to-image) where the
// provider supports it, else fresh seed-locked txt2img. width/height default to
// portrait when omitted.
async function generateSlot({ runId, npcId, slot, assetId, prompt, style, referenceImageUrl, seed, width, height }) {
  try {
    const result = await generateImage({ prompt, style, referenceImageUrl, seed, width, height });
    const bytes = result?.bytes;
    if (!bytes || !bytes.length) {
      throw new Error("image provider returned no bytes");
    }
    // Name/serve the file by its real type (providers may return JPEG/WEBP, not
    // always PNG) so the served Content-Type matches the bytes.
    const ext = detectImageExt(bytes) || "png";
    const target = diskPathFor(runId, npcId, slot, ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    const uri = servedUriFor(runId, npcId, slot, ext);
    updateImageAssetStatus(runId, assetId, "generated", uri);
    return { slot, ok: true, uri };
  } catch (error) {
    updateImageAssetStatus(runId, assetId, "failed", null);
    logWorker(`slot ${slot} failed for ${runId}/${npcId}`, error);
    return { slot, ok: false };
  }
}

/**
 * NPC base-portrait job. Awaitable (used directly by tests). Generates ONLY the
 * base portrait on first encounter — expression variants are produced lazily,
 * one per talk beat, by runVariantImageJob. (Most NPCs are seen in only 1-2
 * expressions, so eagerly generating all six wasted ~70% of the image budget.)
 * @param {{ runId: string, npcId: string, style?: string, basePrompt?: string }} job
 * @returns {Promise<{ ok: boolean, base?: object, variants?: object[], reason?: string }>}
 */
export async function runImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const npcId = String(job.npcId || "").trim();
  if (!runId || !npcId) {
    return { ok: false, reason: "missing runId or npcId" };
  }

  const linked = ensureNpcImageAssets(runId, npcId, { style: job.style });
  if (!linked) {
    return { ok: false, reason: "run or npc not found" };
  }

  const run = getSoloRun(runId);
  const npc = run?.npcs?.[npcId] || null;

  const style = job.style ? String(job.style).trim() : "";
  // Stable per-NPC seed (used by seed-aware providers like Pollinations) so the
  // same NPC's portraits are reproducible across regenerations.
  const seed = Number.isFinite(Number(npc?.identitySeed)) ? Number(npc.identitySeed) : null;
  // Prefer an explicit job prompt, then the NPC's generated portraitPrompt,
  // then a role-based fallback (never the bare npcId stub).
  const basePrompt = String(
    job.basePrompt ||
    npc?.portraitPrompt ||
    `portrait of a ${npc?.role || npcId}, dark fantasy, detailed`
  ).trim();

  // Base portrait anchors every variant. If a base already exists (e.g. a user
  // upload marked "generated"), reuse it instead of regenerating; otherwise
  // produce it via text-to-image.
  const baseAsset = run?.imageAssets?.[linked.base] || null;
  let base;
  if (baseAsset && baseAsset.status === "generated" && typeof baseAsset.uri === "string" && baseAsset.uri) {
    base = { slot: "base", ok: true, uri: baseAsset.uri, reused: true };
  } else {
    base = await generateSlot({
      runId,
      npcId,
      slot: "base",
      assetId: linked.base,
      prompt: `${basePrompt}, neutral expression, ${PORTRAIT_ART_DIRECTION}`,
      style,
      seed,
      referenceImageUrl: null,
      ...PORTRAIT_DIMENSIONS
    });
  }
  // Expression variants are NOT generated here. They are produced lazily — one
  // at a time, when a talk beat actually needs a given expression — by
  // runVariantImageJob. First encounter costs exactly one image (the base).
  return { ok: true, base, variants: [] };
}

/**
 * Lazy single-variant job: generates ONE expression variant for an NPC, on
 * demand (a talk beat told us which expression is needed). Awaitable; never
 * throws to the queue. Generate-once / cache-forever (skips an already-generated
 * slot), and seed-locked to the NPC's identitySeed so the variant stays
 * consistent with the base. Anchors on the base portrait as an IP-Adapter
 * reference where the provider supports it; txt2img providers (Pollinations)
 * ignore the reference and rely on the shared seed + prompt delta.
 * @param {{ runId: string, npcId: string, expression: string, style?: string, basePrompt?: string }} job
 * @returns {Promise<{ ok: boolean, variant?: object, reason?: string, skipped?: boolean }>}
 */
export async function runVariantImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const npcId = String(job.npcId || "").trim();
  const expression = String(job.expression || "").trim();
  if (!runId || !npcId || !expression) {
    return { ok: false, reason: "missing runId, npcId, or expression" };
  }
  if (!NPC_EXPRESSIONS.includes(expression)) {
    return { ok: false, reason: `unknown expression: ${expression}` };
  }
  // Txt2img-only providers (TXT2IMG_ONLY_IMAGE_PROVIDERS, currently none) skip
  // variants entirely; the UI falls back to the base portrait for every expression.
  if (!providerSupportsReference(resolveImageProvider())) {
    return { ok: true, skipped: true, reason: "provider does not generate variants" };
  }

  const linked = ensureNpcImageAssets(runId, npcId, { style: job.style });
  if (!linked) {
    return { ok: false, reason: "run or npc not found" };
  }
  const assetId = linked.variants[expression];
  if (!assetId) {
    return { ok: false, reason: `no slot for expression: ${expression}` };
  }

  const run = getSoloRun(runId);
  // Generate-once / cache-forever: a variant already generated is reused as-is.
  const existing = run?.imageAssets?.[assetId] || null;
  if (existing && existing.status === "generated" && typeof existing.uri === "string" && existing.uri) {
    return { ok: true, variant: { slot: expression, ok: true, uri: existing.uri, reused: true } };
  }

  const npc = run?.npcs?.[npcId] || null;
  const style = job.style ? String(job.style).trim() : "";
  // Seed-locked to the base so the variant reads as the same character.
  const seed = Number.isFinite(Number(npc?.identitySeed)) ? Number(npc.identitySeed) : null;
  const basePrompt = String(
    job.basePrompt ||
    npc?.portraitPrompt ||
    `portrait of a ${npc?.role || npcId}, dark fantasy, detailed`
  ).trim();

  // Anchor on the base portrait when it exists (IP-Adapter providers); txt2img
  // ignores it and relies on the shared seed + prompt delta.
  const baseAsset = run?.imageAssets?.[linked.base] || null;
  const referenceImageUrl =
    baseAsset && baseAsset.status === "generated" && typeof baseAsset.uri === "string" && baseAsset.uri
      ? referenceUrlFor(baseAsset.uri)
      : null;

  const variant = await generateSlot({
    runId,
    npcId,
    slot: expression,
    assetId,
    prompt: `${basePrompt}, ${expression} expression, ${PORTRAIT_ART_DIRECTION}`,
    style,
    seed,
    referenceImageUrl,
    ...PORTRAIT_DIMENSIONS
  });
  return { ok: true, variant };
}

/**
 * Generates the player-character portrait from race + class + world tone/style
 * and stores its URI on run.player (narrow write). Awaitable; idempotent (skips
 * when a portrait already exists). The player is not an NPC, so this writes
 * run.player.portraitUri directly rather than an imageAsset record.
 * @param {{ runId: string }} job
 */
export async function runPlayerImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  if (!runId) {
    return { ok: false, reason: "missing runId" };
  }
  const run = getSoloRun(runId);
  const player = run?.player || null;
  if (!player) {
    return { ok: false, reason: "run or player not found" };
  }
  if (typeof player.portraitUri === "string" && player.portraitUri) {
    return { ok: true, skipped: true };
  }

  const character = player.character || {};
  const style = run.world?.artStyle || "illustrated";

  // Merge the full character record with the mirrored run.player.* fallbacks,
  // then build the prompt + seed via the shared player-portrait helpers (same
  // ones the draft/mid-creation path uses, so a from-scratch run portrait
  // matches what the creator previewed).
  const merged = {
    name: character.name || player.displayName || null,
    race: character.race || player.race || null,
    class: character.class || player.className || player.characterClass || null,
    background: character.background || player.background || null,
    pronouns: character.pronouns || player.pronouns || null
  };
  const prompt = buildPlayerPortraitPrompt(merged, run.world || {});
  const seed = playerPortraitSeed(merged);

  try {
    const result = await generateImage({ prompt, style, seed, ...PLAYER_PORTRAIT_DIMENSIONS });
    const bytes = result?.bytes;
    if (!bytes || !bytes.length) {
      throw new Error("image provider returned no bytes");
    }
    const ext = detectImageExt(bytes) || "png";
    const target = diskPathFor(runId, "player", "base", ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    const uri = servedUriFor(runId, "player", "base", ext);
    updatePlayerPortrait(runId, uri);
    return { ok: true, uri };
  } catch (error) {
    logWorker(`player portrait failed for ${runId}`, error);
    return { ok: false };
  }
}

// Finds a completed draft portrait file on disk (covers a process restart that
// dropped the in-memory status, and the carry-forward copy at run creation).
function findDraftPortraitOnDisk(draftId) {
  const dir = path.join(assetsRoot(), String(draftId), "player");
  if (!fs.existsSync(dir)) {
    return null;
  }
  const file = fs.readdirSync(dir).find((name) => /^base\.(png|jpe?g|webp)$/i.test(name));
  if (!file) {
    return null;
  }
  const ext = file.split(".").pop();
  return { ext, uri: servedUriFor(draftId, "player", "base", ext) };
}

/**
 * Generates a mid-creation (draft) player portrait into a temporary asset
 * namespace keyed by draftId — no run required. Status is tracked in-memory for
 * polling; the bytes are written to data/assets/<draftId>/player/base.*.
 * @param {{ draftId: string, character: object, world: object }} job
 */
export async function runDraftPortraitJob(job = {}) {
  const draftId = String(job.draftId || "").trim();
  if (!draftId) {
    return { ok: false, reason: "missing draftId" };
  }
  const character = job.character || {};
  const world = job.world || {};

  // Already generated (idempotent on identical character choices)?
  const onDisk = findDraftPortraitOnDisk(draftId);
  if (onDisk) {
    draftPortraits.set(draftId, { status: "generated", uri: onDisk.uri });
    return { ok: true, uri: onDisk.uri, skipped: true };
  }

  draftPortraits.set(draftId, { status: "generating", uri: null });
  const prompt = buildPlayerPortraitPrompt(character, world);
  const style = isStr(world.artStyle) ? world.artStyle : "illustrated";
  const seed = playerPortraitSeed(character);

  try {
    const result = await generateImage({ prompt, style, seed, ...PLAYER_PORTRAIT_DIMENSIONS });
    const bytes = result?.bytes;
    if (!bytes || !bytes.length) {
      throw new Error("image provider returned no bytes");
    }
    const ext = detectImageExt(bytes) || "png";
    const target = diskPathFor(draftId, "player", "base", ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    const uri = servedUriFor(draftId, "player", "base", ext);
    draftPortraits.set(draftId, { status: "generated", uri });
    return { ok: true, uri };
  } catch (error) {
    draftPortraits.set(draftId, { status: "failed", uri: null });
    logWorker(`draft portrait failed for ${draftId}`, error);
    return { ok: false };
  }
}

/**
 * Poll status for a draft portrait: { status: "generating"|"generated"|"failed", uri }.
 * Falls back to disk when the in-memory status is gone (restart / carry-forward).
 * @param {string} draftId
 */
export function getDraftPortrait(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    return { status: "failed", uri: null };
  }
  const mem = draftPortraits.get(id);
  if (mem) {
    return { status: mem.status, uri: mem.uri || null };
  }
  const onDisk = findDraftPortraitOnDisk(id);
  if (onDisk) {
    return { status: "generated", uri: onDisk.uri };
  }
  // Unknown to this process and not on disk — report generating; the client
  // caps its polling attempts so this never loops forever.
  return { status: "generating", uri: null };
}

/**
 * Copies a completed draft portrait into a run's asset namespace and returns the
 * run-scoped served URI (or null if no draft asset exists). Lets a freshly
 * created run reuse the portrait the player saw during creation instead of
 * regenerating from scratch.
 * @param {string} draftId
 * @param {string} runId
 */
export function copyDraftPortraitToRun(draftId, runId) {
  const id = String(draftId || "").trim();
  const rid = String(runId || "").trim();
  if (!id || !rid) {
    return null;
  }
  const found = findDraftPortraitOnDisk(id);
  if (!found) {
    return null;
  }
  try {
    const src = diskPathFor(id, "player", "base", found.ext);
    const dest = diskPathFor(rid, "player", "base", found.ext);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return servedUriFor(rid, "player", "base", found.ext);
  } catch (error) {
    logWorker(`draft portrait carry-forward failed ${id} -> ${rid}`, error);
    return null;
  }
}

// Fallback prompt when the caller did not supply one: location name + world
// tone, as a wide establishing shot with no people.
function buildLocationPromptFallback(run, location, locationId) {
  const name = location && typeof location.name === "string" && location.name ? location.name : locationId;
  const tone = run?.world?.tone || "dark fantasy";
  return `${name}, ${tone}, atmospheric, wide establishing shot, no people`;
}

/**
 * Generates a location's background establishing image and stores its URI as an
 * imageAsset on the run (keyed by the deterministic location asset id).
 * Generate-once / cache-forever: skips when the asset is already generated.
 * Awaitable; never throws. The location is not an NPC, so this uses a single
 * text-to-image generation (no expression variants).
 * @param {{ runId: string, locationId: string, style?: string, basePrompt?: string, seed?: number }} job
 */
export async function runLocationImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const locationId = String(job.locationId || "").trim();
  if (!runId || !locationId) {
    return { ok: false, reason: "missing runId or locationId" };
  }

  const linked = ensureLocationImageAsset(runId, locationId, {
    promptSummary: job.style ? `style:${job.style}` : null
  });
  if (!linked) {
    return { ok: false, reason: "run or location not found" };
  }

  const run = getSoloRun(runId);
  const asset = run?.imageAssets?.[linked.assetId] || null;
  if (asset && asset.status === "generated" && typeof asset.uri === "string" && asset.uri) {
    return { ok: true, skipped: true };
  }

  const location = run?.locations?.[locationId] || null;
  const style = job.style ? String(job.style).trim() : "";
  const seed = Number.isFinite(Number(job.seed)) ? Number(job.seed) : null;
  const prompt = String(job.basePrompt || buildLocationPromptFallback(run, location, locationId)).trim();
  // Filesystem-safe folder segment for this location's assets.
  const folder = `location_${locationId}`;

  try {
    // Location backgrounds are wide establishing shots -> landscape aspect.
    const result = await generateImage({ prompt, style, seed, ...LANDSCAPE_DIMENSIONS });
    const bytes = result?.bytes;
    if (!bytes || !bytes.length) {
      throw new Error("image provider returned no bytes");
    }
    const ext = detectImageExt(bytes) || "png";
    const target = diskPathFor(runId, folder, "base", ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    const uri = servedUriFor(runId, folder, "base", ext);
    updateImageAssetStatus(runId, linked.assetId, "generated", uri);
    return { ok: true, uri };
  } catch (error) {
    updateImageAssetStatus(runId, linked.assetId, "failed", null);
    logWorker(`location image failed for ${runId}/${locationId}`, error);
    return { ok: false };
  }
}

function dispatchJob(job) {
  if (job && job.kind === "player") {
    return runPlayerImageJob(job);
  }
  if (job && job.kind === "location") {
    return runLocationImageJob(job);
  }
  if (job && job.kind === "variant") {
    return runVariantImageJob(job);
  }
  if (job && job.kind === "draft") {
    return runDraftPortraitJob(job);
  }
  return runImageJob(job);
}

async function drainQueue() {
  if (processing) {
    return;
  }
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        await dispatchJob(job);
      } catch (error) {
        logWorker("job crashed", error);
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Enqueues an NPC portrait job. Fire-and-forget: returns immediately, never
 * throws, and processing happens on a later microtask. Safe to call from a
 * request path.
 * @param {{ runId: string, npcId: string, style?: string, basePrompt?: string }} job
 */
export function enqueueImageJob(job = {}) {
  if (!job || !job.runId || !job.npcId) {
    return;
  }
  queue.push(job);
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
}

/**
 * Enqueues a lazy single-expression-variant job. Fire-and-forget; safe from a
 * request path. The worker skips it if that variant is already generated, so
 * it's cheap to call on every talk beat.
 * @param {{ runId: string, npcId: string, expression: string, style?: string, basePrompt?: string }} job
 */
export function enqueueVariantImageJob(job = {}) {
  if (!job || !job.runId || !job.npcId || !job.expression) {
    return;
  }
  queue.push({
    kind: "variant",
    runId: job.runId,
    npcId: job.npcId,
    expression: job.expression,
    style: job.style,
    basePrompt: job.basePrompt
  });
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
}

/**
 * Enqueues the player-portrait job. Fire-and-forget; safe from a request path.
 * @param {{ runId: string }} job
 */
export function enqueuePlayerImageJob(job = {}) {
  if (!job || !job.runId) {
    return;
  }
  queue.push({ kind: "player", runId: job.runId });
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
}

/**
 * Enqueues a mid-creation (draft) portrait job and returns its draftId. The id
 * is derived deterministically from the character fields, so identical choices
 * reuse the same namespace (and a cached, already-generated asset). Fire-and-
 * forget; safe from a request path.
 * @param {{ character: object, world: object }} job
 * @returns {string} draftId for polling / carry-forward
 */
export function enqueueDraftPortrait(job = {}) {
  const character = job.character || {};
  const world = job.world || {};
  const draftId = computeDraftPortraitId(character);

  // Idempotent: if already generated on disk, mark generated and skip the queue.
  const existing = findDraftPortraitOnDisk(draftId);
  if (existing) {
    draftPortraits.set(draftId, { status: "generated", uri: existing.uri });
    return draftId;
  }

  draftPortraits.set(draftId, { status: "generating", uri: null });
  queue.push({ kind: "draft", draftId, character, world });
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
  return draftId;
}

/**
 * Enqueues a location background-image job. Fire-and-forget; safe from a
 * request path. Never throws.
 * @param {{ runId: string, locationId: string, style?: string, basePrompt?: string, seed?: number }} job
 */
export function enqueueLocationImageJob(job = {}) {
  if (!job || !job.runId || !job.locationId) {
    return;
  }
  queue.push({
    kind: "location",
    runId: job.runId,
    locationId: job.locationId,
    style: job.style,
    basePrompt: job.basePrompt,
    seed: job.seed
  });
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
}

/**
 * Current number of queued (not-yet-started) jobs. Exposed for tests/diagnostics.
 * @returns {number}
 */
export function queuedJobCount() {
  return queue.length;
}
