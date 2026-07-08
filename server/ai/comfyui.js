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
// Checkpoints map to the two SDXL models actually installed on the local rig
// (see comfyui-8gb-freeze-constraint): Juggernaut XI (a versatile realistic /
// painterly base) covers both illustrated and cinematic; Illustrious XL (an
// anime-native SDXL) covers anime. Any of these is overridable per style via
// NOTDND_COMFYUI_CHECKPOINT_<STYLE> or globally via NOTDND_COMFYUI_CHECKPOINT,
// so a hosted rig with different files needs no code change.
// Negatives steer each style away from its most common failure mode.
const STYLE_PRESETS = Object.freeze({
  illustrated: {
    checkpoint: "Juggernaut-XI-byRunDiffusion.safetensors",
    negative:
      "photograph, photorealistic, 3d render, text, watermark, signature, logo, frame, border, blurry, lowres, deformed hands",
    cfg: 6.5
  },
  anime: {
    checkpoint: "Illustrious-XL-v2.0.safetensors",
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
    env(`COMFYUI_CHECKPOINT_${styleKey.toUpperCase()}`) || env("COMFYUI_CHECKPOINT") || preset.checkpoint;
  const steps = Math.max(1, Number(env("COMFYUI_STEPS", "25")) || 25);
  const w = Number(width) > 0 ? Math.trunc(Number(width)) : 512;
  const h = Number(height) > 0 ? Math.trunc(Number(height)) : 768;
  const resolvedSeed = comfyuiSeed(prompt, seed);
  const positive = String(prompt || "").trim() || "fantasy illustration";

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
        __NEGATIVE__: preset.negative,
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
      negative: preset.negative,
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
export async function comfyuiImage({ prompt, style, seed, width, height, fetchImpl = fetch } = {}) {
  const base = comfyuiBaseUrl();
  const connectTimeoutMs = Math.max(500, Number(env("COMFYUI_CONNECT_TIMEOUT_MS", "5000")) || 5000);
  const totalTimeoutMs = Math.max(5000, Number(env("COMFYUI_TIMEOUT_MS", "120000")) || 120000);

  const { workflow, styleKey, checkpoint } = comfyuiWorkflowForStyle(style, { prompt, seed, width, height });

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
    // selected and the checkpoint that actually rendered this image.
    model: styleKey,
    checkpoint
  };
}
