// ---------------------------------------------------------------------------
// ComfyUI image provider adapter.
//
// Speaks the standard ComfyUI HTTP API — POST /prompt (queue a workflow graph),
// GET /history/<id> (poll for completion), GET /view (download the result) — so
// the SAME adapter drives a local ComfyUI (http://127.0.0.1:8188) and a hosted
// one (RunPod / Comfy.ICU / any box running ComfyUI); only the URL changes.
// This is a production artifact, not a local hack: no endpoint shapes are
// special-cased, and everything is env-configurable.
//
// Style → workflow mapping: the campaign's LOCKED art style ("illustrated" |
// "anime" | "cinematic", from run.world.artStyle) selects the workflow. By
// default one built-in txt2img graph is instantiated with a per-style
// checkpoint + negative prompt; each style can instead point at a full
// exported ComfyUI workflow JSON (API format) via env, with token substitution
// (__PROMPT__, __NEGATIVE__, __SEED__, __WIDTH__, __HEIGHT__, __CHECKPOINT__).
//
// Failure is designed to be CHEAP: if ComfyUI is down/unreachable, the queue
// POST aborts within a short connect window and the error surfaces to
// generateImage's failover chain (→ pollinations/cloudflare). A hung server
// can never stall the image queue — every fetch here carries an
// AbortController deadline (the rest of the image path has none).
//
// Env (INKBORNE_* preferred, NOTDND_* legacy fallback):
//   NOTDND_COMFYUI_URL                     base URL (default http://127.0.0.1:8188)
//   NOTDND_COMFYUI_CHECKPOINT              shared default checkpoint file
//   NOTDND_COMFYUI_CHECKPOINT_ILLUSTRATED  per-style checkpoint override
//   NOTDND_COMFYUI_CHECKPOINT_ANIME
//   NOTDND_COMFYUI_CHECKPOINT_CINEMATIC
//   NOTDND_COMFYUI_WORKFLOW_ILLUSTRATED    per-style workflow JSON file (API format)
//   NOTDND_COMFYUI_WORKFLOW_ANIME
//   NOTDND_COMFYUI_WORKFLOW_CINEMATIC
//   NOTDND_COMFYUI_STEPS                   sampler steps (default 25)
//   NOTDND_COMFYUI_CONNECT_TIMEOUT_MS      queue-POST deadline (default 5000)
//   NOTDND_COMFYUI_TIMEOUT_MS              total generation deadline (default 120000)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { resolveRecipeFile, loadRecipe, injectWorkflow, isApiWorkflow, dimsFor } from "../../scripts/art/generate.mjs";
import { toCanonicalStyle } from "../solo/artStyle.js";

// GAP 1 (art-live-recipes): the live image path routes each (style, kind) through
// the SAME validated per-lane workflow exports the batch cook uses. When a
// validated API-format export resolves, the live generation injects into it
// (prompt/negative/dims/seed by graph shape, the export's own samplers/LoRAs
// preserved) instead of the generic style workflow. A missing/legacy recipe, or
// any resolution problem, falls back to the generic path — generation never fails
// for lack of a tuned recipe.

function artWorkflowDir() {
  return process.env.NOTDND_ART_WORKFLOW_DIR
    ? path.resolve(process.env.NOTDND_ART_WORKFLOW_DIR)
    : path.resolve(process.cwd(), "scripts/art/workflows");
}

// The checkpoint a resolved recipe carries (for serve attribution), or null.
function checkpointFromGraph(graph) {
  for (const node of Object.values(graph || {})) {
    if (node && node.class_type === "CheckpointLoaderSimple") {
      return node.inputs?.ckpt_name || null;
    }
  }
  return null;
}

// SINGLE SOURCE OF TRUTH for a style's checkpoint: the validated per-lane exports
// (the SAME files the batch cook reads via resolveRecipeFile). The live path must
// NOT diverge from them via a parallel hardcoded table — that drift served the
// retired Illustrious for anime long after the Chunk-6 JANKU switch (owner debug
// window, 2026-07-18). Probes the canonical style's exports across kinds and
// returns the first validated checkpoint; null → the caller falls back to the
// STYLE_PRESETS checkpoint (last resort, only for a style with ZERO exports).
const RECIPE_KINDS_FOR_CHECKPOINT = Object.freeze(["portrait", "fullbody", "scene", "item", "world-card", "landscape"]);
export function checkpointForStyle(style) {
  const canon = toCanonicalStyle(style);
  if (!canon) return null;
  for (const kind of RECIPE_KINDS_FOR_CHECKPOINT) {
    try {
      if (!resolveRecipeFile(canon, kind)) continue;
      const recipe = loadRecipe(canon, kind);
      if (!isApiWorkflow(recipe)) continue;
      const ckpt = checkpointFromGraph(recipe);
      if (ckpt) return ckpt;
    } catch {
      // a bad/unreadable recipe never blocks resolution — try the next kind
    }
  }
  return null;
}

// The validated per-lane workflow FILENAME a live (style, kind) resolves to, or
// null when it falls back to the generic style workflow. Pure routing decision
// (no injection, no ComfyUI) — the kind-routing table + serve attribution read it.
export function resolveLiveWorkflowFile(style, kind) {
  if (!kind) return null;
  const canon = toCanonicalStyle(style);
  if (!canon) return null;
  let recipeFile = null;
  let recipe = null;
  try {
    recipeFile = resolveRecipeFile(canon, kind);
    if (!recipeFile) return null;
    recipe = loadRecipe(canon, kind);
  } catch {
    return null;
  }
  if (!isApiWorkflow(recipe)) return null;
  return path.basename(recipeFile);
}

