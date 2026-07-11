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

const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const PLAY_STATUS = process.env.PLAY_STATUS_URL || "http://localhost:4173/api/debug/status";
const WORKFLOW_DIR = path.resolve(process.cwd(), "scripts/art/workflows");

// ---- recipes --------------------------------------------------------------
export function loadRecipe(style) {
  const file = path.join(WORKFLOW_DIR, `${String(style)}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`generate: no workflow recipe for style "${style}" (${file})`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function dimsFor(recipe, kind) {
  const d = recipe.dimensions || {};
  const wh = d[kind] || d.default || [1024, 1024];
  return { width: wh[0], height: wh[1] };
}

// Deterministic seed from the asset id, so a resumed/idempotent re-cook of the
// same id reproduces the same image (no Math.random — reproducible offline).
function seedFromId(id) {
  return crypto.createHash("sha256").update(String(id)).digest().readUInt32BE(0);
}

// Build a ComfyUI API prompt graph (SDXL txt2img) from a recipe. LoRA slots are
// intentionally empty this round; recipe.lora entries would chain LoraLoader
// nodes between the checkpoint and the sampler/clip (left as a documented seam).
export function buildGraph(recipe, { kind, prompt, seed }) {
  const { width, height } = dimsFor(recipe, kind);
  const s = recipe.sampler || {};
  const positive = [String(prompt || "").trim(), recipe.positiveSuffix].filter(Boolean).join(", ");
  if (Array.isArray(recipe.lora) && recipe.lora.length > 0) {
    // Owner tests LoRA combos himself later; this round the slot is empty.
    throw new Error("generate: LoRA chaining not wired this round (recipe.lora must be empty)");
  }
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: recipe.checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: recipe.negative || "", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: Number.isFinite(seed) ? seed : 0,
        steps: s.steps ?? 28,
        cfg: s.cfg ?? 5,
        sampler_name: s.sampler_name || "euler_ancestral",
        scheduler: s.scheduler || "normal",
        denoise: s.denoise ?? 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0]
      }
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "inkborne", images: ["8", 0] } }
  };
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

async function queuePrompt(graph, clientId) {
  const out = await comfyPost("/prompt", { prompt: graph, client_id: clientId });
  if (!out.prompt_id) {
    throw new Error(`comfy /prompt returned no prompt_id: ${JSON.stringify(out).slice(0, 200)}`);
  }
  return out.prompt_id;
}

async function waitForOutput(promptId, { timeoutMs = 180000, pollMs = 1500 } = {}) {
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

async function fetchImageBytes({ filename, subfolder, type }) {
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
  const { id, style, kind, prompt, world = null, tags = [], origin = "generated" } = spec;
  if (!id || !style || !kind || !prompt) {
    throw new Error("generateImage requires { id, style, kind, prompt }");
  }
  const pngPath = path.join(libraryRoot(), `${id}.png`);
  if (fs.existsSync(pngPath) && assetExists(id)) {
    return { id, skipped: true, ms: 0, pngPath };
  }
  const recipe = loadRecipe(style);
  const seed = seedFromId(id);
  const positive = [String(prompt).trim(), recipe.positiveSuffix].filter(Boolean).join(", ");
  const graph = buildGraph(recipe, { kind, prompt, seed });
  const clientId = `inkborne-art-${id}`;
  const t0 = Date.now();
  const promptId = await queuePrompt(graph, clientId);
  const image = await waitForOutput(promptId);
  const bytes = await fetchImageBytes(image);
  fs.mkdirSync(libraryRoot(), { recursive: true });
  fs.writeFileSync(pngPath, bytes);
  addAsset({ id, origin, world, style, kind, tags, workflow: recipe.name, promptUsed: positive });
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
