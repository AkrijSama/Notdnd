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
  quality: "amazing quality, extremely detailed, very detailed",
  negativeBase:
    "lowres, worst quality, bad anatomy, bad hands, extra fingers, deformed, blurry, jpeg artifacts, watermark, signature, text, 3d, photorealistic"
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
export function sealPortraitPrompt(styleKey, positive, presetNegative) {
  const pos0 = String(positive || "");
  const elf = elfDefenseFor(pos0);
  const genderLock = isCharacterSubject(pos0) ? genderLockNegative(pos0) : "";
  if (styleKey !== "anime") {
    return { positive: pos0, negative: joinCsv([presetNegative, elf, genderLock]) };
  }
  const block = animeBlock();
  const isChar = isCharacterSubject(pos0);
  const positiveOut = block.quality && !pos0.toLowerCase().includes(block.quality.toLowerCase())
    ? joinCsv([block.quality, pos0]) // quality vocab LEADS (JANKU responds to it front-loaded)
    : pos0;
  const negativeOut = joinCsv([
    block.negativeBase,
    isChar ? PORTRAIT_NEGATIVE_LAW : "",
    isChar ? AGE_NEGATIVE_LAW : "",
    elf,
    genderLock
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
  const totalTimeoutMs = Math.max(5000, Number(env("COMFYUI_TIMEOUT_MS", "120000")) || 120000);

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