// The face-ref tailor filename for a style, or null (only realistic ships one).
export function resolveLiveTailorFile(style) {
  const canon = toCanonicalStyle(style);
  if (!canon) return null;
  const p = tailorRecipePath(canon);
  return p ? path.basename(p) : null;
}

// Resolve a validated txt2img per-lane recipe for (style, kind). Returns
// { workflow, workflowFile, checkpoint } or null (→ generic fallback). Uses the
// LANE-SPEC dims (dimsFor) exactly like the batch cook, not the caller's dims.
// NEVER throws.
export function resolveValidatedComfyWorkflow(style, kind, { positive, negative, seed }) {
  if (!kind) return null;
  const canon = toCanonicalStyle(style);
  if (!canon) return null;
  let recipeFile = null;
  let recipe = null;
  try {
    recipeFile = resolveRecipeFile(canon, kind);
    if (!recipeFile) return null;
    recipe = loadRecipe(canon, kind);
  } catch {
    return null;
  }
  // Only API-format exports are "validated recipes"; a legacy per-style recipe
  // (<style>.json) is not — let the generic style path own that fallback.
  if (!isApiWorkflow(recipe)) return null;
  const dims = dimsFor(recipe, kind);
  try {
    const workflow = injectWorkflow(recipe, { positive, negative, width: dims.width, height: dims.height, seed });
    return { workflow, workflowFile: path.basename(recipeFile), checkpoint: checkpointFromGraph(workflow) };
  } catch {
    return null;
  }
}

// The face-ref tailor export for a style (fullbody-<style>-tailor.json), or null.
// Only realistic ships one today; other styles → null → documented fallback.
function tailorRecipePath(canon) {
  const p = path.join(artWorkflowDir(), `fullbody-${canon}-tailor.json`);
  return fs.existsSync(p) ? p : null;
}

// Inject prompt + negative + LoadImage face-ref + batch into the tailor graph by
// SHAPE (the tailorFullbody pattern), preserving IPAdapter/LoRA/sampler params.
function injectTailorGraph(recipe, { positive, negative, imageName }) {
  const g = JSON.parse(JSON.stringify(recipe));
  const entries = Object.entries(g);
  const sampler = entries.find(([, n]) => /KSampler/.test(n?.class_type || ""));
  if (!sampler) return null;
  const posId = sampler[1].inputs?.positive?.[0];
  const negId = sampler[1].inputs?.negative?.[0];
  const loadImage = entries.find(([, n]) => n?.class_type === "LoadImage");
  const latent = entries.find(([, n]) => n?.class_type === "EmptyLatentImage");
  if (!posId || !g[posId] || !negId || !g[negId] || !loadImage || !latent) return null;
  if (typeof positive === "string") g[posId].inputs.text = positive;
  if (typeof negative === "string") g[negId].inputs.text = negative;
  g[loadImage[0]].inputs.image = imageName;
  g[latent[0]].inputs.batch_size = 1;
  return g;
}

