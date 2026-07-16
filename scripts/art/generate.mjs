// ---------------------------------------------------------------------------
// ART GENERATION (art-week phase 1) — local ComfyUI, zero API credits.
//
// Cooks one image per call against local ComfyUI (127.0.0.1:8188), from a style
// RECIPE (scripts/art/workflows/<style>.json), lands it in the asset library WITH
// a fully-tagged sidecar, and is IDEMPOTENT by id (a resumed batch skips images
// that already exist). The batch runner enforces the HARD GPU SAFETY RULES.
//
// GPU SAFETY (freeze history: 3 prior hangs on this 8GB card):
//  - the batch aborts if the play server served a turn in the last 10 min
//    (owner may be playing) or if free VRAM < 1GB;
//  - images cook in chunks of <=10 with an nvidia-smi check between chunks;
//  - ComfyUI is stopped at the end of every batch — it never idles.
// This module NEVER auto-launches a batch; callers gate explicitly.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { addAsset, assetExists, libraryRoot } from "./library.mjs";
import { buildPrompt, laneForKind, mapNpcToSlots, mapLocationToSlots } from "./promptAssembly.js";
import { fileURLToPath } from "node:url";
import { validateWorkflow } from "./validateWorkflow.mjs";

const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const PLAY_STATUS = process.env.PLAY_STATUS_URL || "http://localhost:4173/api/debug/status";
// Resolved at call time (not module load) and env-overridable so tests can point
// routing at a temp dir of mock workflow files.
function workflowDir() {
  return process.env.NOTDND_ART_WORKFLOW_DIR
    ? path.resolve(process.env.NOTDND_ART_WORKFLOW_DIR)
    : path.resolve(process.cwd(), "scripts/art/workflows");
}

// FOUR-WAITER routing (art-pipeline-v2): each asset KIND routes through one of the
// four generation-lane recipes, with a legacy fallback FAMILY. portrait/fullbody/
// item share the legacy "entity" family; scene (and world-card, a wide cover) ride
// the "scene" family. Per-kind lane files are named <lane>-<styleSlug>.json (e.g.
// portrait-anime.json, fullbody-darkfantasy.json, item-anime.json, scene-darkfantasy.json).
const KIND_ROUTING = Object.freeze({
  portrait: { lane: "portrait", legacy: "entity" },
  fullbody: { lane: "fullbody", legacy: "entity" },
  item: { lane: "item", legacy: "entity" },
  // The owner named the scene-lane export "landscape-*.json" — accept it as an
  // alias so the scene kind resolves the owner's real file (workflow-intake).
  scene: { lane: "scene", legacy: "scene", aliases: ["landscape"] },
  "world-card": { lane: "scene", legacy: "scene", aliases: ["landscape"] }
});

// Per-kind filenames collapse the style hyphen: "dark-fantasy" -> "darkfantasy"
// (portrait-darkfantasy.json), while the legacy per-STYLE fallback file keeps the
// hyphen (dark-fantasy.json).
function perKindStyleSlug(style) {
  return String(style).replace(/-/g, "");
}

// The routing ladder for (style, kind), in order, deduped:
//   1. per-kind LANE file    <lane>-<slug>.json   (portrait-anime.json)
//   2. legacy FAMILY file    <legacy>-<slug>.json (entity-anime.json / scene-darkfantasy.json)
//   3. per-STYLE file        <style>.json         (anime.json / dark-fantasy.json)
// A kind not in KIND_ROUTING (or absent) skips straight to the per-style file.
// scene's lane == legacy == "scene", so its steps 1 & 2 collapse to one entry.
export function recipeCandidates(style, kind) {
  const slug = perKindStyleSlug(style);
  const route = kind ? KIND_ROUTING[String(kind)] : null;
  const names = [];
  if (route) {
    names.push(`${route.lane}-${slug}.json`);
    for (const alias of route.aliases || []) names.push(`${alias}-${slug}.json`);
    names.push(`${route.legacy}-${slug}.json`);
  }
  names.push(`${String(style)}.json`);
  return names.filter((name, i) => names.indexOf(name) === i);
}

