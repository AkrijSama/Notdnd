import crypto from "node:crypto";
import { generateWithProvider } from "../ai/providers.js";
import { getSoloRun, updateNpcIdentity } from "../db/repository.js";
import { rebuildCampaignIndex } from "../gm/memoryStore.js";
import { writeNpcMemoryDoc } from "./npcMemory.js";

// ---------------------------------------------------------------------------
// Procedural NPC identity.
//
// The world is generated, so NPCs are roles until an identity is minted for
// them: a name, an appearance, a personality, and a portrait prompt the image
// worker can render. generateNpcIdentity() is pure (returns data, never mutates
// state); the queue/worker below mirrors imageWorker.js for the async
// first-encounter path and persists via a narrow repository write.
//
// Text generation goes through the provider abstraction (providers.js). When no
// text provider is configured (placeholder/local, or non-JSON output), a
// deterministic fallback identity is synthesised from the role + identitySeed so
// the pipeline always yields non-null, reproducible fields offline and in tests.
// ---------------------------------------------------------------------------

// Deterministic per-run name pool for the offline/fallback path.
const FALLBACK_NAMES = [
  "Brynn", "Mara", "Soren", "Kessa", "Talin", "Vorga", "Ilse", "Garrick",
  "Renn", "Hale", "Sable", "Corwin", "Dru", "Esk", "Fenn", "Yarrow"
];
const FALLBACK_BUILDS = ["lean", "broad-shouldered", "wiry", "stocky", "tall", "weathered"];
const FALLBACK_MARKS = [
  "a jagged scar across one brow", "tired, watchful eyes", "a close-cropped beard",
  "a shaved head and a faded tattoo", "greying hair tied back", "a missing earlobe"
];
const FALLBACK_TRAITS = [
  "guarded but fair", "quick-tempered and loyal", "calm, calculating, patient",
  "warm on the surface, hard underneath", "cynical with a buried streak of mercy",
  "soft-spoken and unnervingly observant"
];

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deterministic 32-bit seed from a world seed + npc index. No Math.random, so
 * the same (worldSeed, npcIndex) always yields the same identitySeed.
 * @param {string} worldSeed
 * @param {number} npcIndex
 * @returns {number}
 */
export function deterministicSeed(worldSeed, npcIndex) {
  const hash = crypto.createHash("sha256").update(`${String(worldSeed)}:${Number(npcIndex) || 0}`).digest();
  return hash.readUInt32BE(0);
}

// Stable index for an NPC that has no positional index (first-encounter path).
function indexFromNpcId(npcId) {
  const hash = crypto.createHash("sha256").update(String(npcId || "")).digest();
  return hash.readUInt32BE(0);
}

function resolveTextProvider(explicit) {
  if (isString(explicit)) {
    return explicit;
  }
  return (
    String(process.env.NOTDND_NPC_IDENTITY_PROVIDER || process.env.NOTDND_TEXT_PROVIDER || "").trim() ||
    "placeholder"
  );
}

function buildIdentityPrompt(role, identitySeed) {
  return [
    `You are generating a single NPC for a dark-fantasy solo RPG.`,
    `Role: ${role}.`,
    `Variation key: ${identitySeed} (use it to vary the result; do not output it).`,
    `Return ONLY compact JSON with exactly these keys and no prose:`,
    `{"generatedName": string, "appearance": string, "personality": string}`,
    `- generatedName: a single evocative first name, no title.`,
    `- appearance: one sentence of physical description suitable for a portrait.`,
    `- personality: one sentence of behavioral traits for the game master.`
  ].join("\n");
}

function parseIdentity(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  // Tolerate models that wrap JSON in prose/fences: grab the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // fall through to null
  }
  return null;
}

function pick(list, seed, offset = 0) {
  return list[(seed + offset) % list.length];
}

function assemblePortraitPrompt(name, role, appearance) {
  return `portrait of ${name}, a ${String(role).toLowerCase()}, ${appearance}, dark fantasy, detailed`;
}

// Builds a complete, non-null identity. User-provided fields (`existing`) are
// authoritative and never overwritten; AI-parsed fields come next; remaining
// gaps are filled deterministically from the role + identitySeed.
function synthesizeIdentity(parsed, role, identitySeed, existing = {}) {
  const safeRole = isString(role) ? role.trim() : "stranger";
  const generatedName = isString(existing.generatedName)
    ? existing.generatedName.trim()
    : isString(parsed?.generatedName)
      ? parsed.generatedName.trim()
      : pick(FALLBACK_NAMES, identitySeed);
  const appearance = isString(existing.appearance)
    ? existing.appearance.trim()
    : isString(parsed?.appearance)
      ? parsed.appearance.trim()
      : `a ${pick(FALLBACK_BUILDS, identitySeed, 1)} ${safeRole.toLowerCase()} with ${pick(FALLBACK_MARKS, identitySeed, 2)}`;
  const personality = isString(existing.personality)
    ? existing.personality.trim()
    : isString(parsed?.personality)
      ? parsed.personality.trim()
      : pick(FALLBACK_TRAITS, identitySeed, 3);
  // A user-set portraitPrompt wins; otherwise (re)assemble from the final
  // name + appearance so a hybrid NPC's prompt reflects user-provided fields.
  const portraitPrompt = isString(existing.portraitPrompt)
    ? existing.portraitPrompt.trim()
    : assemblePortraitPrompt(generatedName, safeRole, appearance);
  return { generatedName, appearance, personality, portraitPrompt };
}