// Read the reference image bytes (a /data served path → disk under cwd; an
// absolute/file path → disk; an http(s) url → fetch) and upload to ComfyUI's
// input dir, returning the uploaded filename or null. NEVER throws.
async function uploadReferenceToComfy(base, referenceImageUrl, fetchImpl) {
  try {
    const ref = String(referenceImageUrl || "");
    if (!ref) return null;
    let bytes = null;
    if (ref.startsWith("http://") || ref.startsWith("https://")) {
      const r = await fetchImpl(ref);
      if (!r.ok) return null;
      bytes = Buffer.from(await r.arrayBuffer());
    } else {
      const diskPath = ref.startsWith("/") && !ref.startsWith("//")
        ? (ref.startsWith("/data/") ? path.join(process.cwd(), ref.replace(/^\//, "")) : ref)
        : ref.replace(/^file:\/\//, "");
      if (!fs.existsSync(diskPath)) return null;
      bytes = fs.readFileSync(diskPath);
    }
    const name = `liveref_${comfyuiSeed(ref, null)}.png`;
    const form = new FormData();
    form.append("image", new Blob([bytes]), name);
    form.append("overwrite", "true");
    const res = await fetchImpl(`${base}/upload/image`, { method: "POST", body: form });
    if (!res.ok) return null;
    const out = await res.json().catch(() => ({}));
    return out.name || name;
  } catch {
    return null;
  }
}

function env(name, fallback = "") {
  const inkborne = process.env[`INKBORNE_${name}`];
  const notdnd = process.env[`NOTDND_${name}`];
  const value = inkborne ?? notdnd;
  return value === undefined || value === null || String(value).trim() === "" ? fallback : String(value).trim();
}

export function comfyuiBaseUrl() {
  return env("COMFYUI_URL", "http://127.0.0.1:8188").replace(/\/+$/, "");
}

function makeProviderError(message, code = "UPSTREAM_AI_ERROR", statusCode = 502) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// The three locked campaign art styles (mirrors ART_STYLES in solo/worldGen.js).
// These checkpoints are the LAST-RESORT fallback ONLY — used when a style has ZERO
// validated exports. The live path derives its checkpoint from the exports first
// (checkpointForStyle, the single source of truth); this table must never be the
// primary source again (the anime→Illustrious drift that survived the Chunk-6 JANKU
// switch — owner debug window 2026-07-18). The drift test keeps this row honest:
// anime→JANKU (canonical anime export), illustrated→dark-fantasy lane (nihilmania),
// cinematic→realistic lane (Juggernaut). Overridable per style via
// NOTDND_COMFYUI_CHECKPOINT_<STYLE> or globally via NOTDND_COMFYUI_CHECKPOINT.
// Negatives steer each style away from its most common failure mode.
const STYLE_PRESETS = Object.freeze({
  illustrated: {
    checkpoint: "Juggernaut-XI-byRunDiffusion.safetensors",
    negative:
      "photograph, photorealistic, 3d render, text, watermark, signature, logo, frame, border, blurry, lowres, deformed hands",
    cfg: 6.5
  },
  anime: {
    checkpoint: "JANKUTrainedChenkinNoobai_v777.safetensors",
    negative:
      "photorealistic, photograph, 3d render, western comic, text, watermark, signature, logo, blurry, lowres, deformed hands",
    cfg: 7
  },
  cinematic: {
    checkpoint: "Juggernaut-XI-byRunDiffusion.safetensors",
    negative:
      "anime, cartoon, illustration, painting, text, watermark, signature, logo, frame, blurry, lowres, deformed hands",
    cfg: 5.5
  }
});

function normalizeStyle(style) {
  const key = String(style || "").trim().toLowerCase();
  return STYLE_PRESETS[key] ? key : "illustrated";
}

// Per-provider ELF DEFENSE (belt-and-suspenders layer 2 for the 2026-07-18 elf-ears
// relapse). Anime/fantasy SDXL checkpoints (Illustrious, JANKU, …) carry a strong
// latent bias toward pointed ELF ears whenever a human is framed inside a fantasy
// world. The shared prompt builder already asserts "rounded human ears" POSITIVELY
// — that alone is enough for pollinations-class positive-only providers, but it does
// NOT overcome the checkpoint bias on ComfyUI, which HAS a negative field. So on the
// ComfyUI path we ALSO push elf/pointed-ear tokens into the negative, WEIGHTED
// (anime checkpoints need emphatic tokens — the AGE-LAW precedent). Derived from the
// positive so it is builder-agnostic (player, NPC, batch cook all covered) and
// self-consistent: a real elf/half-elf declares "pointed ears" in the positive and
// is never suppressed; non-human subjects (scenes/items) are left untouched.
const ELF_DEFENSE_NEGATIVE = "(elf:1.5), (elf ears:1.5), (pointed ears:1.4), (fantasy elf:1.3)";

export function elfDefenseFor(positive) {
  const p = String(positive || "").toLowerCase();
  // Real elf/half-elf: the builder puts "pointed ears" in the positive — do not fight it.
  if (p.includes("pointed ears")) return "";
  // Only defend an actual human/person subject; a scene or item has no ears to protect.
  if (!/(human|person|rounded ears|rounded human)/.test(p)) return "";
  return ELF_DEFENSE_NEGATIVE;
}

// Merge the elf defense into a style/recipe negative for a human portrait subject.
// No-op (returns the negative unchanged) for elves and non-human subjects.
export function withElfDefense(positive, negative) {
  const extra = elfDefenseFor(positive);
  if (!extra) return negative;
  const neg = String(negative || "").trim();
  return neg ? `${neg}, ${extra}` : extra;
}

// ── SEALED ANIME-LANE LAWS ───────────────────────────────────────────────────
// The live path injects the caller's positive/negative INTO a workflow graph,
// which OVERWRITES the validated recipe's own text nodes — so the batch cook's
// block layer (scripts/art/prompts/blocks/anime.json) is bypassed and its sealed,
// owner-PROVEN laws never reach the render. Re-assert them here, the per-provider
// enforcement point (same principle as the elf defense):
//   • QUALITY vocab (JANKU-family PROVEN): without it JANKU renders soft/sketchy.
//   • NEGATIVE base + portrait law (multi-head/reference-sheet/sketch/monochrome)
//     + AGE-LAW young-negation. The weighted ADULT + gender words live in the
//     builder's positive (imageWorker); the young NEGATION lives here.
// Falls back to inline sealed values if the block file is unreadable (never throws).
const ANIME_BLOCK_FALLBACK = Object.freeze({
  quality: "masterpiece, best quality, newest, very aesthetic, absurdres, highres",
  styleVocab: "anime coloring, cel shading, flat color, clean line art, crisp lineart, vibrant color palette, sharp focus, 2d",
  portraitBackground: "simple background, soft gradient background",
  // HUMAN-only (owner acceptance batch 00226-00229): color anti-washout + wardrobe floor.
  characterVocab: "rich color, warm skin tone, healthy complexion, fully clothed",
  // HUMAN-only: the widened kemonomimi/animal-ear suppression + no-shirtless. NOT in
  // negativeBase — a blanket animal-ear negative would strip a real creature's ears.
  humanNegative: "(animal ears:1.4), kemonomimi, cat ears, rabbit ears, bunny ears, floppy ears, cat boy, monster boy, furry, shirtless, bare chest, topless",
  negativeBase:
    "lowres, worst quality, bad anatomy, bad hands, extra fingers, deformed, blurry, jpeg artifacts, watermark, signature, text, 3d, photorealistic, realistic, painterly, oil painting, digital painting, western comic, comic book, monochrome, greyscale, sepia, yellow tint, gold tint, orange tint, red wash, crimson wash, red tint, single-color palette, limited palette, duotone, muted colors, desaturated, oversaturated, blown highlights, heavy rim light, solid color background, plain background, plain color backdrop, red background, yellow background, orange background, aircraft, airplane, biplane, warplane, fighter plane, jet, propeller plane, vehicle"
});
// Cross-lane portrait law: one finished figure, no turnaround/sheet, no sketch.
// The sheet/multi-view tokens carry a LIGHT weight — the real lever against the
// 2×2-grid / model-sheet relapse is removing the "NOT a reference sheet" NEGATION
// from the positive (which the model painted literally); heavy negative weights
// (1.5–1.6) were tested and collapsed JANKU's palette to a flat saturated field,
// so they are dialled back to ~1.25 (live-proof tuned 2026-07-18).
const PORTRAIT_NEGATIVE_LAW =
  "(character reference sheet:1.25), (model sheet:1.25), (multiple views:1.25), multiple angles, turnaround, (multiple heads:1.2), two heads, grid, split panel, contact sheet, extra heads, duplicate character, cropped head, sketch, rough sketch, unfinished, lineart only, monochrome, greyscale";
// AGE LAW (negation half): keep the young default off adult subjects.
const AGE_NEGATIVE_LAW = "child, kid, teenager, teen, young, youthful, baby face, chibi";

// ── LANE-INVARIANT IDENTITY LAW (owner ruling 2026-07-20) ────────────────────
// A declared HUMAN character must carry the same identity protection in EVERY style
// lane, not only anime. The weighted identity block ((adult man:1.3), human, rounded
// ears) already rides the POSITIVE from the ONE builder (buildPlayerPortraitPrompt);
// these are the matching NEGATIVES, previously applied only on the anime lane, now
// asserted lane-invariantly so nihilmania (illustrated/dark-fantasy) and Juggernaut
// (cinematic/realistic) get them too.
//
// HUMAN-SUBJECT MONSTER BAN: a grimdark SDXL checkpoint (nihilmania / DF-family)
// collapses a declared human into a skull/undead/demon prior — the owner's fresh run
// rendered a red-eyed horned SKULL DEMON from a declared human adult male. Suppress it
// in the negative. Human-GATED twice over: fires only for a human/person subject AND
// never when the subject DECLARES a monstrous/demonic nature (tiefling, demon, undead,
// dragonborn, horns, tail, beast) — a committed non-human keeps its nature.
const HUMAN_SUBJECT_MONSTER_NEGATIVE =
  "(skull:1.4), (skull face:1.4), skull head, fleshless face, (skeleton:1.3), undead, lich, zombie, ghoul, wraith, corpse, rotting flesh, exposed bone, (monster:1.2), (creature:1.2), demonic monster, (skull mask:1.3), skull helmet, full-face helmet, face-covering mask, empty eye sockets, hollow glowing eyes";
export function humanSubjectMonsterNegativeFor(positive) {
  const p = String(positive || "").toLowerCase();
  // Only a human/person subject has a human face to protect (same gate as elfDefenseFor).
  if (!/(human|person|rounded ears|rounded human)/.test(p)) return "";
  // A subject that DECLARES a monstrous/demonic/nonhuman nature keeps it — never fight
  // the committed identity (the demon-essence MC still renders human unless declared).
  if (/\b(demon|demonic|tiefling|undead|skeleton|lich|dragonborn|orc|monstrous|horns?|tail|beast|creature|skull)\b/.test(p)) return "";
  return HUMAN_SUBJECT_MONSTER_NEGATIVE;
}

// PORTRAIT STYLE-COLLAPSE BAN (the "mustard" signature): a character portrait must not
// render as a western-comic bust floating on a flat bright-color field — the pre-kitchen
// output the owner's redo produced (yellow monochrome, comic line art, disembodied bust).
// The anime negativeBase already bans this class; assert it lane-invariantly for every
// character portrait so a non-anime lane (which had NO negative against it) can't drift
// there. NOT applied to the anime lane (it is legitimately cel/flat).
const PORTRAIT_STYLE_COLLAPSE_NEGATIVE =
  "western comic, comic book, comic book cover, pop art, (yellow background:1.2), (gold background:1.2), (orange background:1.1), bright flat color background, single-color flat field, floating head, disembodied bust, headshot cut-out, sticker art";

// WARDROBE FLOOR (owner kitchen lesson 2026-07-20: positives beat negatives for
// wardrobe). A "shirtless" NEGATIVE loses to JANKU's bare-chest default on a no-attire
// prompt (the 3-proof shirtless-2/3), but a SPECIFIC worn garment in the POSITIVE holds.
// So when a human character portrait carries NO committed wardrobe, the seal injects a
// specific default garment; committed gear (armor/coat/robe/…) OVERRIDES and suppresses
// the default. Replaces the weak generic "fully clothed" token.
const DEFAULT_GARMENT = "wearing a plain dark shirt";
const COMMITTED_WARDROBE_RE =
  /\b(shirt|coat|jacket|vest|tunic|robe|cloak|dress|gown|armou?r|breastplate|cuirass|chainmail|plate|leather|uniform|clothes|clothing|attire|wearing|clad|garb|hood|hooded|scarf|shawl|blouse|doublet|surcoat|tabard|kimono|habit|cassock|apron|overcoat)\b/i;
// The specific default garment for a human character portrait with no committed wardrobe,
// or "" (scene/item subject, a committed non-human, or committed gear already present).
// Human-gated by the SAME predicate as characterVocab (elfDefenseFor fires only for a
// human/person subject), so a beast NPC never gets dressed.
function wardrobeGarmentFor(positive) {
  const p = String(positive || "");
  if (!isCharacterSubject(p)) return "";
  if (!elfDefenseFor(p)) return "";
  if (COMMITTED_WARDROBE_RE.test(p)) return "";
  return DEFAULT_GARMENT;
}

let _animeBlock = null;
function animeBlock() {
  if (_animeBlock) return _animeBlock;
  try {
    const dir = process.env.NOTDND_ART_PROMPTS_DIR
      ? path.resolve(process.env.NOTDND_ART_PROMPTS_DIR)
      : path.resolve(process.cwd(), "scripts/art/prompts");
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "blocks", "anime.json"), "utf8"));
    _animeBlock = {
      quality: String(raw.quality || "").trim() || ANIME_BLOCK_FALLBACK.quality,
      styleVocab: String(raw.styleVocab || "").trim() || ANIME_BLOCK_FALLBACK.styleVocab,
      portraitBackground: String(raw.portraitBackground || "").trim() || ANIME_BLOCK_FALLBACK.portraitBackground,
      characterVocab: String(raw.characterVocab || "").trim() || ANIME_BLOCK_FALLBACK.characterVocab,
      humanNegative: String(raw.humanNegative || "").trim() || ANIME_BLOCK_FALLBACK.humanNegative,
      negativeBase: String(raw.negativeBase || "").trim() || ANIME_BLOCK_FALLBACK.negativeBase
    };
  } catch {
    _animeBlock = ANIME_BLOCK_FALLBACK;
  }
  return _animeBlock;
}

function isCharacterSubject(positive) {
  return /(character portrait|portrait of|\bhuman\b|\bperson\b|\bman\b|\bwoman\b|1girl|1boy)/i.test(String(positive || ""));
}

// GENDER LOCK (2026-07-18 refine-inverts-gender fix). The declared gender is a
// WEIGHTED token in the positive ("(adult man:1.3)"); ENFORCE it by purging the
// opposite gender in the NEGATIVE (ComfyUI honors negatives; anime checkpoints are
// female-biased, so a male MC needs female actively suppressed). Single-sourced
// from the positive so draft, refine, and live all lock identically. `female`
// contains `male` and `woman` contains `man` only mid-word, so \b guards are safe.
function genderLockNegative(positive) {
  const p = String(positive || "").toLowerCase();
  const hasMan = /\badult man\b/.test(p) || /\bmale\b/.test(p) || /\b1boy\b/.test(p);
  const hasWoman = /\badult woman\b/.test(p) || /\bfemale\b/.test(p) || /\b1girl\b/.test(p);
  if (hasMan && !hasWoman) return "1girl, woman, female, feminine, girl";
  if (hasWoman && !hasMan) return "1boy, man, male, masculine, boy";
  return "";
}

function joinCsv(parts) {
  return parts.map((p) => String(p || "").trim()).filter(Boolean).join(", ");
}

// The single sealing point for the live ComfyUI prompt: elf defense (all lanes) +
// the sealed anime-lane laws (quality vocab in the positive, full negative block).
// Non-anime lanes keep their style preset negative + elf defense unchanged.
// SCENE FRAMING GUARD (owner ruling 2026-07-19): a scene is the player's eye-level
// view, never an aerial/postcard vista, and carries no aircraft/vehicles/modern
// city/crowds unless the location's canon states them. Applied to NON-character
// subjects only (a portrait has no framing to guard).
const SCENE_FRAMING_NEGATIVE =
  "aerial view, bird's-eye view, top-down view, drone shot, satellite view, sky focus, clouds close-up, horizon-only vista, aircraft, airplane, biplane, vehicle, car, modern city skyline, skyscrapers, crowd, group of people, multiple people, empty floor, bare ground only, no subject";
// THE HUMAN BAN (the biplane-net's "no humans unless a human is committed", owner ruling
// 2026-07-19). Stray people in a scene are a coherence crime — EXCEPT when the committed
// present subject is human/demon, in which case the scene prompt emits "lone figure" /
// "demonic figure" and this ban is dropped so the committed person can render. "character"
// is deliberately NOT here: it suppressed the committed BEAST (the Grey rendered as a bare
// floor). A beast is a valid, required scene subject.
const SCENE_HUMAN_NEGATIVE =
  "person, people, human figure, human, man, woman, 1girl, 1boy";
const HUMANOID_SUBJECT_RE = /\b(lone figure|demonic figure|human figure)\b/i;

export function sealPortraitPrompt(styleKey, positive, presetNegative) {
  const pos0 = String(positive || "");
  const elf = elfDefenseFor(pos0);
  const isChar = isCharacterSubject(pos0);
  const genderLock = isChar ? genderLockNegative(pos0) : "";
  // A scene keeps the framing guard; the human ban rides too UNLESS a humanoid
  // (human/demon) subject is committed present (the scene prompt says so), so the one
  // committed person renders while stray humans stay banned.
  const humanoidScene = !isChar && HUMANOID_SUBJECT_RE.test(pos0);
  const sceneGuard = isChar ? "" : joinCsv([SCENE_FRAMING_NEGATIVE, humanoidScene ? "" : SCENE_HUMAN_NEGATIVE]);
  // LANE-INVARIANT character laws: the portrait/age/monster/style-collapse negatives
  // that previously lived ONLY on the anime lane. A character in ANY lane now gets the
  // sheet/age laws + the human-gated monster ban; a non-anime character portrait also
  // gets the style-collapse ban (the anime lane owns that in its negativeBase).
  const monsterBan = isChar ? humanSubjectMonsterNegativeFor(pos0) : "";
  // WARDROBE FLOOR: a specific default garment when a human portrait has no committed
  // wardrobe (positives beat negatives — see wardrobeGarmentFor). Lane-invariant.
  const garment = wardrobeGarmentFor(pos0);
  if (styleKey !== "anime") {
    const charLaws = isChar
      ? joinCsv([PORTRAIT_NEGATIVE_LAW, AGE_NEGATIVE_LAW, PORTRAIT_STYLE_COLLAPSE_NEGATIVE])
      : "";
    const positiveOut = garment ? joinCsv([pos0, garment]) : pos0;
    return { positive: positiveOut, negative: joinCsv([presetNegative, charLaws, monsterBan, elf, genderLock, sceneGuard]) };
  }
  const block = animeBlock();
  // Quality vocab LEADS (JANKU responds to it front-loaded), then the palette/light
  // styleVocab — the natural-palette + even-light cue that pulls JANKU off its
  // grimdark red-monochrome collapse (2026-07-19 red-wash fix). Both are skipped
  // when already present so re-seals don't stack.
  const lead = [];
  if (block.quality && !pos0.toLowerCase().includes("best quality")) {
    lead.push(block.quality);
  }
  if (block.styleVocab && !pos0.toLowerCase().includes("cel shading")) {
    lead.push(block.styleVocab);
  }
  // PORTRAIT BACKGROUND (v4 wash fix): a soft-gradient backdrop so JANKU stops painting
  // the figure onto a flat single-color field — the red/gold monochrome wash's visible
  // face. Portraits only; a scene owns its own background.
  if (isChar && block.portraitBackground && !pos0.toLowerCase().includes("simple background")) {
    lead.push(block.portraitBackground);
  }
  // HUMAN-only lessons (owner acceptance batch 00226-00229). elfDefenseFor fires
  // only for an actual human/person subject (not elves, not animals), so it is the
  // exact gate that keeps the kemonomimi/animal-ear suppression + warm-skin/clothed
  // positives OFF real creatures — a wolf NPC keeps its ears.
  const isHuman = Boolean(elf);
  if (isHuman && block.characterVocab && !pos0.toLowerCase().includes("warm skin tone")) {
    // Strip the generic "fully clothed" token — a SPECIFIC garment (below) holds far
    // better against JANKU's bare-chest default (positives beat negatives for wardrobe).
    const vocab = block.characterVocab
      .replace(/,\s*fully clothed\b/i, "")
      .replace(/\bfully clothed\b\s*,?\s*/i, "")
      .trim();
    if (vocab) lead.push(vocab);
  }
  let positiveOut = lead.length ? joinCsv([...lead, pos0]) : pos0;
  // WARDROBE FLOOR: append the specific default garment (empty when committed gear is
  // present, so the committed wardrobe stands alone).
  if (garment) positiveOut = joinCsv([positiveOut, garment]);
  const negativeOut = joinCsv([
    block.negativeBase,
    isChar ? PORTRAIT_NEGATIVE_LAW : "",
    isChar ? AGE_NEGATIVE_LAW : "",
    isHuman ? block.humanNegative : "",
    monsterBan,
    elf,
    genderLock,
    sceneGuard
  ]);
  return { positive: positiveOut, negative: negativeOut };
}

// Deterministic seed from the prompt when none is given (same policy as the
// pollinations provider) so identical prompts re-render identically.
function comfyuiSeed(prompt, seed) {
  if (Number.isFinite(Number(seed))) {
    return Math.abs(Math.trunc(Number(seed)));
  }
  let hash = 0;
  const text = String(prompt || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// The built-in workflow: a plain ComfyUI txt2img graph in API format
// (checkpoint → CLIP encode ×2 → empty latent → KSampler → VAE decode → save).
// Works on a stock ComfyUI install with any SD/SDXL checkpoint.
function defaultWorkflow({ checkpoint, positive, negative, seed, width, height, steps, cfg }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0]
      }
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "inkborne", images: ["8", 0] } }
  };
}

