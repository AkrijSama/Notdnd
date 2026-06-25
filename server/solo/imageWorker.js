import fs from "node:fs";
import path from "node:path";
import { generateImage } from "../ai/providers.js";
import { ensureNpcImageAssets, getSoloRun, updateImageAssetStatus } from "../db/repository.js";
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

// Resolved at call time (not module load) so tests can redirect the root.
function assetsRoot() {
  return process.env.NOTDND_ASSETS_ROOT
    ? path.resolve(process.env.NOTDND_ASSETS_ROOT)
    : path.resolve(process.cwd(), "data/assets");
}

function diskPathFor(runId, npcId, slot) {
  return path.join(assetsRoot(), String(runId), String(npcId), `${slot}.png`);
}

// Public URI served by the existing static handler (serveStatic, repo root).
function servedUriFor(runId, npcId, slot) {
  return `/data/assets/${encodeURIComponent(runId)}/${encodeURIComponent(npcId)}/${slot}.png`;
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

// Generates one slot, writes bytes to disk, and flips the asset's status.
// On any failure the asset is marked `failed`; the error is swallowed so a
// single bad variant never aborts the rest of the job. The base portrait
// (referenceImageUrl null) is produced via text-to-image; expression variants
// pass the base portrait as the IP-Adapter reference (image-to-image).
async function generateSlot({ runId, npcId, slot, assetId, prompt, style, referenceImageUrl }) {
  try {
    const result = await generateImage({ prompt, style, referenceImageUrl });
    const bytes = result?.bytes;
    if (!bytes || !bytes.length) {
      throw new Error("image provider returned no bytes");
    }
    const target = diskPathFor(runId, npcId, slot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    updateImageAssetStatus(runId, assetId, "generated", servedUriFor(runId, npcId, slot));
    return { slot, ok: true, uri: servedUriFor(runId, npcId, slot) };
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
  // Prefer an explicit job prompt, then the NPC's generated portraitPrompt,
  // then a role-based fallback (never the bare npcId stub).
  const basePrompt = String(
    job.basePrompt ||
    npc?.portraitPrompt ||
    `portrait of a ${npc?.role || npcId}, dark fantasy, detailed`
  ).trim();

  // Base portrait first (text-to-image) — it anchors every variant.
  const base = await generateSlot({
    runId,
    npcId,
    slot: "base",
    assetId: linked.base,
    prompt: `${basePrompt}, neutral expression`,
    style,
    referenceImageUrl: null
  });
  const referenceImageUrl = base.ok ? referenceUrlFor(base.uri) : null;

  const variants = [];
  for (const expression of NPC_EXPRESSIONS) {
    const assetId = linked.variants[expression];
    if (!assetId) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const variant = await generateSlot({
      runId,
      npcId,
      slot: expression,
      assetId,
      prompt: `${basePrompt}, ${expression} expression`,
      style,
      referenceImageUrl
    });
    variants.push(variant);
  }

  return { ok: true, base, variants };
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
        await runImageJob(job);
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
 * Current number of queued (not-yet-started) jobs. Exposed for tests/diagnostics.
 * @returns {number}
 */
export function queuedJobCount() {
  return queue.length;
}