/**
 * Pure: generates an NPC identity for a role. Calls the text provider, falls
 * back to a deterministic identity on any failure/non-JSON output. Never
 * mutates state.
 * @param {{ role?: string, worldSeed?: string, npcIndex?: number, provider?: string, fetchImpl?: typeof fetch }} [args]
 * @returns {Promise<{ generatedName: string, appearance: string, personality: string, portraitPrompt: string, identitySeed: number }>}
 */
export async function generateNpcIdentity({ role, worldSeed, npcIndex, existing = {}, provider, fetchImpl } = {}) {
  const identitySeed = deterministicSeed(worldSeed, npcIndex);
  const safeRole = isString(role) ? role.trim() : "stranger";

  // If the user already supplied every field, skip the AI call entirely.
  const userFields = existing && typeof existing === "object" ? existing : {};
  const allProvided =
    isString(userFields.generatedName) &&
    isString(userFields.appearance) &&
    isString(userFields.personality) &&
    isString(userFields.portraitPrompt);

  let raw = "";
  if (!allProvided) {
    try {
      const result = await generateWithProvider({
        provider: resolveTextProvider(provider),
        type: "gm",
        prompt: buildIdentityPrompt(safeRole, identitySeed),
        fetchImpl
      });
      raw = String(result?.text || "");
    } catch {
      raw = "";
    }
  }

  const identity = synthesizeIdentity(parseIdentity(raw), safeRole, identitySeed, userFields);
  return { ...identity, identitySeed };
}

// ---------------------------------------------------------------------------
// Async worker — first-encounter path. Fire-and-forget, mirrors imageWorker.js.
// ---------------------------------------------------------------------------

const queue = [];
let processing = false;

function logWorker(message, error) {
  // eslint-disable-next-line no-console
  console.error(`[npcIdentity] ${message}${error ? `: ${String(error?.message || error)}` : ""}`);
}

/**
 * Generates and persists identity for one NPC via a narrow repository write.
 * Idempotent: an NPC that already has a generatedName is left untouched.
 * Awaitable (used directly by tests).
 * @param {{ runId: string, npcId: string, provider?: string }} job
 * @returns {Promise<{ ok: boolean, skipped?: boolean, identity?: object, reason?: string }>}
 */
export async function runIdentityJob(job = {}) {
  const runId = String(job.runId || "").trim();
  const npcId = String(job.npcId || "").trim();
  if (!runId || !npcId) {
    return { ok: false, reason: "missing runId or npcId" };
  }

  let run = getSoloRun(runId);
  let npc = run?.npcs?.[npcId] || null;
  if (!npc) {
    return { ok: false, reason: "run or npc not found" };
  }

  const hasFullIdentity =
    isString(npc.generatedName) &&
    isString(npc.appearance) &&
    isString(npc.personality) &&
    isString(npc.portraitPrompt);
  // The memory bridge only applies when the run is linked to a campaign; with no
  // campaignId there is nothing to bridge to, so full identity alone is "done".
  const bridgePending = isString(run?.campaignId) && !isString(npc.memoryDocId);
  if (hasFullIdentity && !bridgePending) {
    return { ok: true, skipped: true };
  }

  // Fill any missing identity fields (respecting user-provided ones).
  if (!hasFullIdentity) {
    const identity = await generateNpcIdentity({
      role: npc.role,
      worldSeed: run.worldSeed,
      npcIndex: indexFromNpcId(npcId),
      existing: {
        generatedName: npc.generatedName,
        appearance: npc.appearance,
        personality: npc.personality,
        portraitPrompt: npc.portraitPrompt
      },
      provider: job.provider
    });
    updateNpcIdentity(runId, npcId, identity);
    run = getSoloRun(runId);
    npc = run?.npcs?.[npcId] || npc;
  }

  // Bridge into the campaign memory graph so the GM can see this NPC. Requires
  // a run→campaign mapping; skip gracefully when the run has no campaignId.
  if (isString(run?.campaignId) && !isString(npc.memoryDocId)) {
    const docId = writeNpcMemoryDoc(run.campaignId, npc);
    if (isString(docId)) {
      updateNpcIdentity(runId, npcId, { memoryDocId: docId });
      try {
        await rebuildCampaignIndex(run.campaignId);
      } catch (error) {
        logWorker("memory reindex failed", error);
      }
    }
  }

  return { ok: true };
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
        await runIdentityJob(job);
      } catch (error) {
        logWorker("job crashed", error);
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Enqueues an NPC identity job. Fire-and-forget: returns immediately, never
 * throws, safe to call from a request path.
 * @param {{ runId: string, npcId: string, provider?: string }} job
 */
export function enqueueIdentityJob(job = {}) {
  if (!job || !job.runId || !job.npcId) {
    return;
  }
  queue.push(job);
  Promise.resolve().then(drainQueue).catch((error) => logWorker("drain failed", error));
}

/**
 * Current number of queued (not-yet-started) identity jobs. For tests/diagnostics.
 * @returns {number}
 */
export function queuedIdentityJobCount() {
  return queue.length;
}