// ---- recipes --------------------------------------------------------------
// Walk the ladder; return the first existing recipe file (absolute path), or null.
export function resolveRecipeFile(style, kind) {
  const dir = workflowDir();
  for (const name of recipeCandidates(style, kind)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// Loads the resolved recipe VERBATIM (JSON.parse). An optional recipe.identity
// { refImage, weight } block (the IP-Adapter socket, art-pipeline-v2 tailor seam)
// is preserved untouched here and passed through — buildGraph ignores it this
// round; workflows that lack the IP-Adapter nodes simply never read it.
export function loadRecipe(style, kind) {
  const file = resolveRecipeFile(style, kind);
  if (!file) {
    throw new Error(
      `generate: no workflow recipe for (kind "${kind || "-"}", style "${style}") in ${workflowDir()}`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Per-kind DEFAULT dimensions [w,h] (art-pipeline-v2). A recipe file may override
// any kind via its own `dimensions` map; these are the fallbacks so a lane always
// gets the right aspect even from an untuned recipe:
//   portrait   896 x 1152 tall      (VN / status face framing — owner-verified spec)
//   fullbody   832 x 1216 tall      (standing VN sprite)
//   scene      1344 x 768 wide      (wide establishing shot — see composition bar)
//   world-card 1344 x 768 wide      (world-select cover)
//   item       1024 x 1024 square   (object on clean bg, icon-composable)
// These are the owner-verified art-pipeline-v2 lane spec (workflow-intake item 1c);
// an owner export whose latent differs is WARNED and overridden to these.
export const KIND_DIMENSIONS = Object.freeze({
  portrait: [896, 1152],
  fullbody: [832, 1216],
  scene: [1344, 768],
  "world-card": [1344, 768],
  item: [1024, 1024],
  default: [1024, 1024]
});

export function dimsFor(recipe, kind) {
  const d = (recipe && !isApiWorkflow(recipe) && recipe.dimensions) || {};
  const wh = d[kind] || KIND_DIMENSIONS[kind] || d.default || KIND_DIMENSIONS.default;
  return { width: wh[0], height: wh[1] };
}

// ── OWNER-EXPORT INJECTION (workflow-intake item 1b) ──────────────────────────
// The owner exports API-format ComfyUI graphs (node-id → { class_type, inputs }).
// True when a loaded recipe is such a graph (vs the legacy custom recipe format
// with top-level checkpoint/sampler/dimensions fields).
export function isApiWorkflow(recipe) {
  return Boolean(recipe) && typeof recipe === "object" && !Array.isArray(recipe) &&
    Object.values(recipe).some((n) => n && typeof n === "object" && typeof n.class_type === "string");
}

// The graph's committed EmptyLatentImage dims (for the spec-verify warning).
export function workflowLatentDims(graph) {
  const { roles } = validateWorkflow(graph);
  const inp = roles.latent && graph[roles.latent] ? graph[roles.latent].inputs : {};
  return { width: Number(inp.width), height: Number(inp.height) };
}

// Item 1c: warn (never fail) when an owner export's latent dims differ from the
// lane spec — then the injected value (the spec) is what actually cooks.
export function verifyDimsAgainstSpec(graph, kind, { warn = console.warn } = {}) {
  const spec = dimsFor(null, kind);
  const actual = workflowLatentDims(graph);
  if (Number.isFinite(actual.width) && Number.isFinite(actual.height) &&
      (actual.width !== spec.width || actual.height !== spec.height)) {
    warn(`generate: workflow latent ${actual.width}x${actual.height} != lane spec ${spec.width}x${spec.height} for kind "${kind}" — injecting the spec dims.`);
    return { match: false, actual, spec };
  }
  return { match: true, actual, spec };
}

// Inject the assembled prompt + dims + seed into the identified node ids of an
// owner-exported graph. Never mutates the loaded recipe (deep-cloned). Throws
// loudly (naming the fix) if the graph is malformed. Forces batch_size 1 (the
// owner exports batch 4 for proofing; a run cooks one idempotent image).
export function injectWorkflow(graph, { positive, negative, width, height, seed }) {
  const { ok, roles, errors } = validateWorkflow(graph);
  if (!ok) {
    const e = new Error(`generate: cannot inject into a malformed workflow — ${errors[0]}`);
    e.code = "WORKFLOW_INVALID";
    e.errors = errors;
    throw e;
  }
  const g = JSON.parse(JSON.stringify(graph));
  if (typeof positive === "string") g[roles.positive].inputs.text = positive;
  if (typeof negative === "string") g[roles.negative].inputs.text = negative;
  if (Number.isFinite(width)) g[roles.latent].inputs.width = width;
  if (Number.isFinite(height)) g[roles.latent].inputs.height = height;
  if (roles.seedField && Number.isFinite(seed)) g[roles.sampler].inputs[roles.seedField] = seed;
  if (g[roles.latent] && "batch_size" in g[roles.latent].inputs) g[roles.latent].inputs.batch_size = 1;
  return g;
}

// Dry-run PLAN (item 1d): assemble the prompt + resolve the workflow file + dims
// for one (style, kind, slotValues) WITHOUT touching ComfyUI. Returns the plan the
// --plan CLI prints.
export function dryRunPlan({ style, kind, slotValues = {}, tags = [], context = {} }) {
  const file = resolveRecipeFile(style, kind);
  if (!file) throw new Error(`dryRunPlan: no workflow recipe for (kind "${kind}", style "${style}") in ${workflowDir()}`);
  const recipe = JSON.parse(fs.readFileSync(file, "utf8"));
  const api = isApiWorkflow(recipe);
  const { positive, negative, meta } = buildPrompt(laneForKind(kind), style, slotValues, { tags, ...context });
  const { width, height } = dimsFor(api ? null : recipe, kind);
  const dimCheck = api ? verifyDimsAgainstSpec(recipe, kind, { warn: () => {} }) : { match: true, actual: { width, height }, spec: { width, height } };
  const roles = api ? validateWorkflow(recipe).roles : null;
  return {
    style, kind, lane: laneForKind(kind),
    workflowFile: path.basename(file), apiFormat: api,
    dims: { width, height }, dimCheck, roles,
    positive, negative, meta
  };
}

// Deterministic seed from the asset id, so a resumed/idempotent re-cook of the
// same id reproduces the same image (no Math.random — reproducible offline).
function seedFromId(id) {
  return crypto.createHash("sha256").update(String(id)).digest().readUInt32BE(0);
}

// Chain recipe.lora entries as LoraLoader nodes between the checkpoint (node "4")
// and the sampler/clip. Each entry is { name, strength } (strength defaults to
// 1.0 and applies to BOTH model and clip; an optional strengthClip overrides the
// clip strength). Node ids start at 10 so the fixed txt2img nodes ("3".."9") keep
// their ids. Returns the model/clip refs the downstream nodes must read (the last
// LoRA's outputs, or the checkpoint's when no LoRA is present). Mutates `graph`.
function buildLoraChain(graph, loras) {
  let modelRef = ["4", 0];
  let clipRef = ["4", 1];
  let nodeId = 10;
  for (const entry of Array.isArray(loras) ? loras : []) {
    const name = entry && (entry.name || entry.lora_name);
    if (!name) {
      continue; // a malformed entry (no name) is skipped, not wired
    }
    const strength = Number.isFinite(Number(entry.strength)) ? Number(entry.strength) : 1.0;
    const strengthClip = Number.isFinite(Number(entry.strengthClip)) ? Number(entry.strengthClip) : strength;
    const id = String(nodeId);
    nodeId += 1;
    graph[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: String(name),
        strength_model: strength,
        strength_clip: strengthClip,
        model: modelRef,
        clip: clipRef
      }
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }
  return { modelRef, clipRef };
}

// Build a ComfyUI API prompt graph (SDXL txt2img) from a recipe. When the recipe
// declares a non-empty `lora` list, LoraLoader nodes are chained between the
// checkpoint and the sampler/clip; otherwise the sampler/clip read the checkpoint
// directly (the graph is byte-for-byte the pre-LoRA shape).
export function buildGraph(recipe, { kind, prompt, positive, negative, seed }) {
  const { width, height } = dimsFor(recipe, kind);
  const s = recipe.sampler || {};
  // Prefer an explicitly ASSEMBLED prompt (the prompt-contract path via
  // buildPrompt); fall back to the legacy freehand `prompt` + recipe.positiveSuffix
  // only for a direct low-level caller (tests). Same for the negative.
  const positiveText = typeof positive === "string" && positive.trim()
    ? positive.trim()
    : [String(prompt || "").trim(), recipe.positiveSuffix].filter(Boolean).join(", ");
  const negativeText = typeof negative === "string" && negative.trim()
    ? negative.trim()
    : String(recipe.negative || "");
  const graph = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: recipe.checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } }
  };
  // VAE always comes off the checkpoint (LoRAs don't replace it); model + clip
  // come off the end of the LoRA chain (or the checkpoint when there is none).
  const { modelRef, clipRef } = buildLoraChain(graph, recipe.lora);
  graph["6"] = { class_type: "CLIPTextEncode", inputs: { text: positiveText, clip: clipRef } };
  graph["7"] = { class_type: "CLIPTextEncode", inputs: { text: negativeText, clip: clipRef } };
  graph["3"] = {
    class_type: "KSampler",
    inputs: {
      seed: Number.isFinite(seed) ? seed : 0,
      steps: s.steps ?? 28,
      cfg: s.cfg ?? 5,
      sampler_name: s.sampler_name || "euler_ancestral",
      scheduler: s.scheduler || "normal",
      denoise: s.denoise ?? 1,
      model: modelRef,
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0]
    }
  };
  graph["8"] = { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } };
  graph["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "inkborne", images: ["8", 0] } };
  return graph;
}

// ---- ComfyUI HTTP ---------------------------------------------------------
async function comfyPost(pathname, body) {
  const res = await fetch(`${COMFY}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`comfy ${pathname} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

export async function comfyReachable() {
  try {
    const res = await fetch(`${COMFY}/system_stats`);
    return res.ok;
  } catch {
    return false;
  }
}

// Exported (additive) so the game-server tailor service reuses the exact same
// ComfyUI job contract (POST /prompt → poll /history → GET /view) instead of
// standing up a parallel client. Behavior unchanged for existing callers.
export async function queuePrompt(graph, clientId) {
  const out = await comfyPost("/prompt", { prompt: graph, client_id: clientId });
  if (!out.prompt_id) {
    throw new Error(`comfy /prompt returned no prompt_id: ${JSON.stringify(out).slice(0, 200)}`);
  }
  return out.prompt_id;
}

export async function waitForOutput(promptId, { timeoutMs = 180000, pollMs = 1500 } = {}) {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${COMFY}/history/${promptId}`);
    if (res.ok) {
      const hist = await res.json();
      const entry = hist[promptId];
      if (entry && entry.outputs) {
        for (const node of Object.values(entry.outputs)) {
          if (Array.isArray(node.images) && node.images.length) {
            return node.images[0]; // { filename, subfolder, type }
          }
        }
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`comfy: prompt ${promptId} did not produce an image within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function fetchImageBytes({ filename, subfolder, type }) {
  const qs = new URLSearchParams({ filename, subfolder: subfolder || "", type: type || "output" });
  const res = await fetch(`${COMFY}/view?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`comfy /view ${res.status} for ${filename}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Cook ONE image and land it in the library with a tagged sidecar. Idempotent:
// if <id>.png already exists, it is skipped (resumed batch). Returns
// { id, skipped, ms, pngPath }.
export async function generateImage(spec) {
  const { id, style, kind, slotValues, world = null, tags = [], origin = "generated", context = {} } = spec;
  // PROMPT CONTRACT: no freehand `prompt`. Every image is assembled from its lane
  // template + model blocks + committed slot values (buildPrompt), which throws on
  // a missing required slot or injection punctuation before any GPU time is spent.
  if (!id || !style || !kind || !slotValues || typeof slotValues !== "object") {
    throw new Error("generateImage requires { id, style, kind, slotValues } (prompt-contract: freehand prompts are not accepted)");
  }
  const pngPath = path.join(libraryRoot(), `${id}.png`);
  if (fs.existsSync(pngPath) && assetExists(id)) {
    return { id, skipped: true, ms: 0, pngPath };
  }
  const recipeFile = resolveRecipeFile(style, kind);
  const recipe = loadRecipe(style, kind);
  const seed = seedFromId(id);
  // Lane rules (e.g. the starter-zone tower ban) read the asset tags as context.
  const { positive, negative, meta } = buildPrompt(laneForKind(kind), style, slotValues, { tags, ...context });
  // Owner-exported API graph → INJECT into its shape-identified sockets (item 1b);
  // legacy recipe → build the graph from scratch. Same assembled prompt/dims/seed
  // drives either. verifyDimsAgainstSpec warns on an off-spec export (item 1c).
  let graph;
  if (isApiWorkflow(recipe)) {
    verifyDimsAgainstSpec(recipe, kind);
    const { width, height } = dimsFor(null, kind);
    graph = injectWorkflow(recipe, { positive, negative, width, height, seed });
  } else {
    graph = buildGraph(recipe, { kind, positive, negative, seed });
  }
  const clientId = `inkborne-art-${id}`;
  const t0 = Date.now();
  const promptId = await queuePrompt(graph, clientId);
  const image = await waitForOutput(promptId);
  const bytes = await fetchImageBytes(image);
  fs.mkdirSync(libraryRoot(), { recursive: true });
  fs.writeFileSync(pngPath, bytes);
  // meta records templateVersion + blockVersions + slotValues so a tossed image
  // points at a specific slot/template, not an opaque sentence.
  addAsset({ id, origin, world, style, kind, tags, workflow: recipe.name || (recipeFile ? path.basename(recipeFile) : ""), promptUsed: positive, meta });
  return { id, skipped: false, ms: Date.now() - t0, pngPath };
}

// ---- GPU SAFETY -----------------------------------------------------------
export function freeVramMb() {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { encoding: "utf8" });
    return Number(String(out).trim().split("\n")[0]);
  } catch {
    return null;
  }
}

// Minutes since the play server last served a turn (null if unreachable).
export async function minutesSinceLastTurn() {
  try {
    const res = await fetch(PLAY_STATUS);
    if (!res.ok) return null;
    const d = await res.json();
    const at = d?.turnTiming?.last?.at || (Array.isArray(d?.turnTiming?.recent) ? d.turnTiming.recent[0]?.at : null);
    if (!at) return Infinity; // no turns recorded => safe
    return (Date.now() - new Date(at).getTime()) / 60000;
  } catch {
    return null;
  }
}

// Throws unless it is safe to start a batch: the play server has been idle >=10
// min AND free VRAM >= 1GB. Owner-playing / low-VRAM aborts are LOUD.
export async function assertSafeWindow() {
  const idleMin = await minutesSinceLastTurn();
  if (idleMin !== null && idleMin < 10) {
    throw new Error(`GPU-SAFETY: play server served a turn ${idleMin.toFixed(1)} min ago — owner may be playing. Authorize a batch window before generating.`);
  }
  const free = freeVramMb();
  if (free !== null && free < 1024) {
    throw new Error(`GPU-SAFETY: only ${free} MiB VRAM free (< 1024) — abort. Free the GPU (close the game / other loads) before generating.`);
  }
  return { idleMin, freeVramMb: free };
}

export function stopComfy() {
  // Kill by the port's listener (never by a command-line pattern — that can match
  // the running shell). Best-effort; ComfyUI never idles after a batch.
  try {
    const pids = execFileSync("bash", ["-c", "ss -ltnp 2>/dev/null | grep ':8188' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      try { execFileSync("kill", [pid]); } catch { /* already gone */ }
    }
    return pids;
  } catch {
    return [];
  }
}

// Run a batch of specs in chunks of <=chunkSize, re-checking VRAM between chunks,
// stopping ComfyUI at the end no matter what. Idempotent per id (resume-safe).
export async function runBatch(specs, { chunkSize = 10, onProgress = () => {} } = {}) {
  await assertSafeWindow();
  const results = [];
  try {
    for (let i = 0; i < specs.length; i += chunkSize) {
      const free = freeVramMb();
      if (free !== null && free < 1024) {
        throw new Error(`GPU-SAFETY: free VRAM dropped to ${free} MiB mid-batch — aborting before chunk ${i / chunkSize + 1}.`);
      }
      const chunk = specs.slice(i, i + chunkSize);
      for (const spec of chunk) {
        const r = await generateImage(spec);
        results.push(r);
        onProgress(r);
      }
    }
  } finally {
    stopComfy();
  }
  return results;
}

// ── --plan DRY RUN (item 1d) ──────────────────────────────────────────────────
// Assemble + resolve every lane for a style and print it — NO ComfyUI, NO GPU.
function printPlan(p) {
  const warn = p.dimCheck && p.dimCheck.match === false
    ? `  [WARN: owner export latent ${p.dimCheck.actual.width}x${p.dimCheck.actual.height} → overridden to spec]`
    : "";
  console.log(`\n=== LANE: ${p.lane}  (kind=${p.kind}, style=${p.style}) ===`);
  console.log(`  workflow file : ${p.workflowFile}${p.apiFormat ? " (owner API export)" : " (legacy recipe)"}`);
  console.log(`  latent dims   : ${p.dims.width}x${p.dims.height}${warn}`);
  if (p.roles) {
    console.log(`  inject nodes  : positive→${p.roles.positive}  negative→${p.roles.negative}  latent→${p.roles.latent}  seed→${p.roles.sampler}.${p.roles.seedField}`);
  }
  console.log(`  POSITIVE      : ${p.positive}`);
  console.log(`  NEGATIVE      : ${p.negative}`);
}

export function runPlanCli(style = process.env.PLAN_STYLE || "realistic") {
  // Representative committed state (a real NPC/location/item shape) — the plan shows
  // the ASSEMBLED prompt, so slot mapping (incl. the era law) is exercised end-to-end.
  const world = { name: "Ashenmoor", tone: "dark fantasy" }; // no `era` field (world-data gap)
  const npc = { gender: "woman", age: "young", appearance: "red hair loose, simple linen shirt", expression: "wary", mannerism: "arms crossed" };
  const loc = { name: "Ashenmoor Market Square", type: "market", timeOfDay: "dusk", weather: "overcast" };
  const plans = [
    dryRunPlan({ style, kind: "portrait", slotValues: mapNpcToSlots(npc, world) }),
    dryRunPlan({ style, kind: "fullbody", slotValues: mapNpcToSlots(npc, world) }),
    dryRunPlan({ style, kind: "scene", slotValues: mapLocationToSlots(loc), tags: ["starter"] }),
    dryRunPlan({ style, kind: "item", slotValues: { itemType: "a hooded traveling cloak", materials: "wool", styleHint: "worn", era: world.era } })
  ];
  for (const p of plans) printPlan(p);
  return plans;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--plan")) {
    runPlanCli();
  }
}
