import fs from "node:fs";
import path from "node:path";
import { editImage, generateImage } from "../ai/providers.js";
import { engineStyleForRun, styleForRun, hasCommittedArtStyle, ART_RECIPE_VERSION } from "./artStyle.js";
import { deriveWeather, deriveClock } from "./worldClock.js";
import { detectImageExt } from "../api/http.js";
import { addAsset, libraryRoot } from "../../scripts/art/library.mjs";
import { taste } from "./fridgeTaster.js";
import {
  ensureLocationImageAsset,
  ensureNpcImageAssets,
  getSoloRun,
  incrementImageCount,
  updateImageAssetStatus,
  updatePlayerPortrait
} from "../db/repository.js";
import { NPC_EXPRESSIONS } from "./schema.js";
import { resolveStatBlock } from "../campaign/bestiary.js";
import { entityNature } from "./entityNature.js";

// GAP 2 (art-live-recipes): live-generated images join the curated library.
// Default rating matches the batch cook's auto-keep (rating "keep" + an
// "auto-keep" tag so the owner can re-review the walk-gen set), and face-kinds
// are checked out to their run so an UNREVIEWED walk face never leaks into the
// cross-run face pool. (See REPORT: a stricter default — rating null / unrated —
// is a one-constant change if the owner prefers walk products stay out of every
// keep query until reviewed.)
const LIVE_INTAKE_RATING = "keep";

function slugForTag(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Land a live-generated image in the library (additive — the run still serves its
// own asset at the run path). Best-effort: never throws, never blocks a turn.
export function intakeToLibrary({ id, bytes, kind, run, subjectId = null, promptUsed = "", workflow = "", extraTags = [], provider = null }) {
  try {
    if (!bytes || !bytes.length || !id) {
      return null;
    }
    // INTAKE GUARD (2026-07-19, biplane audit): the curated library is
    // VALIDATED-RECIPE content only. A serve-attribution that isn't the validated
    // ComfyUI path (a pollinations/cloudflare failover, or unknown) still serves
    // the run IN-SESSION, but must NEVER be pooled — that is how the pollinations-
    // era poison (and the auto-kept biplane) leaked into every run. Refuse it.
    const prov = String(provider || "").toLowerCase();
    if (prov && prov !== "comfyui") {
      logWorker(`library intake REFUSED: serve-attribution "${provider}" is not the validated recipe (id=${id})`);
      return null;
    }
    const style = styleForRun(run, run?.world) || "";
    const worldSlug = run?.world?.slug || run?.world?.name || null;
    fs.mkdirSync(libraryRoot(), { recursive: true });
    fs.writeFileSync(path.join(libraryRoot(), `${id}.png`), bytes);
    const tags = [
      `kind:${kind}`,
      style ? `style:${style}` : null,
      worldSlug ? `world:${slugForTag(worldSlug)}` : null,
      kind === "scene" && subjectId ? `loc:${slugForTag(subjectId)}` : (subjectId ? `subject:${slugForTag(subjectId)}` : null),
      "live",
      "auto-keep",
      ...extraTags
    ].filter(Boolean);
    const isFace = kind === "portrait" || kind === "fullbody";
    // FRIDGE TASTER (intake decision): a cheap taste check gates auto-keep before it
    // lands. pass -> fridge (library keep, rating LIVE_INTAKE_RATING); suspect ->
    // QUARANTINE (a holding pen served to nothing, resolved by the owner in
    // scripts/art/review.mjs). Default assessor is a zero-cost deterministic mock —
    // see server/solo/fridgeTaster.js + docs/design/fridge-taster.md (config seat).
    const verdict = taste({ id, bytes, kind, run, subjectId, promptUsed, defaultRating: LIVE_INTAKE_RATING });
    return addAsset({
      id,
      origin: "generated",
      creator: run?.userId ?? null,
      world: worldSlug,
      style,
      kind,
      tags: [...tags, ...verdict.tags],
      rating: verdict.rating,
      quarantine: verdict.quarantine,
      // Face-kinds are owned by their run (not pooled) until reviewed — but a
      // QUARANTINED face is served to nothing, so it never checks out.
      checkout: !verdict.quarantine && isFace && run?.runId ? { runId: run.runId, npcId: subjectId || null } : null,
      workflow: workflow || "",
      promptUsed: promptUsed || ""
    });
  } catch (error) {
    logWorker("library intake failed", error);
    return null;
  }
}

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
// ── WORKER HEALTH (autopsy 2026-07-18) ───────────────────────────────────────
// The single-flight `processing` guard had no watchdog: if ANY dispatch failed to
// SETTLE (a hung await — the image path's tail carried no deadline), `processing`
// stayed true forever and every later enqueueImageJob hit `if (processing) return`
// and was SILENTLY DROPPED. No crash, no log — it looked exactly like a cache
// re-serve (owner's redos "returned the same image", zero new ComfyUI jobs for
// ~90 min). Fix: a per-job TIMEOUT so a hang can't pin the drain, a WATCHDOG that
// reclaims a wedged drain, and a loud health flag in /api/debug/status so a dead
// worker can never again masquerade as a cache issue.
// NOVRAM REALITY (2026-07-20): ComfyUI runs `--novram` on an 8GB card shared with the
// display (and, in the owner's failing window, a running game) — the SDXL UNet is fully
// offloaded to CPU RAM and streamed, so a single render is 84–153s and a COLD-LOAD first
// render (fresh checkpoint from disk) plus model-load thrash can approach ~3min. The old
// 180s ceiling was demonstrably too tight for a DF/nihilmania cold render and turned a
// slow-but-succeeding job into a false timeout. Env-tunable; default raised with margin.
const JOB_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.INKBORNE_IMAGE_JOB_TIMEOUT_MS ?? process.env.NOTDND_IMAGE_JOB_TIMEOUT_MS) || 300_000
);
const WEDGE_MS = JOB_TIMEOUT_MS + 30_000; // draining longer ⇒ declared wedged
let drainStartedAt = 0; // epoch ms the CURRENT job started (0 = idle)
let lastJobAt = 0; // epoch ms the last job settled
let lastJobKind = null;
let lastError = null; // { message, at } of the last failure/timeout

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// Loud worker health for /api/debug/status — a dead/wedged worker is now visible.
export function imageWorkerStatus() {
  const stuckMs = processing && drainStartedAt ? Date.now() - drainStartedAt : 0;
  return {
    processing,
    queueDepth: queue.length,
    lastJobKind,
    lastJobAt: lastJobAt ? new Date(lastJobAt).toISOString() : null,
    lastError,
    wedged: stuckMs > WEDGE_MS,
    stuckMs
  };
}

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
// asserts a solo single image. BOTH ARE POSITIVE — a "NOT a reference sheet /
// NO multiple poses" NEGATION backfires exactly like the elf bug did: a diffusion
// model has no "NOT", so it read those words as POSITIVE "character reference
// sheet, multiple poses, turnaround" tokens and PAINTED the 2×2 grid / 5-view
// model sheet (2026-07-18 relapse). The sheet is now suppressed in the NEGATIVE
// field on the ComfyUI lane (PORTRAIT_NEGATIVE_LAW); the positive only ASSERTS solo.
const PLAYER_SINGLE_SUBJECT =
  "single character portrait, one figure, centered, three-quarter view, single subject, upper body portrait, chest-up, shoulders and upper torso fully in frame, natural framing";
const PLAYER_NO_SHEET =
  "solo, one person only, a single portrait of one head, one continuous image";
const PLAYER_PORTRAIT_ART_DIRECTION =
  `${PLAYER_SINGLE_SUBJECT}, painterly fantasy illustration, dramatic rim lighting, highly detailed, plain dark background, ${PLAYER_NO_SHEET}`;