// Token substitution for externally supplied workflow JSON: a string value that
// IS a token becomes the typed value (so numeric fields stay numeric); a string
// that CONTAINS a token gets a string splice (for prompts embedded in larger
// text). Unknown keys pass through untouched.
function instantiateWorkflow(node, values) {
  if (typeof node === "string") {
    if (Object.prototype.hasOwnProperty.call(values, node)) {
      return values[node];
    }
    let out = node;
    for (const [token, value] of Object.entries(values)) {
      if (out.includes(token)) {
        out = out.split(token).join(String(value));
      }
    }
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => instantiateWorkflow(entry, values));
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = instantiateWorkflow(value, values);
    }
    return out;
  }
  return node;
}

/**
 * Resolves the workflow graph for a locked art style. Exported for tests and
 * for anyone wiring new styles: given the style + prompt inputs, returns the
 * exact graph that would be queued.
 */
export function comfyuiWorkflowForStyle(style, { prompt, seed, width, height } = {}) {
  const styleKey = normalizeStyle(style);
  const preset = STYLE_PRESETS[styleKey];
  const checkpoint =
    env(`COMFYUI_CHECKPOINT_${styleKey.toUpperCase()}`) || env("COMFYUI_CHECKPOINT") ||
    checkpointForStyle(styleKey) || preset.checkpoint;
  const steps = Math.max(1, Number(env("COMFYUI_STEPS", "25")) || 25);
  const w = Number(width) > 0 ? Math.trunc(Number(width)) : 512;
  const h = Number(height) > 0 ? Math.trunc(Number(height)) : 768;
  const resolvedSeed = comfyuiSeed(prompt, seed);
  const rawPositive = String(prompt || "").trim() || "fantasy illustration";
  // Seal the prompt: elf defense (all lanes) + the sealed anime-lane laws (quality
  // vocab in the positive, full negative block). The batch cook's block layer is
  // bypassed by graph injection, so it is re-asserted here.
  const { positive, negative } = sealPortraitPrompt(styleKey, rawPositive, preset.negative);

  const workflowPath = env(`COMFYUI_WORKFLOW_${styleKey.toUpperCase()}`);
  if (workflowPath) {
    // An explicitly configured workflow that can't be read/parsed is a REAL
    // misconfiguration — fail loudly (into the provider chain) instead of
    // silently rendering with the wrong graph during a quality pass.
    let template;
    try {
      template = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
    } catch (error) {
      throw makeProviderError(
        `comfyui workflow for style "${styleKey}" unreadable at ${workflowPath}: ${String(error?.message || error)}`,
        "BAD_WORKFLOW",
        500
      );
    }
    return {
      styleKey,
      checkpoint,
      workflow: instantiateWorkflow(template, {
        __PROMPT__: positive,
        __NEGATIVE__: negative,
        __SEED__: resolvedSeed,
        __WIDTH__: w,
        __HEIGHT__: h,
        __CHECKPOINT__: checkpoint
      })
    };
  }

  return {
    styleKey,
    checkpoint,
    workflow: defaultWorkflow({
      checkpoint,
      positive,
      negative,
      seed: resolvedSeed,
      width: w,
      height: h,
      steps,
      cfg: preset.cfg
    })
  };
}

