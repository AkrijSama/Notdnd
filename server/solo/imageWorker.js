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
// scene route enqueues jobs and returns immediately. Each job generates a base
// portrait (once) plus the six expression variants, anchored on the base via
// reference conditioning, writes the bytes to disk, and flips each asset's
// status via a narrow repository write (never saveSoloRun).
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
 * Core job runner. Awaitable (used directly by tests). Generates the base
 * portrait first, then the six expression variants anchored on it.
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
  const referenceImageUrl = base.ok ? referenceUrlFor(base.uri) : null;

  const variants = [];
  // Expression variants: providers that can anchor on the base (fal / IP-Adapter)
  // do so via referenceImageUrl; txt2img providers (Pollinations) ignore the
  // reference and instead generate a fresh image with the SAME per-NPC seed and a
  // prompt delta (", angry expression"), which keeps the character recognizable.
  // Only providers in TXT2IMG_ONLY_IMAGE_PROVIDERS (currently none) skip variants
  // and fall back to the base portrait for every expression.
  if (providerSupportsReference(resolveImageProvider())) {
    for (const expression of NPC_EXPRESSIONS) {
      const assetId = linked.variants[expression];
      if (!assetId) {
        continue;
      }
      // Generate-once / cache-forever: skip a variant slot that is already
      // generated (mirrors the base-portrait reuse check above). Only missing or
      // previously-failed slots are (re)generated, so re-running the job after a
      // partial failure fills the gaps without re-paying for completed slots.
      const variantAsset = run?.imageAssets?.[assetId] || null;
      if (variantAsset && variantAsset.status === "generated" && typeof variantAsset.uri === "string" && variantAsset.uri) {
        variants.push({ slot: expression, ok: true, uri: variantAsset.uri, reused: true });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
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
      variants.push(variant);
    }
  }

  return { ok: true, base, variants };
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
  const tone = run.world?.tone || "dark fantasy";
  const style = run.world?.artStyle || "illustrated";

  // Build the subject from the full character record (character.* wins, then the
  // mirrored run.player.* fields) instead of the old race+class-only descriptor.
  const name = character.name || player.displayName || null;
  const race = character.race || player.race || null;
  const characterClass = character.class || player.className || player.characterClass || null;
  const background = character.background || player.background || null;
  const pronouns = character.pronouns || player.pronouns || null;

  const subject =
    [
      name ? `${name},` : null,
      pronouns ? `${pronouns},` : null,
      race,
      characterClass,
      background ? `${background} background` : null
    ]
      .filter(Boolean)
      .join(" ") || "wanderer";

  const prompt = `character portrait of ${subject}, ${tone}, ${PORTRAIT_ART_DIRECTION}`;
  const seed = Number.isFinite(Number(character.identitySeed)) ? Number(character.identitySeed) : null;

  try {
    const result = await generateImage({ prompt, style, seed, ...PORTRAIT_DIMENSIONS });
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