// Shared LOCATION composition: location backgrounds render into the wide scene
// banner (3:2, LANDSCAPE_DIMENSIONS), so they must compose AS a backdrop the scene
// sits in front of — a wide establishing shot, not a centered subject. This is the
// composition cue ONLY; the per-style aesthetic (painterly / anime / cinematic)
// lives in each style's `location` surface so a scene matches the run's art style.
// SCENE FRAMING LAW (owner ruling 2026-07-19): scene art is the PLAYER'S VIEW, not
// an aerial/postcard vista. Eye-level camera, ground/floor in the lower third,
// canon features in the midground, sky no more than the upper third. (Vocabulary
// tuned to what JANKU obeys; the negative guard bans aerial/bird's-eye/sky-only.)
const LOCATION_COMPOSITION =
  "eye-level shot, ground level view, standing on the ground, " +
  "foreground detail anchoring the lower third, A CLEAR SUBJECT in the midground, sky only in the upper third, " +
  "landscape orientation, environmental scene, natural depth, a path leading into the scene";

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
    npc: "anime portrait, clean line art, cel shaded, anime style, expressive face, upper body, simple background, soft gradient background with subtle depth",
    player:
      `${PLAYER_SINGLE_SUBJECT}, clean line art, cel shaded, anime style, expressive face, simple background, soft gradient background with subtle depth, ${PLAYER_NO_SHEET}`,
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

