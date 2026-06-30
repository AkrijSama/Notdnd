import fs from "node:fs";
import path from "node:path";
import { editImage, generateImage } from "../ai/providers.js";
import { detectImageExt } from "../api/http.js";
import {
  ensureLocationImageAsset,
  ensureNpcImageAssets,
  getSoloRun,
  incrementImageCount,
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

// Player / character-creation portraits: a SINGLE subject in a SINGLE pose — NOT
// a multi-pose "character reference sheet". The old reference-sheet / full-body +
// face-inset composite literally produced turnaround sheets AND dragged in
// fantasy-concept-art conventions that overrode the race descriptor (e.g. elf
// ears on Humans). PLAYER_SINGLE_SUBJECT asserts one figure; PLAYER_NO_SHEET
// negates the sheet behaviour. Both are part of every player art direction.
const PLAYER_SINGLE_SUBJECT =
  "single character portrait, one figure, centered, three-quarter view, single subject, head and upper body";
const PLAYER_NO_SHEET =
  "NOT a character reference sheet, NO multiple poses, NO multiple angles, NO duplicate figures, NO turnaround, single image only";
const PLAYER_PORTRAIT_ART_DIRECTION =
  `${PLAYER_SINGLE_SUBJECT}, painterly fantasy illustration, dramatic rim lighting, highly detailed, plain dark background, ${PLAYER_NO_SHEET}`;

// Shared LOCATION composition: location backgrounds render into the wide scene
// banner (3:2, LANDSCAPE_DIMENSIONS), so they must compose AS a backdrop the scene
// sits in front of — a wide establishing shot, not a centered subject. This is the
// composition cue ONLY; the per-style aesthetic (painterly / anime / cinematic)
// lives in each style's `location` surface so a scene matches the run's art style.
const LOCATION_COMPOSITION =
  "wide establishing shot, landscape orientation, environmental scene, " +
  "atmospheric depth, background backdrop, no people, no characters";

// Per-art-style base direction. generateImage() appends ", <style> style" as the
// medium cue (providers.js); this base must AGREE with that cue instead of always
// asserting "painterly illustration", which fights anime/cinematic runs. Player
// entries are single-subject (no reference sheet); NPC entries are single busts;
// location entries pair the per-style aesthetic with LOCATION_COMPOSITION so a
// scene image carries the player's selected style (anime run -> anime scene).
const ART_STYLE_DIRECTION = {
  illustrated: {
    npc: PORTRAIT_ART_DIRECTION,
    player: PLAYER_PORTRAIT_ART_DIRECTION,
    location: `painterly fantasy illustration, detailed environment, dramatic lighting, ${LOCATION_COMPOSITION}`
  },
  anime: {
    npc: "anime portrait, clean line art, cel shaded, anime style, expressive face, upper body, plain background",
    player:
      `${PLAYER_SINGLE_SUBJECT}, clean line art, cel shaded, anime style, expressive face, plain background, ${PLAYER_NO_SHEET}`,
    location: `anime background art, clean line art, cel shaded scenery, anime style, vibrant, ${LOCATION_COMPOSITION}`
  },
  cinematic: {
    npc: "cinematic character portrait, moody cinematic, film noir, high contrast, dramatic lighting, detailed face, upper body, dark background",
    player:
      `${PLAYER_SINGLE_SUBJECT}, moody cinematic, film noir, high contrast, dramatic lighting, dark background, ${PLAYER_NO_SHEET}`,
    location: `cinematic establishing shot, moody cinematic, film noir, high contrast, dramatic lighting, ${LOCATION_COMPOSITION}`
  }
};

// Resolves the base art direction for a run's art style + surface
// ("npc" | "player" | "location"). Unknown/missing styles fall back to illustrated.
// Exported for art-style coverage (C.6): a scene's art direction must track the run.
export function artStyleDirection(style, surface) {
  const key = String(style || "").trim().toLowerCase();
  const entry = ART_STYLE_DIRECTION[key] || ART_STYLE_DIRECTION.illustrated;
  return entry[surface];
}

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

// Entitlement metering: count a freshly-generated image against the owning
// user's daily quota. Called only on real generation success (never on cache
// reuse), so re-enqueued in-flight jobs don't double-count. Resolves the user
// from the run; best-effort and never throws (metering must not break art).
function countGeneratedImageForRun(runId) {
  try {
    const run = getSoloRun(runId);
    if (run?.userId) {
      incrementImageCount(run.userId);
    }
  } catch (error) {
    logWorker(`image quota count failed for ${runId}`, error);
  }
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
// Tall VN-sprite aspect for the full-body NPC overlay (NOT the square composite):
// a head-to-toe standing sprite. Generated lazily into a NEW "vnBody" slot,
// separate from the 512x768 bust (which battle tokens + cast thumbnails keep).
const VN_BODY_DIMENSIONS = { width: 832, height: 1216 };

// Full-body VN sprite art direction. Drops "upper body" and any reference-sheet
// inset language; [tone] is injected per run. Standing, head-to-toe, plain dark
// background so the sprite composites cleanly over the scene.
function vnBodyArtDirection(tone) {
  const flavor = typeof tone === "string" && tone.trim() ? tone.trim() : "dark fantasy";
  return `full-body standing character, head to toe, plain dark background, visual novel sprite, ${flavor}, detailed face and clothing`;
}

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
// Visual descriptors for the 10 creator races. Naming a race alone (e.g.
// "Aasimar") lets the model default to a generic fantasy-elf; spelling out the
// distinctive VISUAL traits makes uncommon races render true to type. Keyed by
// lowercased race name (Human is intentionally empty — already the default).
const RACE_VISUAL_DESCRIPTORS = {
  // Only Elf and Half-Elf have pointed ears. Every other race explicitly states
  // "rounded human ears, NOT pointed elf ears" — the base model defaults humanoid
  // fantasy faces to elf ears otherwise (e.g. Aasimar rendering with elf ears).
  human: "ordinary human person, human rounded ears, absolutely NOT pointed elf ears, NOT fantasy elf features, natural human face",
  elf: "pointed ears, slender graceful build, ageless angular face",
  dwarf: "short and stocky, thick braided beard, broad rugged features, rounded human ears (NOT pointed elf ears)",
  halfling: "small in stature, youthful round face, curly hair, rounded human ears (NOT pointed elf ears)",
  gnome: "small in stature, large bright eyes, oversized expressive features, rounded ears (NOT pointed elf ears)",
  "half-orc": "muscular build, greenish-grey skin, jutting lower tusks, heavy brow, rounded ears (NOT pointed elf ears)",
  tiefling: "curved horns, long pointed tail, red or violet skin, solid glowing eyes, rounded human-like ears (NOT pointed elf ears)",
  dragonborn: "draconic scaled head, reptilian snout, hairless, scaled skin, no external ears, NOT pointed elf ears",
  "half-elf": "subtly pointed ears, a refined blend of human and elven features",
  aasimar: "celestial human, rounded human ears (NOT pointed elf ears), luminous glowing eyes, radiant otherworldly skin, faint halo of light, human facial structure"
};

// The only races that should render with pointed ears. Every other race gets a
// trailing "NOT pointed elf ears" emphasis in the player prompt (see below).
const POINTED_EAR_RACES = new Set(["elf", "half-elf"]);

function raceVisualDescriptor(race) {
  return RACE_VISUAL_DESCRIPTORS[String(race || "").trim().toLowerCase()] || "";
}

export function buildPlayerPortraitPrompt(character = {}, world = {}) {
  const c = normalizePortraitCharacter(character);
  const tone = isStr(world.tone) ? world.tone.trim() : "dark fantasy";
  // Express the race's visual identity, not just its name, so uncommon races
  // (Aasimar, Tiefling, Dragonborn, …) render distinctly.
  const raceKey = String(c.race || "").trim().toLowerCase();
  const descriptor = c.race ? raceVisualDescriptor(c.race) : "";
  const racePart = c.race ? (descriptor ? `${c.race} (${descriptor})` : c.race) : null;
  const subject =
    [
      c.name ? `${c.name},` : null,
      c.pronouns ? `${c.pronouns},` : null,
      racePart,
      c.characterClass,
      c.background ? `${c.background} background` : null
    ]
      .filter(Boolean)
      .join(" ") || "wanderer";
  // Pointed ears belong ONLY to elves/half-elves. For every other race, repeat
  // the negation as a trailing (heavily-weighted) clause so the descriptor in the
  // subject can't be quietly overridden by the medium/style framing.
  const earEmphasis = raceKey && !POINTED_EAR_RACES.has(raceKey)
    ? ", human rounded ears, absolutely NOT pointed elf ears, NOT fantasy elf features"
    : "";
  return `character portrait of ${subject}, ${tone}, ${artStyleDirection(world.artStyle, "player")}${earEmphasis}`;
}

// Deterministic seed from name+race+class+artStyle so identical core choices
// reproduce the same image, while a different art style yields a different seed
// (so deterministic providers like Pollinations don't return the prior style's
// image). Independent of the draft-namespace id below.
function playerPortraitSeed(character = {}, world = {}) {
  const c = normalizePortraitCharacter(character);
  const style = isStr(world?.artStyle) ? world.artStyle.trim().toLowerCase() : "illustrated";
  return hashOf(`${c.name || ""}|${c.race || ""}|${c.characterClass || ""}|${style}`);
}

// Draft asset namespace id: hashed over EVERY prompt-affecting field so any
// change (race/class/background/pronouns/name) yields a fresh namespace and a
// regeneration, while identical choices reuse the cached asset.
export function computeDraftPortraitId(character = {}, nonce = 0, world = {}, editTag = "") {
  const c = normalizePortraitCharacter(character);
  // artStyle + tone are part of the generated prompt, so they MUST be part of the
  // cache namespace. Without them, switching art style (e.g. illustrated -> anime)
  // for the same character resolves to the SAME draftId and serves the stale
  // image generated for the previous style — the "picked Anime, got dark fantasy"
  // bug. Defaulting style to "illustrated" matches buildPlayerPortraitPrompt.
  const style = isStr(world?.artStyle) ? world.artStyle.trim().toLowerCase() : "illustrated";
  const tone = isStr(world?.tone) ? world.tone.trim().toLowerCase() : "";
  // An edit instruction (conversational portrait editor) is part of the produced
  // image, so it joins the cache namespace — two different tweaks at the same
  // nonce must not collide on one draftId.
  const edit = String(editTag || "").trim().toLowerCase();
  const base = `${c.name || ""}|${c.race || ""}|${c.characterClass || ""}|${c.background || ""}|${c.pronouns || ""}|${style}|${tone}${edit ? `|e:${edit}` : ""}`;
  // A redo nonce (>0) yields a fresh namespace so the disk cache is bypassed and
  // a NEW image is generated. nonce 0 keeps a stable id for a given combo, so
  // first-generation and carry-forward behaviour are unchanged.
  const n = Math.trunc(Number(nonce) || 0);
  return `draft_${hashOf(n > 0 ? `${base}|n${n}` : base)}`;
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
    countGeneratedImageForRun(runId);
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
      prompt: `${basePrompt}, neutral expression, ${artStyleDirection(style, "npc")}`,
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
  // EXPRESSION VARIANTS DISABLED (intentional removal). We no longer generate a
  // fresh per-expression txt2img. The base bust and each expression variant were
  // INDEPENDENT generations that did not share a face, so a recurring NPC's face
  // mutated every appearance — directly contradicting the "a world that remembers"
  // promise. Now every expression reuses the single cached BASE portrait: the UI
  // falls back to it whenever no variant URI exists (see renderSoloDialogueOverlay
  // and resolveExpressionVariantUris), so this skip yields a stable, recognizable
  // face — not a broken image. One image per character (the base), reused for all
  // expressions, less quota burn.
  //
  // The IP-Adapter reference seam (generateSlot + referenceImageUrl, still used by
  // the base portrait + VN body) is intentionally left INTACT and DORMANT — it is
  // the future cross-run consistency lever via a reference-capable provider swap.
  // We route variant requests to the cached base; we do not delete the seam.
  return { ok: true, skipped: true, reason: "expression variants disabled — reusing cached base portrait" };
}

/**
 * Lazy full-body VN-sprite job: generates ONE tall (832x1216) head-to-toe sprite
 * for an NPC, on demand, into the NEW "vnBody" slot — distinct from the 512x768
 * bust (which battle tokens + cast thumbnails keep using). Only invoked when an
 * NPC first enters VN mode (cost control); never generated upfront for every NPC.
 * Generate-once / cache-forever (skips an already-generated slot), and seed-locked
 * to the NPC's identitySeed so the sprite reads as the same character as the bust.
 * On Pollinations this is a fresh txt2img (bust manipulation is a later fal.ai
 * phase). Awaitable; never throws to the queue. Routes through the same provider
 * failover (Pollinations primary) as every other generation via generateImage.
 * @param {{ runId: string, npcId: string, style?: string, basePrompt?: string }} job
 * @returns {Promise<{ ok: boolean, vnBody?: object, reason?: string, skipped?: boolean }>}
 */
export async function runVnBodyImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const npcId = String(job.npcId || "").trim();
  if (!runId || !npcId) {
    return { ok: false, reason: "missing runId or npcId" };
  }

  const linked = ensureNpcImageAssets(runId, npcId, { style: job.style });
  if (!linked || !linked.vnBody) {
    return { ok: false, reason: "run or npc not found" };
  }

  const run = getSoloRun(runId);
  // Generate-once / cache-forever: an existing full-body sprite is reused as-is.
  const existing = run?.imageAssets?.[linked.vnBody] || null;
  if (existing && existing.status === "generated" && typeof existing.uri === "string" && existing.uri) {
    return { ok: true, vnBody: { slot: "vnBody", ok: true, uri: existing.uri, reused: true } };
  }

  const npc = run?.npcs?.[npcId] || null;
  const style = job.style ? String(job.style).trim() : "";
  // Seed-locked to the bust so the full-body sprite reads as the same character.
  const seed = Number.isFinite(Number(npc?.identitySeed)) ? Number(npc.identitySeed) : null;
  const tone = run?.world?.tone || "dark fantasy";
  const basePrompt = String(
    job.basePrompt ||
    npc?.portraitPrompt ||
    `a ${npc?.role || npcId}, dark fantasy, detailed`
  ).trim();

  const vnBody = await generateSlot({
    runId,
    npcId,
    slot: "vnBody",
    assetId: linked.vnBody,
    // Fresh txt2img standing sprite — no reference (manipulation is a later phase).
    prompt: `${basePrompt}, ${vnBodyArtDirection(tone)}`,
    style,
    seed,
    referenceImageUrl: null,
    ...VN_BODY_DIMENSIONS
  });
  return { ok: true, vnBody };
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
  const seed = playerPortraitSeed(merged, run.world || {});

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
    countGeneratedImageForRun(runId);
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
  // Offset the deterministic seed by the redo nonce so a reroll produces a
  // genuinely different image (not the same one under a fresh id). Seed also
  // varies by art style so a style change yields a different image.
  const seed = playerPortraitSeed(character, world) + Math.trunc(Number(job.nonce) || 0) * 100003;
  const editInstruction = typeof job.editInstruction === "string" ? job.editInstruction.trim() : "";
  const sourceImageUrl = typeof job.sourceImageUrl === "string" ? job.sourceImageUrl.trim() : "";

  try {
    // A conversational edit routes through editImage (kontext-first edit of the
    // current portrait, regenerate fallback when no funded key); a plain
    // generation/redo uses generateImage. Same prompt base so the character holds.
    const result = editInstruction
      ? await editImage({ sourceImageUrl, instruction: editInstruction, prompt, style, seed, ...PLAYER_PORTRAIT_DIMENSIONS })
      : await generateImage({ prompt, style, seed, ...PLAYER_PORTRAIT_DIMENSIONS });
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

// Fallback subject when the caller did not supply a prompt: just location name +
// world tone. The establishing-shot composition is added by LOCATION_ART_DIRECTION
// in runLocationImageJob, so it is intentionally not repeated here.
function buildLocationPromptFallback(run, location, locationId) {
  const name = location && typeof location.name === "string" && location.name ? location.name : locationId;
  const tone = run?.world?.tone || "dark fantasy";
  return `${name}, ${tone}`;
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
  // The run's selected art style (C.6): prefer the job's style, else read it off
  // the run (world.artStyle is the authoritative source delivered to this worker;
  // flags.artStyle is the enqueue mirror). Drives BOTH the location art direction
  // and generateImage's medium cue, so an anime run yields an anime scene image.
  const style =
    (job.style && String(job.style).trim()) ||
    (isStr(run?.world?.artStyle) ? run.world.artStyle.trim() : "") ||
    (isStr(run?.flags?.artStyle) ? run.flags.artStyle.trim() : "") ||
    "illustrated";
  const seed = Number.isFinite(Number(job.seed)) ? Number(job.seed) : null;
  // Compose FOR the wide banner: the subject (caller prompt or fallback) plus the
  // STYLE-AWARE location art direction (per-style aesthetic + establishing-shot
  // composition), so the scene reads as a backdrop in the run's actual art style.
  const subject = String(job.basePrompt || buildLocationPromptFallback(run, location, locationId)).trim();
  const locationDirection = artStyleDirection(style, "location");
  const prompt = subject ? `${subject}, ${locationDirection}` : locationDirection;
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
    // Redo reuses the same on-disk path, so without a unique query the browser
    // would re-show the cached old image. The fresh per-redo seed is a stable,
    // unique cache-buster (serveStatic strips the query). First/auto generation
    // passes no seed -> clean URL.
    const finalUri = seed != null ? `${uri}?v=${seed}` : uri;
    updateImageAssetStatus(runId, linked.assetId, "generated", finalUri);
    countGeneratedImageForRun(runId);
    return { ok: true, uri: finalUri };
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
  if (job && job.kind === "vnBody") {
    return runVnBodyImageJob(job);
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
 * No-op: per-expression variant generation is disabled (see runVariantImageJob).
 * Kept as a stable export so the request path can keep calling it harmlessly;
 * it enqueues nothing, so no fresh per-expression txt2img is ever produced and
 * the UI reuses the single cached base portrait for every expression.
 * @param {{ runId: string, npcId: string, expression: string, style?: string, basePrompt?: string }} job
 */
export function enqueueVariantImageJob(/* job */) {
  // Intentionally does nothing — characters collapse to one cached portrait.
}

/**
 * Enqueues a lazy full-body VN-sprite job. Fire-and-forget; safe from a request
 * path. The worker skips it if the vnBody slot is already generated, so it's
 * cheap to call on every scene load while an NPC is in VN mode.
 * @param {{ runId: string, npcId: string, style?: string, basePrompt?: string }} job
 */
export function enqueueVnBodyImageJob(job = {}) {
  if (!job || !job.runId || !job.npcId) {
    return;
  }
  queue.push({
    kind: "vnBody",
    runId: job.runId,
    npcId: job.npcId,
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
  // Redo nonce: bypasses the cache (new id) and varies the seed (new image).
  const nonce = Math.trunc(Number(job.nonce) || 0);
  // Conversational portrait editor: a tweak ("longer hair", "add a scar") applied
  // to the CURRENT portrait. editInstruction joins the cache id (so each tweak is
  // its own version) and routes generation through editImage (kontext-first edit
  // with a regenerate fallback) using sourceImageUrl as the base.
  const editInstruction = typeof job.editInstruction === "string" ? job.editInstruction.trim() : "";
  const sourceImageUrl = typeof job.sourceImageUrl === "string" ? job.sourceImageUrl.trim() : "";
  const draftId = computeDraftPortraitId(character, nonce, world, editInstruction);

  // Idempotent: if already generated on disk, mark generated and skip the queue.
  const existing = findDraftPortraitOnDisk(draftId);
  if (existing) {
    draftPortraits.set(draftId, { status: "generated", uri: existing.uri });
    return draftId;
  }

  draftPortraits.set(draftId, { status: "generating", uri: null });
  queue.push({ kind: "draft", draftId, character, world, nonce, editInstruction, sourceImageUrl });
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