// fetch with a hard deadline. ComfyUI is often a LOCAL process — when it is
// down the socket usually refuses instantly, but a wedged/starting instance
// could otherwise hang the serial image queue forever.
async function fetchWithDeadline(fetchImpl, url, options, timeoutMs, what) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw makeProviderError(`comfyui ${what} timed out after ${timeoutMs}ms`, "UPSTREAM_AI_ERROR", 504);
    }
    throw makeProviderError(`comfyui ${what} failed: ${String(error?.message || error)}`, "UPSTREAM_AI_ERROR", 502);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Generates one image via ComfyUI. Same contract as the other image providers:
 * returns { provider, mock, bytes, url }; throws a coded error on any failure
 * so generateImage's failover chain can move on to pollinations/cloudflare.
 * @param {{ prompt?: string, style?: string, seed?: number|null, width?: number|null, height?: number|null, fetchImpl?: typeof fetch }} args
 */
export async function comfyuiImage({ prompt, style, kind, seed, width, height, referenceImageUrl = null, fetchImpl = fetch } = {}) {
  const base = comfyuiBaseUrl();
  const connectTimeoutMs = Math.max(500, Number(env("COMFYUI_CONNECT_TIMEOUT_MS", "5000")) || 5000);
  // NOVRAM cold-load renders reach ~153s (see imageWorker JOB_TIMEOUT_MS note); the old
  // 120s HTTP deadline aborted a slow-but-succeeding DF/nihilmania render as a false
  // timeout. Raised with margin (still well under the outer job watchdog). Env-tunable.
  const totalTimeoutMs = Math.max(5000, Number(env("COMFYUI_TIMEOUT_MS", "240000")) || 240000);

  // GAP 1: prefer the validated per-lane recipe (or the face-ref tailor for a
  // fullbody with a committed portrait). Fall back to the generic style workflow
  // when no validated export exists — generation never fails for lack of a recipe.
  const styleKeyGeneric = normalizeStyle(style);
  const preset = STYLE_PRESETS[styleKeyGeneric];
  const rawPositive = String(prompt || "").trim() || "fantasy illustration";
  // Seal the prompt once (elf defense + sealed anime-lane laws) and apply to every
  // graph this path can build — face-ref tailor, validated per-lane recipe, and the
  // generic fallback (comfyuiWorkflowForStyle seals again from raw, idempotently) —
  // so the laws can never be routed around by graph injection.
  const { positive, negative } = sealPortraitPrompt(styleKeyGeneric, rawPositive, preset.negative);
  const resolvedSeed = comfyuiSeed(prompt, seed);
  let workflow;
  let styleKey = styleKeyGeneric;
  let checkpoint;
  let workflowFile = "generic";

  const canon = toCanonicalStyle(style);
  // Face-ref tailor: fullbody + a committed portrait + a tailor export for this
  // style. Uploads the reference and injects it as the IPAdapter LoadImage node.
  let selected = null;
  if (kind === "fullbody" && referenceImageUrl && canon && tailorRecipePath(canon)) {
    try {
      const imageName = await uploadReferenceToComfy(base, referenceImageUrl, fetchImpl);
      if (imageName) {
        const recipe = JSON.parse(fs.readFileSync(tailorRecipePath(canon), "utf8"));
        const graph = injectTailorGraph(recipe, { positive, negative, imageName });
        if (graph) {
          selected = { workflow: graph, workflowFile: path.basename(tailorRecipePath(canon)), checkpoint: checkpointFromGraph(graph) };
        }
      }
    } catch {
      selected = null; // any tailor problem → fall through to txt2img
    }
  }
  if (!selected) {
    selected = resolveValidatedComfyWorkflow(style, kind, { positive, negative, seed: resolvedSeed });
  }
  if (selected) {
    workflow = selected.workflow;
    workflowFile = selected.workflowFile;
    checkpoint = selected.checkpoint || null;
  } else {
    const generic = comfyuiWorkflowForStyle(style, { prompt, seed, width, height });
    workflow = generic.workflow;
    styleKey = generic.styleKey;
    checkpoint = generic.checkpoint;
  }

  // 1) Queue the workflow. This returns quickly even for slow renders, so the
  //    short deadline here only bites when ComfyUI is down/unreachable — the
  //    cheap-failure path into the provider chain.
  let queued;
  try {
    queued = await fetchWithDeadline(
      fetchImpl,
      `${base}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: "inkborne" })
      },
      connectTimeoutMs,
      "queue"
    );
  } catch (error) {
    // The one loud line the director needs when testing with ComfyUI off:
    // which endpoint failed and that the chain takes over.
    console.warn(`[image] comfyui unreachable at ${base} (${String(error?.message || error).slice(0, 120)}) — falling back to the provider chain`);
    throw error;
  }
  if (!queued.ok) {
    const body = await queued.text().catch(() => "");
    throw makeProviderError(`comfyui queue rejected (${queued.status}): ${body.slice(0, 200)}`, "UPSTREAM_AI_ERROR", queued.status);
  }
  const queuedJson = await queued.json().catch(() => ({}));
  const promptId = queuedJson?.prompt_id;
  if (!promptId) {
    throw makeProviderError(
      `comfyui queue returned no prompt_id${queuedJson?.node_errors ? `: ${JSON.stringify(queuedJson.node_errors).slice(0, 200)}` : ""}`,
      "UPSTREAM_AI_ERROR",
      502
    );
  }

  // 2) Poll history until the graph has outputs (or the total deadline hits).
  const deadline = Date.now() + totalTimeoutMs;
  let outputs = null;
  while (Date.now() < deadline) {
    const historyRes = await fetchWithDeadline(fetchImpl, `${base}/history/${promptId}`, {}, connectTimeoutMs, "history poll");
    if (historyRes.ok) {
      const history = await historyRes.json().catch(() => ({}));
      const entry = history?.[promptId];
      if (entry?.status?.status_str === "error") {
        throw makeProviderError(
          `comfyui workflow errored (style ${styleKey}): ${JSON.stringify(entry.status?.messages || []).slice(0, 300)}`,
          "UPSTREAM_AI_ERROR",
          502
        );
      }
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        outputs = entry.outputs;
        break;
      }
    }
    await sleep(1000);
  }
  if (!outputs) {
    throw makeProviderError(`comfyui render did not complete within ${totalTimeoutMs}ms`, "UPSTREAM_AI_ERROR", 504);
  }

  // 3) Download the first image any output node produced.
  let imageRef = null;
  for (const node of Object.values(outputs)) {
    const images = Array.isArray(node?.images) ? node.images : [];
    if (images.length > 0) {
      imageRef = images[0];
      break;
    }
  }
  if (!imageRef?.filename) {
    throw makeProviderError("comfyui workflow completed but produced no image output", "UPSTREAM_AI_ERROR", 502);
  }

  const viewParams = new URLSearchParams({
    filename: imageRef.filename,
    subfolder: imageRef.subfolder || "",
    type: imageRef.type || "output"
  });
  const viewUrl = `${base}/view?${viewParams.toString()}`;
  const imageRes = await fetchWithDeadline(fetchImpl, viewUrl, {}, connectTimeoutMs, "image download");
  if (!imageRes.ok) {
    throw makeProviderError(`comfyui image download failed (${imageRes.status})`, "UPSTREAM_AI_ERROR", imageRes.status);
  }

  return {
    provider: "comfyui",
    mock: false,
    bytes: Buffer.from(await imageRes.arrayBuffer()),
    url: viewUrl,
    // Surface the real serving attribution for the debug panel: the style key
    // selected, the checkpoint that rendered, and WHICH validated workflow export
    // (or "generic") produced it — so a live image's recipe is auditable.
    model: styleKey,
    checkpoint,
    workflow: workflowFile
  };
}