// ASSET LIFECYCLE LAW (owner 2026-07-20): destroy a draft's on-disk namespace (file +
// dir) — the DESTROY half of "library-kept or destroyed, no third state". Best-effort;
// never throws (cleanup must not break a turn).
function destroyDraftAssets(draftId) {
  const id = String(draftId || "").trim();
  if (!id) return false;
  try {
    const dir = path.join(assetsRoot(), id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    draftPortraits.delete(id);
    return true;
  } catch {
    return false;
  }
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

// FAILURE FORENSICS (2026-07-19): a swallowed image failure used to reach the player as a
// bare "failed" with no cause. Classify the error into a short PLAYER-FACING reason so the
// creation UI can say WHY a portrait failed (and whether retrying is worth it), instead of
// a silent retry. The raw error still goes to the worker log (logWorker) for the owner.
export function classifyImageFailure(error) {
  const m = String(error?.message || error || "").toLowerCase();
  // CHOICE-BEFORE-PIXELS (style-lock law): the draft guard rejects a portrait job
  // whose world context carries no committed style. Surface it as a clear, actionable
  // reason — not a scary "art server" failure — since the remedy is a player choice.
  if (/style is not locked|style_not_locked|art style is not|no art style|style not chosen/.test(m)) {
    return "Choose an art style before your portrait can render — the style is locked for the whole campaign.";
  }
  if (/did not complete within|timed out|timeout|deadline/.test(m)) {
    return "The art server took too long (it may be busy or the GPU is loaded). Try again in a moment.";
  }
  if (/econnrefused|unreachable|fetch failed|network|socket/.test(m)) {
    return "The art server is unreachable right now. Your character is saved; try the portrait again shortly.";
  }
  if (/no bytes|no image|no prompt_id|download failed/.test(m)) {
    return "The art server returned no image. Try again, or continue and add a portrait later.";
  }
  if (/node_errors|invalid|workflow|checkpoint/.test(m)) {
    return "The art recipe was rejected by the server. This is a setup issue, not your input.";
  }
  return "The portrait failed to render. Try again, or continue and add one later.";
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
// Landscape lane at the display band's native ratio (owner ruling 2026-07-19): the
// banner shows a wide strip, so generate at 1344x768 (7:4) rather than 768x512 and
// let the UI crop anchor CENTER-BOTTOM (keep the ground, sacrifice sky).
const LANDSCAPE_DIMENSIONS = { width: 1344, height: 768 };
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

// Corruption intensity scaled by threat tier (mirrors sceneDangerRegister's level→
// phrase convention). Higher tier reads visibly more warped.
function enemyCorruptionByTier(tier) {
  const t = Math.max(1, Math.min(4, Number(tier) || 1));
  if (t >= 4) return "catastrophically corrupted, reality bending around it, searing wrong-light aura";
  if (t >= 3) return "deeply corrupted, chaos-warped flesh, glowing wrong-light veins";
  if (t >= 2) return "corrupted, chaos-touched, subtly wrong proportions, a faint wrong-light haze";
  return "lightly corrupted, an uncanny wrongness about it";
}

// Enemy fullbody prompt, minted DETERMINISTICALLY from a bestiary row: the base
// animal + tier-scaled corruption markers + a rider cue from its carried inverted-
// element skill (a bite that chills → frost-rimed). No LLM mints a creature; the row
// is the only input, so the sprite is cache-keyable per stat block.
export function buildEnemyBodyPrompt(statBlock, tone) {
  if (!statBlock || typeof statBlock !== "object") return null;
  const baseName = statBlock.baseAnimalId
    ? String(statBlock.baseAnimalId).replace(/_/g, " ")
    : String(statBlock.name || "creature").toLowerCase();
  const riderCues = (Array.isArray(statBlock.carriedSkills) ? statBlock.carriedSkills : [])
    .map((s) => {
      const rider = s?.mint?.rider;
      const el = s?.mint?.element;
      if (rider === "chill" || rider === "chills" || rider === "frozen") return "frost riming its muzzle and fur, breath steaming cold";
      if (el === "fire" || rider === "burns") return "embers guttering in its coat";
      if (rider === "rots") return "patches of blackened, rotting flesh";
      return null;
    })
    .filter(Boolean);
  const slots = [
    `a wild ${baseName}`,
    statBlock.behaviors?.injured ? "wounded, favoring a ruined foreleg, limping" : null,
    enemyCorruptionByTier(statBlock.tier),
    ...riderCues,
    vnBodyArtDirection(tone)
  ].filter(Boolean);
  return slots.join(", ");
}

/**
 * Enemy fullbody job — the corrupted creature's battle sprite from its bestiary row.
 * No face-ref (creatures have no committed bust). Generate-once/cache-forever;
 * best-effort library intake; never blocks the turn (the battle surface shows the
 * empty-state silhouette until this lands).
 */
export async function runEnemyBodyImageJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const npcId = String(job.npcId || "").trim();
  if (!runId || !npcId) {
    return { ok: false, reason: "missing runId or npcId" };
  }
  const linked = ensureNpcImageAssets(runId, npcId, { style: job.style });
  if (!linked || !linked.enemyBody) {
    return { ok: false, reason: "run or npc not found" };
  }
  const run = getSoloRun(runId);
  const existing = run?.imageAssets?.[linked.enemyBody] || null;
  if (existing && existing.status === "generated" && typeof existing.uri === "string" && existing.uri) {
    return { ok: true, enemyBody: { slot: "enemyBody", ok: true, uri: existing.uri, reused: true } };
  }
  const npc = run?.npcs?.[npcId] || null;
  const statBlockId = npc?.statBlockId || npc?.flags?.statBlockId || null;
  const block = resolveStatBlock(statBlockId);
  const prompt = String(job.basePrompt || buildEnemyBodyPrompt(block, run?.world?.tone) || "").trim();
  if (!prompt) {
    return { ok: false, reason: "no stat block to mint from" };
  }
  const style = job.style ? String(job.style).trim() : "";
  const enemyBody = await generateSlot({
    runId,
    npcId,
    slot: "enemyBody",
    assetId: linked.enemyBody,
    prompt,
    style,
    kind: "fullbody",
    ...VN_BODY_DIMENSIONS
  });
  if (enemyBody.ok && enemyBody.bytes) {
    intakeToLibrary({
      id: `live_${runId}_${npcId}_enemyBody`,
      bytes: enemyBody.bytes,
      kind: "fullbody",
      run,
      subjectId: npcId,
      promptUsed: prompt,
      workflow: enemyBody.workflow,
      provider: enemyBody.provider || null,
      extraTags: ["pose:standing", "enemy", `statblock:${statBlockId || "?"}`]
    });
  }
  return { ok: enemyBody.ok, enemyBody };
}

export function enqueueEnemyBodyImageJob(job = {}) {
  if (!job || !job.runId || !job.npcId) {
    return;
  }
  queue.push({ kind: "enemyBody", runId: job.runId, npcId: job.npcId, style: job.style, basePrompt: job.basePrompt });
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
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
    pronouns: isStr(character.pronouns) ? character.pronouns.trim() : null,
    gender: isStr(character.gender) ? character.gender.trim() : null,
    ageClass: isStr(character.ageClass) ? character.ageClass.trim() : null,
    // Declared build (identity-as-state) — carried through so the build token reaches
    // the weighted player prompt alongside gender/age.
    bodyType: isStr(character.bodyType) ? character.bodyType.trim() : null,
    origin: isStr(character.origin) ? character.origin.trim() : null
  };
}

// AGE LAW (anime/nihilmania checkpoints default to ~young ~22yo without WEIGHTED
// adult words — blocks/darkfantasy.json laneRule) + gender lock (anime checkpoints
// are female-biased; a male MC renders female without an explicit male token, and
// the player's gender otherwise never reaches the prompt). Weighted, per the law.
// DECLARED IDENTITY is the SOLE source of the gender token — never inferred token
// soup: gender derives from the committed pronouns (he→man, she→woman), and an
// age-class field (elderly/young) modifies the weighted age word (never minor).
function adultGenderPhrase(c = {}) {
  const g = String(c.gender || "").toLowerCase();
  const p = String(c.pronouns || "").toLowerCase();
  const age = String(c.ageClass || "").toLowerCase();
  let noun = null;
  if (/\b(man|male|boy|masc)/.test(g) || /\b(he|him|his)\b/.test(p)) noun = "man";
  else if (/\b(woman|female|girl|femme)/.test(g) || /\b(she|her|hers)\b/.test(p)) noun = "woman";
  // AGE REGISTER (owner tuning 2026-07-20): "mature adult" landed the anime lane ~50s.
  // The declared intent for a default adult is a 30s register — a clear adult (anti-minor
  // guard holds via AGE_NEGATIVE_LAW) who is NOT middle-aged. Pronoun-aware, stated
  // positively. ageClass is ALREADY declared state (young|adult|elderly); a finer numeric
  // age field is ledgered as the next identity-as-state slot (parallel to gender/build).
  const poss = noun === "man" ? "his" : noun === "woman" ? "her" : "their";
  let ageWord = "adult";
  let anchor = noun
    ? `a ${noun} in ${poss} 30s, youthful adult, smooth unlined skin`
    : "in their 30s, youthful adult, smooth unlined skin";
  if (/eld|old|senior|aged/.test(age)) { ageWord = "elderly"; anchor = "older adult, aged features, weathered"; }
  else if (/young/.test(age)) { ageWord = "young adult"; anchor = noun ? `a ${noun} in ${poss} early 20s, youthful` : "in early 20s, youthful"; }
  return noun ? `(${ageWord} ${noun}:1.3), ${anchor}` : `(${ageWord}:1.3), ${anchor}`;
}

// ── DECLARED BUILD / BODY TYPE (identity-as-state, parallel to gender) ───────
// The declared bodyType field is the SOLE source of the build token — every
// player-render path derives it from the field, never from freehand prompt soup.
// "average" and legacy-unset both render NEUTRAL (no token: average IS the model's
// default human build). The other classes emit a short weighted build descriptor;
// a custom free-text value passes through (sanitized, weighting punctuation stripped).
// The weight (1.2) sits BELOW the gender anchor (1.3) so the build colors the figure
// without fighting the gender/quality register (the owner's cfg-3.5 JANKU laws).
const BUILD_VOCAB = {
  slim: "slender slim build",
  average: "",
  athletic: "athletic toned build",
  muscular: "muscular build, broad shoulders",
  heavyset: "heavyset build, stocky and broad"
};
// The build token for a committed field value: a canonical class → its per-lane
// vocab (EXACT match — the 5 declared classes); average/unset → "" (neutral); any
// other value is a CUSTOM free-text entry, passed through verbatim (weighting
// punctuation stripped, " build" appended when it reads as a bare adjective). Custom
// text is NOT synonym-normalized here — the refine parser + NPC mint already map
// synonyms to a class, so a value reaching this point is either canonical or the
// player's own words, which must survive.
function buildToken(bodyType) {
  const s = String(bodyType || "").trim().toLowerCase();
  if (!s || s === "average") return "";
  if (s in BUILD_VOCAB) return BUILD_VOCAB[s];
  const clean = s.replace(/[()[\]:<>{}|]/g, "").replace(/\s{2,}/g, " ").trim();
  if (!clean) return "";
  return /(build|frame|physique|figure|body|stature)/.test(clean) ? clean : `${clean} build`;
}
// The declared build as a prompt fragment. weighted → for the player lanes (the
// weighted-token discipline); bare → NPC/tailor prose. "" when neutral.
export function bodyTypePhrase(c = {}, { weighted = false } = {}) {
  const tok = buildToken(c?.bodyType);
  if (!tok) return "";
  return weighted ? `(${tok}:1.2)` : tok;
}
// Join a build fragment onto a base with a comma when present (keeps builders tidy).
function withBuild(base, c, opts) {
  const b = bodyTypePhrase(c, opts);
  return b ? `${base}, ${b}` : base;
}

// ── IDENTITY-AS-STATE (2026-07-18 refine-inverts-gender fix) ─────────────────
// A "refine" edit like "Male character" must not fight unweighted tail token-soup
// (the old editImage `${prompt}, ${tweak}` merge). It UPDATES the committed
// identity field (pronouns/gender/age-class), then the prompt is REBUILT from
// state with the WEIGHTED gender token + opposite-gender purge (the negative,
// added in comfyui.sealPortraitPrompt). Only identity-class tokens are parsed as
// field changes; everything else stays a freeform visual tweak.
const ID_MALE_RE = /\b(male|man|men|boy|masculine|guy|dude|gentleman|he\/him|he|him)\b/i;
const ID_FEMALE_RE = /\b(female|woman|women|girl|feminine|lady|gal|she\/her|she|her|hers)\b/i;
const ID_NB_RE = /\b(non-?binary|enby|androgynous|they\/them|gender-?neutral)\b/i;
const ID_OLD_RE = /\b(old|older|elderly|aged|senior)\b/i;
const ID_YOUNG_RE = /\b(young|younger|youthful)\b/i;
// DECLARED BUILD detectors (refine → bodyType field). Precise build words only —
// no bare "heavy/broad/large/round" (they collide with coat/smile/eyes/face). Checked
// most-specific-first (average-build last) in parseIdentityEdit.
const ID_BUILD_SLIM_RE = /\b(slim(mer)?|slender|thin(ner)?|lean(er)?|skinny|petite|willowy|lanky|waifish)\b/i;
const ID_BUILD_ATHLETIC_RE = /\b(athletic|fit|toned|sporty|lithe|trim(mer)?)\b/i;
const ID_BUILD_MUSCULAR_RE = /\b(muscular|muscley|buff(er)?|brawny|jacked|ripped|burly|beefy|bulkier|hulking)\b/i;
const ID_BUILD_HEAVY_RE = /\b(heavy-?set|stockier?|chubby|plump|portly|thickset|husky|overweight|fat(ter)?|heavier)\b/i;
const ID_BUILD_AVG_RE = /\b(average|normal|medium|ordinary)\s+(build|body|frame|physique)\b/i;
// Identity words stripped from the freeform remainder once absorbed into a field.
const ID_STRIP_RE = /\b(male|female|man|men|woman|women|boy|girl|masculine|feminine|masc|femme|guy|dude|gentleman|lady|gal|non-?binary|enby|androgynous|gender-?neutral|he\/him|she\/her|they\/them|\bhe\b|\bhim\b|\bshe\b|\bher\b|\bhers\b|old|older|elderly|aged|senior|young|younger|youthful|slim(mer)?|slender|thin(ner)?|lean(er)?|skinny|petite|willowy|lanky|waifish|athletic|fit|toned|sporty|lithe|trim(mer)?|muscular|muscley|buff(er)?|brawny|jacked|ripped|burly|beefy|bulkier|hulking|heavy-?set|stockier?|chubby|plump|portly|thickset|husky|overweight|fat(ter)?|heavier|build|physique|body\s*type|character|gender|make(?:\s+(?:the\s+)?(?:character|them|him|her|it))?|turn\s+(?:the\s+)?(?:character|them|him|her|it)?\s*into|a|an|the|into)\b/gi;

export function pronounsToGender(pronouns) {
  const s = String(pronouns || "").toLowerCase();
  if (/\b(he|him|his)\b/.test(s)) return "male";
  if (/\b(she|her|hers)\b/.test(s)) return "female";
  if (/\b(they|them|their)\b/.test(s)) return "nonbinary";
  return null;
}

// Parse a refine instruction into declared-field changes + the freeform remainder.
export function parseIdentityEdit(instruction) {
  const raw = String(instruction || "").trim();
  const t = raw.toLowerCase();
  let pronouns = null;
  if (ID_NB_RE.test(t)) pronouns = "they/them";
  else if (ID_MALE_RE.test(t)) pronouns = "he/him";
  else if (ID_FEMALE_RE.test(t)) pronouns = "she/her";
  let ageClass = null;
  if (ID_OLD_RE.test(t)) ageClass = "elderly";
  else if (ID_YOUNG_RE.test(t)) ageClass = "young-adult";
  // DECLARED BUILD — a build-class word in the edit UPDATES the bodyType field
  // (identity-as-state), most-specific-first so "average build" doesn't shadow a
  // real class. average-build maps to "average" (the neutral default field value).
  let bodyType = null;
  if (ID_BUILD_AVG_RE.test(t)) bodyType = "average";
  else if (ID_BUILD_MUSCULAR_RE.test(t)) bodyType = "muscular";
  else if (ID_BUILD_HEAVY_RE.test(t)) bodyType = "heavyset";
  else if (ID_BUILD_ATHLETIC_RE.test(t)) bodyType = "athletic";
  else if (ID_BUILD_SLIM_RE.test(t)) bodyType = "slim";
  let freeform = raw;
  if (pronouns || ageClass || bodyType) {
    freeform = raw.replace(ID_STRIP_RE, " ").replace(/[\s,]{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
  }
  return { pronouns, gender: pronouns ? pronounsToGender(pronouns) : null, ageClass, bodyType, freeform };
}

// Apply the parsed identity to a character, returning the updated character (state),
// the freeform remainder, and whether any identity field changed.
export function applyIdentityEdit(character = {}, instruction = "") {
  const parsed = parseIdentityEdit(instruction);
  const changed = Boolean(parsed.pronouns || parsed.ageClass || parsed.bodyType);
  const updated = { ...character };
  if (parsed.pronouns) {
    updated.pronouns = parsed.pronouns;
    updated.gender = parsed.gender;
  }
  if (parsed.ageClass) {
    updated.ageClass = parsed.ageClass;
  }
  if (parsed.bodyType) {
    updated.bodyType = parsed.bodyType;
  }
  return { character: updated, freeform: parsed.freeform, changed, identity: { pronouns: updated.pronouns || null, gender: updated.gender || null, ageClass: updated.ageClass || null, bodyType: updated.bodyType || null } };
}

// Canon player identity: the Babel authored origin "The Beckoned" is a modern-day
// Earth human pulled into the fantasy world (isekai champion), NOT a native
// high-fantasy race. Without an explicit modern-Earth cue, the fantasy tone +
// painterly framing defaults the figure to a generic fantasy elf (the 2026-07-08
// portrait-canon bug). When the origin is Beckoned we frame a present-day human
// and override any fantasy race default with a hard elf/fantasy negation.
const BECKONED_ORIGIN_RE = /beckoned/i;
function isBeckonedOrigin(origin) {
  return BECKONED_ORIGIN_RE.test(String(origin || ""));
}
const MODERN_EARTH_SUBJECT =
  "a present-day modern Earth human, ordinary contemporary real-world person, modern casual clothing";
// ANIME variant (append: the Beckoned MUST render as CEL-SHADED ANIME, not western
// semi-realism). Keep the modern-dress CANON, drop the "real-world / ordinary /
// realistic person" tokens that pull JANKU toward a naturalistic western-comic face.
// The Beckoned IS an isekai protagonist (a modern person pulled into another world) —
// the single most anime-native framing for JANKU. Anchoring on "isekai protagonist,
// modern anime character" (NOT "modern Earth human / present-day person / real-world",
// which read photographic and, at the low validated cfg 3.5, drift JANKU to a 2.5D/3D
// render — the required-picker regression 2026-07-20) keeps the modern-dress CANON
// while making the cel register win. Weighted so it dominates the realism pull.
const MODERN_EARTH_SUBJECT_ANIME =
  "(isekai protagonist:1.2), modern anime character in contemporary casual clothing, present-day outfit";
// POSITIVE identity emphasis (NOT a negation). The live image path serves through
// pollinations/flux, which is POSITIVE-PROMPT-ONLY — it has no negative-prompt
// field, so a "NOT pointed elf ears" clause fed here renders the literal words
// "elf ears" as tokens and BACKFIRES (the 2026-07-17 elf-ears report). Canon must
// therefore reach the image as POSITIVE assertions: state the human/contemporary
// identity plainly, no "NOT …" phrasing, no "elf" token.
const MODERN_EARTH_EMPHASIS =
  "ordinary human with naturally rounded ears, natural human face, plain contemporary real-world appearance";
// ANIME variant: keep the anti-elf rounded-ear assertion + modern framing, drop the
// "natural human face / plain real-world appearance" realism pulls (the elf defense
// negative still suppresses elf ears). Lets the anime dialect win the render.
const MODERN_EARTH_EMPHASIS_ANIME =
  "(anime style:1.3), (cel shaded:1.2), flat anime coloring, clean bold lineart, rounded human ears, modern anime character design";

// Shared prompt for the player + draft full-body character-sheet portrait.
// Visual descriptors for the 10 creator races. Naming a race alone (e.g.
// "Aasimar") lets the model default to a generic fantasy-elf; spelling out the
// distinctive VISUAL traits makes uncommon races render true to type. Keyed by
// lowercased race name (Human is intentionally empty — already the default).
const RACE_VISUAL_DESCRIPTORS = {
  // Only Elf and Half-Elf have pointed ears. Every other race states "rounded human
  // ears" POSITIVELY — the live path is pollinations (positive-prompt-only), so a
  // "NOT pointed elf ears" clause would render the "elf" token literally and
  // backfire (the 2026-07-17 elf-ears report). Assert the rounded-ear trait, never
  // negate the elf trait.
  human: "ordinary human person, naturally rounded human ears, natural human face",
  elf: "pointed ears, slender graceful build, ageless angular face",
  dwarf: "short and stocky, thick braided beard, broad rugged features, rounded human ears",
  halfling: "small in stature, youthful round face, curly hair, rounded human ears",
  gnome: "small in stature, large bright eyes, oversized expressive features, rounded ears",
  "half-orc": "muscular build, greenish-grey skin, jutting lower tusks, heavy brow, rounded ears",
  tiefling: "curved horns, long pointed tail, red or violet skin, solid glowing eyes, rounded human-like ears",
  dragonborn: "draconic scaled head, reptilian snout, hairless, scaled skin, no external ears",
  "half-elf": "subtly pointed ears, a refined blend of human and elven features",
  aasimar: "celestial human, rounded human ears, luminous glowing eyes, radiant otherworldly skin, faint halo of light, human facial structure"
};

// The only races that should render with pointed ears. Every other race gets a
// trailing "NOT pointed elf ears" emphasis in the player prompt (see below).
const POINTED_EAR_RACES = new Set(["elf", "half-elf"]);

// W6: THE human-ear assertion — the SINGLE canonical clause every human-kind origin
// (Beckoned/isekai included) routes through, so the elf-defense negative always fires
// (comfyui.elfDefenseFor keys on "rounded human"). Positive assertion, never a "NOT elf"
// negation (the pollinations positive-only lesson). One string → one test can prove
// every origin carries it.
const HUMAN_EAR_CLAUSE = "with naturally rounded human ears and a natural human face";

function raceVisualDescriptor(race) {
  return RACE_VISUAL_DESCRIPTORS[String(race || "").trim().toLowerCase()] || "";
}

export function buildPlayerPortraitPrompt(character = {}, world = {}) {
  const c = normalizePortraitCharacter(character);
  const tone = isStr(world.tone) ? world.tone.trim() : "dark fantasy";
  // Engine art style via the ONE reconciliation reader (artStyleOptions.default
  // first, legacy world.artStyle as fallback) — never compare the legacy string here.
  const engineStyle = engineStyleForRun(null, world);
  // Canon-origin override: The Beckoned is a modern-Earth human champion, not a
  // fantasy race. Frame a present-day person "out of place" in the fantasy tone
  // and hard-negate the elf/fantasy default (which the medium framing otherwise
  // reintroduces). Origin comes from the character record (run.player.origin).
  const origin = c.origin || (isStr(world.origin) ? world.origin.trim() : null);
  if (isBeckonedOrigin(origin)) {
    // The Babel creator fills BOTH race and class slots with the origin string
    // ("The Beckoned") as placeholders (src/main.js). Drop any class/background
    // that is really just the origin echoed back, so it never reads as a class.
    const realClass = c.characterClass && !isBeckonedOrigin(c.characterClass) ? c.characterClass : null;
    const realBackground = c.background && !isBeckonedOrigin(c.background) ? c.background : null;
    // Anime lane renders the Beckoned as cel-shaded anime (modern-dress, not realism).
    const isAnime = engineStyle === "anime";
    const subjectPhrase = isAnime ? MODERN_EARTH_SUBJECT_ANIME : MODERN_EARTH_SUBJECT;
    const emphasis = isAnime ? MODERN_EARTH_EMPHASIS_ANIME : MODERN_EARTH_EMPHASIS;
    const beckonedSubject =
      [
        c.name ? `${c.name},` : null,
        c.pronouns ? `${c.pronouns},` : null,
        subjectPhrase + ",",
        realClass,
        realBackground ? `${realBackground} background` : null
      ]
        .filter(Boolean)
        .join(" ") || subjectPhrase;
    // The "newcomer" clause is lane-aware: the anime lane frames the arrival as isekai
    // (anime-native) rather than "a modern-day person" (a photographic realism pull).
    const newcomerClause = isAnime
      ? `an isekai protagonist newly arrived in a ${tone} world`
      : `a modern-day person newly pulled into a ${tone} world`;
    // W6: the Beckoned is ALWAYS a modern-Earth HUMAN — route it through the same
    // canonical human-ear assertion as every other human origin, so the elf defense
    // fires (it was a residual-elf-ears 1/3 on the isekai/anime lane otherwise).
    return (
      `character portrait of ${beckonedSubject}, ${withBuild(adultGenderPhrase(c), c, { weighted: true })}, ${newcomerClause}, ` +
      `${artStyleDirection(engineStyle, "player")}, ${emphasis}, ${HUMAN_EAR_CLAUSE}`
    );
  }
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
  // Pointed ears belong ONLY to elves/half-elves. For every other race — AND when
  // no race is set (the default is Human) — assert rounded human ears POSITIVELY.
  // (Positive, not a "NOT elf" negation: the live pollinations path is positive-
  // prompt-only and would otherwise render the negated "elf" token literally.)
  const earEmphasis = !POINTED_EAR_RACES.has(raceKey)
    ? `, ${HUMAN_EAR_CLAUSE}`
    : "";
  return `character portrait of ${subject}, ${withBuild(adultGenderPhrase(c), c, { weighted: true })}, ${tone}, ${artStyleDirection(engineStyle, "player")}${earEmphasis}`;
}

// Deterministic seed from name+race+class+artStyle so identical core choices
// reproduce the same image, while a different art style yields a different seed
// (so deterministic providers like Pollinations don't return the prior style's
// image). Independent of the draft-namespace id below.
function playerPortraitSeed(character = {}, world = {}) {
  const c = normalizePortraitCharacter(character);
  const style = engineStyleForRun(null, world);
  // Include origin: switching to/from The Beckoned changes the prompt materially,
  // so it must yield a different seed (deterministic providers key off the seed).
  return hashOf(`${c.name || ""}|${c.race || ""}|${c.characterClass || ""}|${c.origin || ""}|${style}`);
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
  const style = engineStyleForRun(null, world);
  const tone = isStr(world?.tone) ? world.tone.trim().toLowerCase() : "";
  // An edit instruction (conversational portrait editor) is part of the produced
  // image, so it joins the cache namespace — two different tweaks at the same
  // nonce must not collide on one draftId.
  const edit = String(editTag || "").trim().toLowerCase();
  // RECIPE VERSION (cache hygiene, 2026-07-20): the sealed-prompt/blocks/export epoch is
  // part of the produced image, so it MUST be part of the cache namespace. Without it, a
  // new character whose base params hash to a PRE-SEAL id re-serves the stale cached file
  // (the owner's Jul-18 "mustard bust" collision). Folding ART_RECIPE_VERSION in makes all
  // pre-bump cache unreachable by construction — bump the version, never archaeology.
  const base = `rv:${ART_RECIPE_VERSION}|${c.name || ""}|${c.race || ""}|${c.characterClass || ""}|${c.background || ""}|${c.pronouns || ""}|${style}|${tone}${edit ? `|e:${edit}` : ""}`;
  // A redo nonce (>0) yields a fresh namespace so the disk cache is bypassed and
  // a NEW image is generated. nonce 0 keeps a stable id for a given combo, so
  // first-generation and carry-forward behaviour are unchanged.
  const n = Math.trunc(Number(nonce) || 0);
  // STALE-BY-LAW (owner clause 2026-07-20): the recipe epoch rides the id as a PLAIN,
  // checkable prefix — `draft_<rvSlug>_<hash>` — so the serve path can tell a
  // pre-current-recipe draft from a current one WITHOUT re-hashing. A live draft whose
  // epoch != current is destroyed and re-cooked on next view (see getDraftPortrait).
  return `draft_${recipeVersionSlug()}_${hashOf(n > 0 ? `${base}|n${n}` : base)}`;
}

// The current recipe epoch as a filesystem/id-safe slug (e.g. "2026-07-20c" -> "20260720c").
function recipeVersionSlug() {
  return String(ART_RECIPE_VERSION).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// A draft id carries its recipe epoch as `draft_<rvSlug>_<hash>`. STALE-BY-LAW: a draft
// whose epoch != current — OR the old prefix-less `draft_<hash>` format (pre-clause) — is
// pre-current-recipe art and must never survive on an active surface. True only for a
// current-epoch id.
export function draftIsCurrentRecipe(draftId) {
  const id = String(draftId || "");
  // UPLOADED portraits (draft_upload_*) are the player's OWN file, not recipe-cooked —
  // the recipe epoch does not apply, so they are never stale-by-recipe.
  if (/^draft_upload_/.test(id)) return true;
  const m = /^draft_([a-z0-9]+)_[0-9a-z]+$/i.exec(id);
  return Boolean(m) && m[1] === recipeVersionSlug();
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
async function generateSlot({ runId, npcId, slot, assetId, prompt, style, kind, referenceImageUrl, seed, width, height }) {
  try {
    // GAP 1: `kind` (portrait/scene/fullbody/item) routes the provider to the
    // validated per-lane recipe; referenceImageUrl drives the face-ref tailor.
    const result = await generateImage({ prompt, style, kind, referenceImageUrl, seed, width, height });
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
    // Return bytes + the serving workflow AND the serve-attribution (provider) so
    // the caller can do library intake (GAP 2) with the real recipe attribution.
    // provider is what the intake provenance guard checks: only the validated
    // comfyui path may be pooled; a pollinations/cloudflare failover must not.
    return { slot, ok: true, uri, bytes, workflow: result?.workflow || null, provider: result?.provider || null };
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
// #50: ground the NPC portrait in the COMMITTED gender + description CLI 1 exposes
// on the entity, so "Mara (female)" renders a woman rather than the base model's
// default. Reads gender/sex, falling back to pronouns; description falls back to
// appearance. Best-effort — returns "" when the entity carries nothing to ground.
export function npcGroundingClause(npc) {
  if (!npc || typeof npc !== "object") {
    return "";
  }
  const gender = String(npc.gender || npc.sex || "").trim().toLowerCase();
  const pronouns = String(npc.pronouns || "").trim().toLowerCase();
  let genderWord = "";
  if (/\b(female|woman|girl|f)\b/.test(gender) || /\b(she|her)\b/.test(pronouns)) {
    genderWord = "a woman";
  } else if (/\b(male|man|boy|m)\b/.test(gender) || /\b(he|him)\b/.test(pronouns)) {
    genderWord = "a man";
  } else if (/non-?binary|enby|androgynous|they/.test(gender) || /\b(they|them)\b/.test(pronouns)) {
    genderWord = "an androgynous person";
  }
  // Declared build rides too (NPC bodyType, unweighted prose) so committed cast
  // shape is honored — a "heavyset" reeve isn't re-rolled slim by the checkpoint prior.
  const build = bodyTypePhrase(npc, { weighted: false });
  const description = String(npc.description || npc.appearance || "").trim();
  return [genderWord, build, description].filter(Boolean).join(", ");
}

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
  const rawBasePrompt = String(
    job.basePrompt ||
    npc?.portraitPrompt ||
    `portrait of a ${npc?.role || npcId}, dark fantasy, detailed`
  ).trim();
  // #50: prepend the committed gender/description grounding (unless the prompt
  // already opens with it) so the rendered portrait matches the committed entity.
  const grounding = npcGroundingClause(npc);
  const basePrompt = grounding && !rawBasePrompt.toLowerCase().includes(grounding.toLowerCase())
    ? `${rawBasePrompt}, ${grounding}`
    : rawBasePrompt;

  // Base portrait anchors every variant. If a base already exists (e.g. a user
  // upload marked "generated"), reuse it instead of regenerating; otherwise
  // produce it via text-to-image.
  const baseAsset = run?.imageAssets?.[linked.base] || null;
  let base;
  if (baseAsset && baseAsset.status === "generated" && typeof baseAsset.uri === "string" && baseAsset.uri) {
    base = { slot: "base", ok: true, uri: baseAsset.uri, reused: true };
  } else {
    const prompt = `${basePrompt}, neutral expression, ${artStyleDirection(style, "npc")}`;
    base = await generateSlot({
      runId,
      npcId,
      slot: "base",
      assetId: linked.base,
      prompt,
      style,
      kind: "portrait",
      seed,
      referenceImageUrl: null,
      ...PORTRAIT_DIMENSIONS
    });
    // GAP 2: land the NPC bust in the library (kind portrait).
    if (base.ok && base.bytes) {
      intakeToLibrary({
        id: `live_${runId}_${npcId}_base`,
        bytes: base.bytes,
        kind: "portrait",
        run,
        subjectId: npcId,
        promptUsed: prompt,
        workflow: base.workflow,
        provider: base.provider || null,
        extraTags: ["expr:neutral"]
      });
    }
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

  // FACE-REF FULLBODY: if the NPC has a committed bust portrait, hand it to the
  // provider as the IPAdapter face reference so the sprite reads as the same
  // character (the tailor path fires only when a validated tailor export exists
  // for the run's style — realistic; anime/dark-fantasy/sketch have no tailor, so
  // this degrades to a fresh txt2img standing sprite, never blocking).
  const bustAsset = run?.imageAssets?.[linked.base] || null;
  const faceRef = bustAsset && bustAsset.status === "generated" && typeof bustAsset.uri === "string" && bustAsset.uri
    ? bustAsset.uri
    : null;
  const prompt = `${basePrompt}, ${vnBodyArtDirection(tone)}`;
  const vnBody = await generateSlot({
    runId,
    npcId,
    slot: "vnBody",
    assetId: linked.vnBody,
    prompt,
    style,
    kind: "fullbody",
    seed,
    referenceImageUrl: faceRef,
    ...VN_BODY_DIMENSIONS
  });
  // GAP 2: land the fullbody sprite in the library (kind fullbody). identityRef
  // links it to the bust it was tailored from when a face ref was used.
  if (vnBody.ok && vnBody.bytes) {
    intakeToLibrary({
      id: `live_${runId}_${npcId}_vnBody`,
      bytes: vnBody.bytes,
      kind: "fullbody",
      run,
      subjectId: npcId,
      promptUsed: prompt,
      workflow: vnBody.workflow,
      provider: vnBody.provider || null,
      extraTags: ["pose:standing", ...(faceRef ? ["face-ref"] : [])]
    });
  }
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
  const style = engineStyleForRun(run, run.world);

  // Merge the full character record with the mirrored run.player.* fallbacks,
  // then build the prompt + seed via the shared player-portrait helpers (same
  // ones the draft/mid-creation path uses, so a from-scratch run portrait
  // matches what the creator previewed).
  const merged = {
    name: character.name || player.displayName || null,
    race: character.race || player.race || null,
    class: character.class || player.className || player.characterClass || null,
    background: character.background || player.background || null,
    pronouns: character.pronouns || player.pronouns || null,
    // Canon origin (The Beckoned = modern-Earth human) drives the modern-Earth
    // portrait framing over any fantasy race default.
    origin: character.origin || player.origin || null
  };
  const prompt = buildPlayerPortraitPrompt(merged, run.world || {});
  const seed = playerPortraitSeed(merged, run.world || {});

  try {
    // The player portrait is a portrait-kind → routes through the validated
    // portrait recipe for the run's style.
    const result = await generateImage({ prompt, style, kind: "portrait", seed, ...PLAYER_PORTRAIT_DIMENSIONS });
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
    // GAP 2: land the player portrait in the library (kind portrait).
    intakeToLibrary({
      id: `live_${runId}_player`,
      bytes,
      kind: "portrait",
      run,
      subjectId: "player",
      promptUsed: prompt,
      workflow: result?.workflow || null,
      provider: result?.provider || null
    });
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
  const editInstruction = typeof job.editInstruction === "string" ? job.editInstruction.trim() : "";
  const sourceImageUrl = typeof job.sourceImageUrl === "string" ? job.sourceImageUrl.trim() : "";
  // IDENTITY-AS-STATE (2026-07-18): a refine edit's identity-class tokens ("male",
  // "she", "older") UPDATE the committed character; the prompt is REBUILT from that
  // state with the WEIGHTED gender token — it never fights an unweighted tail
  // append. Only the non-identity remainder stays a freeform visual tweak. This is
  // the SINGLE path — same builder + validated per-lane recipe (kind:"portrait") +
  // sealPortraitPrompt as draft/live; the parallel `${prompt}, ${tweak}` merge is gone.
  const applied = editInstruction ? applyIdentityEdit(character, editInstruction) : { character, freeform: "", changed: false };
  const effChar = applied.character;
  const freeform = String(applied.freeform || "").trim();
  const prompt = buildPlayerPortraitPrompt(effChar, world);
  const style = engineStyleForRun(null, world);
  // Offset the deterministic seed by the redo nonce so a reroll produces a
  // genuinely different image (not the same one under a fresh id). Seed also
  // varies by art style so a style change yields a different image. An identity
  // edit shifts the seed too (the prompt materially changed).
  const seed = playerPortraitSeed(effChar, world) + Math.trunc(Number(job.nonce) || 0) * 100003 + (applied.changed ? 991 : 0);

  try {
    // A FREEFORM visual tweak (scar, hair) routes through editImage (kontext-first
    // edit of the current portrait, regenerate fallback) on the identity-correct
    // rebuilt base — now with kind:"portrait" so it uses the SAME validated recipe.
    // An identity-only edit OR a plain generation/redo generates cleanly from state
    // (kind:"portrait" → portrait-<style>.json + sealPortraitPrompt).
    const appearance = typeof job.appearance === "string" ? job.appearance : "";
    const avoid = typeof job.avoid === "string" ? job.avoid : "";
    const result = freeform
      ? await editImage({ sourceImageUrl, instruction: freeform, prompt, style, kind: "portrait", seed, appearance, avoid, ...PLAYER_PORTRAIT_DIMENSIONS })
      : await generateImage({ prompt, style, kind: "portrait", seed, appearance, avoid, ...PLAYER_PORTRAIT_DIMENSIONS });
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
    // REDO-DESTROYS-PREDECESSOR: the replacement has landed — destroy the superseded
    // draft now (file + record). Exactly the live one survives.
    const supersedes = typeof job.supersedes === "string" ? job.supersedes.trim() : "";
    if (supersedes && supersedes !== draftId) destroyDraftAssets(supersedes);
    return { ok: true, uri };
  } catch (error) {
    const reason = classifyImageFailure(error);
    // ASSET LIFECYCLE LAW (owner 2026-07-20): a failed job is GARBAGE — destroy any
    // partial output on the spot (file + dir), never retain-with-a-flag. The in-memory
    // status carries the classified reason for the card; the disk keeps nothing.
    try {
      const dir = path.join(assetsRoot(), String(draftId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort cleanup — never mask the real failure */ }
    draftPortraits.set(draftId, { status: "failed", uri: null, reason });
    logWorker(`draft portrait failed for ${draftId}`, error);
    return { ok: false, reason };
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
  // STALE-BY-LAW (owner clause 2026-07-20): a live draft older than the current recipe
  // epoch must NOT survive on an active surface — the lifecycle "live plate" exemption
  // does not cover pre-current-recipe art. Destroy it and report a classified refresh so
  // the client re-cooks fresh on next view (a new request mints a current-epoch id).
  if (!draftIsCurrentRecipe(id)) {
    destroyDraftAssets(id);
    return { status: "failed", uri: null, reason: "That portrait was from an older art recipe — cooking a fresh one." };
  }
  const mem = draftPortraits.get(id);
  if (mem) {
    // SERVE-ONLY-LIVE (asset lifecycle law): a "generated" entry whose file was DESTROYED
    // (superseded by a redo, or swept) is no longer a live asset — never serve its dead
    // uri. Drop the stale entry and report not-found so the caller regenerates cleanly.
    if (mem.status === "generated" && !findDraftPortraitOnDisk(id)) {
      draftPortraits.delete(id);
    } else {
      return { status: mem.status, uri: mem.uri || null, reason: mem.reason || null };
    }
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
// CANON fragment for a scene prompt: the FIRST sentence of the committed location
// description, sanitized to plain words and capped. This is the load-bearing fix
// for off-canon scene art (a WW2 biplane in a modern-arcane Pacific-NW zone): a
// poetic location NAME alone ("The Green Static — Fringe") under-constrains the
// image model, which then invents off-world content. The committed description
// carries the real setting/era, so it must reach the prompt.
export function locationCanonFragment(location = {}) {
  const desc = typeof location.description === "string" ? location.description : "";
  if (!desc.trim()) {
    return "";
  }
  const firstSentence = desc.split(/(?<=[.!?])\s/)[0] || desc;
  return firstSentence.replace(/\s+/g, " ").trim().slice(0, 200);
}

// SCENE CANON-FROM-STATE (owner ruling 2026-07-19): do for scenes what 0462bb6 did
// for portraits — ONE builder fed from COMMITTED STATE as MANDATORY structured
// slots, not optional flavor. The location's OWN doc text is the source of truth,
// quote-mined deterministically (the corruption/unease lives PAST sentence 1 — the
// old first-sentence-only fragment produced generic postcards). Slots: canon
// description, danger register, committed weather/sky, world-clock time-of-day,
// era, and the TONE LAW (beautiful AND wrong). Framing/negatives ride the art
// direction + the seal.
function sceneCanonSubject(desc) {
  const d = String(desc || "").replace(/\s+/g, " ").trim();
  // Enough of the committed POI text to carry the corruption markers (shimmer,
  // spiral moss, wrong light), not just the opening clause.
  return d ? d.slice(0, 340) : "";
}
function sceneDangerRegister(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return "";
  if (n >= 4) return "oppressive dread, deadly stillness";
  if (n >= 3) return "tense, dangerous air";
  if (n >= 2) return "unsettled, on edge";
  if (n >= 1) return "wary quiet";
  return "";
}
function sceneWeatherFragment(run) {
  const w = deriveWeather(run);
  return ({ cloudy: "overcast sky", rain: "rain, wet ground", storm: "storm clouds, dark sky", snow: "falling snow", fog: "low fog, mist" })[w] || "";
}
function sceneTimeFragment(run) {
  const t = run?.world?.time || {};
  const phase = typeof t.phase === "string" ? t.phase : deriveClock(Number(t.minutes) || 0).phase;
  return ({ dawn: "dawn light, low sun", day: "flat daylight", dusk: "dusk, fading amber light", night: "night, pale moonlight" })[phase] || "";
}
function sceneEraFragment(era) {
  return /pacific northwest|modern|present|earth/i.test(String(era || "")) ? "present-day modern Earth setting" : "";
}
export function buildScenePrompt(run, location = {}, locationId = "") {
  const name = isStr(location?.name) ? location.name.trim() : locationId;
  const world = run?.world || {};
  const tone = isStr(world.tone) ? world.tone.trim() : "dark fantasy";
  const slots = [
    name,
    // MANDATORY MIDGROUND SUBJECT (owner ruling — the framing law over-corrected to
    // floor-only). A committed present entity LEADS the prompt as the subject, SPECIES-TRUE
    // and weighted (a wounded grey wolf beneath a tree), so the scene checkpoint's landscape
    // bias can't drop it to an empty clearing. Falls to a canon feature when none present.
    sceneEntitySubject(run, locationId || location?.locationId),
    sceneCanonSubject(location?.description),
    sceneWeatherFragment(run),
    sceneTimeFragment(run),
    sceneDangerRegister(location?.state?.dangerLevel),
    sceneEraFragment(world.era),
    // TONE LAW: the Verdance is beautiful AND wrong — a generic postcard is a FAIL.
    "beautiful yet subtly wrong, uneasy stillness, faint shimmer in the air, over-still water, off light",
    tone
  ];
  return slots.filter(Boolean).join(", ");
}

// INSP-09 CONSUMER (the open seam, now consumed): the committed VIOLET per-tier
// corruption art fragment for a present hostile — resolved from its stat block (authored
// rows like the Limping Grey), the run's persisted minted block (a rolled chaosling not
// yet re-registered after a restart), or the NPC's own committed corruption. "" when the
// creature is not corrupted. This is what makes a CORRUPTED wolf render VIOLET-marked in
// the scene, not a plain grey wolf (the empty-path fix's other half).
function corruptionArtFragment(run, npc, nat) {
  const fromBlock = nat?.block?.corruption?.artFragment;
  const statBlockId = nat?.statBlockId || npc?.statBlockId || npc?.flags?.statBlockId || null;
  const minted = statBlockId ? run?.mintedStatBlocks?.[statBlockId] : null;
  const fromMinted = minted?.corruption?.artFragment;
  const fromNpc = npc?.corruption?.artFragment || npc?.flags?.corruption?.artFragment;
  return String(fromBlock || fromMinted || fromNpc || "").trim();
}

// The species-true midground subject PHRASE for a committed present entity, carrying its
// violet corruption markers (INSP-09). A beast appears AS its species (a wolf, never a
// human); the phrase deliberately avoids the words human/person/man/woman so it does not
// trip the character-portrait detector (which would drop the scene framing guard).
function entitySceneSubject(run, npc) {
  const nat = entityNature(npc);
  if (!nat) return "";
  // The subject rides WEIGHTED so the checkpoint renders it — a mid-prompt species token
  // loses to the landscape bias (1-of-2 empty clearings in the proof); the emphasis lands it.
  const violet = corruptionArtFragment(run, npc, nat);
  const violetTail = violet ? `, ${violet}` : (nat.corrupted ? ", subtly corrupted, an uncanny wrongness" : "");
  if (nat.isAnimal) {
    const cond = nat.injured ? "wounded " : "";
    const sp = nat.species || "beast";
    return `(a single ${cond}${sp}:1.4), the clear midground subject, a four-legged ${sp} on all fours standing low on the ground beneath a tree, watchful, unmistakably a wild animal${violetTail}`;
  }
  if (nat.kind === "demon") return `(a single demonic figure:1.3), the clear midground subject, standing on the ground${violetTail}`;
  // human-kind: a lone person, midground (the negative human-ban is relaxed for these —
  // the "lone figure" phrase is the gate the sealer keys on, so keep it verbatim).
  return "(a single lone figure:1.25), the clear midground subject, standing on the ground";
}

// Committed entities PRESENT at a location (not gone/dead). Shared by the general scene
// subject (any present entity) and the hostile-only injector.
function presentSceneEntities(run, locationId) {
  const here = locationId || run?.currentLocationId;
  return Object.values(run?.npcs || {}).filter(
    (n) => n && n.currentLocationId === here && n.status !== "gone" && n.status !== "dead"
  );
}

// The species-true midground subject from a committed present entity — HOSTILE FIRST (a
// present threat is always the scene's subject), else any present entity. Returns "" when
// the location is empty of entities — then sceneCanonSubject carries the midground (a
// canon feature). Never invents people.
function sceneEntitySubject(run, locationId) {
  const present = presentSceneEntities(run, locationId);
  if (!present.length) return "";
  const npc = present.find((n) => n?.flags?.hostile === true) || present[0];
  return entitySceneSubject(run, npc);
}

// F5 — the committed PRESENT HOSTILE subject ONLY (flags.hostile). The LIVE location cook
// receives a canon-only basePrompt (buildLocationBasePrompt: "…wide establishing shot, no
// people") with NO subject, so a committed present hostile (the Limping Grey) otherwise
// rendered an EMPTY path. This species-true, violet-marked phrase is injected into that
// cook (runLocationImageJob). "" when no present hostile — then no injection (the scene
// keeps its canon-feature midground). Exported for the injection guard + the test.
export function sceneHostileSubject(run, locationId) {
  const hostile = presentSceneEntities(run, locationId).find((n) => n?.flags?.hostile === true);
  return hostile ? entitySceneSubject(run, hostile) : "";
}
function buildLocationPromptFallback(run, location, locationId) {
  return buildScenePrompt(run, location, locationId);
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
  // The run's selected art style: prefer an explicit job.style, else the BUTLER
  // (styleForRun's locked-choice → forbidden → world-default → house chain), mapped
  // to engine vocab for the live path. Drives BOTH the location art direction and
  // generateImage's medium cue, so an anime run yields an anime scene image.
  const style = (job.style && String(job.style).trim()) || engineStyleForRun(run, run.world);
  const seed = Number.isFinite(Number(job.seed)) ? Number(job.seed) : null;
  // Compose FOR the wide banner: the subject (caller prompt or fallback) plus the
  // STYLE-AWARE location art direction (per-style aesthetic + establishing-shot
  // composition), so the scene reads as a backdrop in the run's actual art style.
  const rawSubject = String(job.basePrompt || buildLocationPromptFallback(run, location, locationId)).trim();
  // F5 — SCENE HOSTILE INJECTION (+ INSP-09). The live caller (buildLocationBasePrompt)
  // passes a canon-only basePrompt with NO subject, so a committed PRESENT hostile (the
  // Limping Grey) rendered an EMPTY path. Inject the species-true hostile as the LEADING
  // midground subject + its violet corruption markers. DEDUPE: this only runs on a FRESH
  // cook (the job returned `skipped` above when the asset was already generated — the
  // guard against redrawing a served/library scene), and is skipped when the prompt
  // already carries the injected subject (the fallback builder path already added it).
  const hostileSubject = sceneHostileSubject(run, locationId);
  const subject = hostileSubject && !rawSubject.toLowerCase().includes("the clear midground subject")
    ? `${hostileSubject}, ${rawSubject}`
    : rawSubject;
  const locationDirection = artStyleDirection(style, "location");
  const prompt = subject ? `${subject}, ${locationDirection}` : locationDirection;
  // Filesystem-safe folder segment for this location's assets.
  const folder = `location_${locationId}`;

  try {
    // Location backgrounds are wide establishing shots -> the scene lane (routes
    // through the validated scene/landscape recipe for the run's style).
    const result = await generateImage({ prompt, style, kind: "scene", seed, ...LANDSCAPE_DIMENSIONS });
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
    // GAP 2: land the scene backdrop in the library (kind scene, loc:<slug> tag).
    intakeToLibrary({
      id: `live_${runId}_loc_${locationId}`,
      bytes,
      kind: "scene",
      run,
      subjectId: locationId,
      promptUsed: prompt,
      workflow: result?.workflow || null,
      provider: result?.provider || null
    });
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
  if (job && job.kind === "enemyBody") {
    return runEnemyBodyImageJob(job);
  }
  if (job && job.kind === "draft") {
    return runDraftPortraitJob(job);
  }
  return runImageJob(job);
}

async function drainQueue() {
  if (processing) {
    // WATCHDOG self-heal: if a prior drain wedged (hung past the ceiling), reclaim
    // it so newly-enqueued jobs are not dropped forever. Belt to the per-job
    // timeout's suspenders — covers any path that leaves `processing` stuck true.
    if (drainStartedAt && Date.now() - drainStartedAt > WEDGE_MS) {
      logWorker(`watchdog: reclaiming a wedged drain (stuck ${Date.now() - drainStartedAt}ms)`);
      processing = false;
    } else {
      return;
    }
  }
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      drainStartedAt = Date.now(); // per-job clock for the watchdog + health flag
      try {
        // eslint-disable-next-line no-await-in-loop
        await withTimeout(dispatchJob(job), JOB_TIMEOUT_MS, `image job (${job?.kind || "?"})`);
        lastError = null;
      } catch (error) {
        // A hang now TIMES OUT here instead of pinning the drain forever; the
        // underlying provider call self-aborts (fetchWithDeadline) in the void.
        lastError = { message: String(error?.message || error), at: new Date().toISOString() };
        logWorker(`job ${job?.kind || "?"} failed/timed out`, error);
      } finally {
        lastJobAt = Date.now();
        lastJobKind = job?.kind || null;
      }
    }
  } finally {
    processing = false;
    drainStartedAt = 0;
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
  // CHOICE-BEFORE-PIXELS (style-lock law) — HARD SERVER GUARD, not just UI ordering.
  // A draft portrait may NOT be generated before a style is committed on the world
  // context. A ready-made world card routed straight to character creation carries
  // no style until the player picks one in the Identity step; reject here so no
  // pixels ever render on a guessed default lane. The route surfaces this via the
  // classifyImageFailure reason ("Choose an art style …"); direct callers get a
  // typed STYLE_NOT_LOCKED throw.
  if (!hasCommittedArtStyle(world)) {
    throw Object.assign(
      new Error("art style is not locked — choose a style before the portrait can render"),
      { code: "STYLE_NOT_LOCKED", statusCode: 400 }
    );
  }
  // Redo nonce: bypasses the cache (new id) and varies the seed (new image).
  const nonce = Math.trunc(Number(job.nonce) || 0);
  // Conversational portrait editor: a tweak ("longer hair", "add a scar") applied
  // to the CURRENT portrait. editInstruction joins the cache id (so each tweak is
  // its own version) and routes generation through editImage (kontext-first edit
  // with a regenerate fallback) using sourceImageUrl as the base.
  const editInstruction = typeof job.editInstruction === "string" ? job.editInstruction.trim() : "";
  const sourceImageUrl = typeof job.sourceImageUrl === "string" ? job.sourceImageUrl.trim() : "";
  // REDO-DESTROYS-PREDECESSOR (asset lifecycle law): the draft this replaces. Its assets
  // are destroyed once THIS replacement lands (generated) — keep exactly the live one.
  const supersedes = typeof job.supersedes === "string" ? job.supersedes.trim() : "";
  const draftId = computeDraftPortraitId(character, nonce, world, editInstruction);

  // Idempotent: if already generated on disk, mark generated and skip the queue. The
  // replacement has "landed" instantly, so the predecessor is destroyed now.
  const existing = findDraftPortraitOnDisk(draftId);
  if (existing) {
    draftPortraits.set(draftId, { status: "generated", uri: existing.uri });
    if (supersedes && supersedes !== draftId) destroyDraftAssets(supersedes);
    return draftId;
  }

  // T8 preference slots ride the job to the sealed builder (additive; identity + safety win).
  const appearance = typeof job.appearance === "string" ? job.appearance : "";
  const avoid = typeof job.avoid === "string" ? job.avoid : "";
  draftPortraits.set(draftId, { status: "generating", uri: null });
  queue.push({ kind: "draft", draftId, character, world, nonce, editInstruction, sourceImageUrl, supersedes, appearance, avoid });
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
