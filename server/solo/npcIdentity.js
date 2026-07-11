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
    `{"generatedName": string, "gender": string, "appearance": string, "personality": string}`,
    `- generatedName: a single evocative first name, no title.`,
    `- gender: exactly one of "male", "female", or "non-binary".`,
    `- appearance: one sentence of physical description suitable for a portrait, consistent with the gender.`,
    `- personality: one sentence of behavioral traits for the game master.`
  ].join("\n");
}

// #50: normalize a free-form gender string, and infer gender from descriptive text
// (pronouns / gendered nouns) when the model omits it — so the committed entity
// always carries a gender the portrait path can ground on.
function normalizeGender(value) {
  const s = String(value || "").trim().toLowerCase();
  if (/\b(female|woman|girl|she|her)\b/.test(s)) return "female";
  if (/\b(male|man|boy|he|him)\b/.test(s)) return "male";
  if (/non-?binary|enby|androgynous|\bthey\b|\bthem\b/.test(s)) return "non-binary";
  return "";
}
function inferGenderFromText(text) {
  const s = String(text || "").toLowerCase();
  const f = (s.match(/\b(she|her|hers|woman|female|girl|lady|matron|mother|sister|daughter)\b/g) || []).length;
  const m = (s.match(/\b(he|him|his|man|male|boy|fellow|father|brother|son)\b/g) || []).length;
  if (f > m) return "female";
  if (m > f) return "male";
  return "";
}
function pronounsForGender(gender) {
  if (gender === "female") return "she/her";
  if (gender === "male") return "he/him";
  if (gender === "non-binary") return "they/them";
  return "";
}
// Name→gender tiebreaker (mint consistency: the he/him-Mara bug). Used ONLY when
// the model gave no gender AND the appearance text carries no signal — a known
// fallback name, then a light suffix heuristic, keeps name and gender coherent
// instead of leaving a feminine-read name committed male by a coin-flip.
const NAME_GENDER_HINTS = {
  brynn: "female", mara: "female", kessa: "female", ilse: "female", vorga: "female",
  sable: "female", dru: "female", yarrow: "female",
  soren: "male", talin: "male", garrick: "male", renn: "male", hale: "male",
  corwin: "male", esk: "male", fenn: "male"
};
function genderHintFromName(name) {
  const first = String(name || "").trim().split(/\s+/)[0].toLowerCase();
  if (!first) return "";
  if (NAME_GENDER_HINTS[first]) return NAME_GENDER_HINTS[first];
  return /[ae]$/.test(first) && first.length >= 3 ? "female" : "";
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

// --- Committed mannerisms (spit-ban vacuum fill) -----------------------------
// One short, distinctive PHYSICAL tell per NPC, drawn from this curated pool so
// the model has committed character texture to voice instead of reaching for the
// stock "spits to the side". Register rules for the pool (owner law): NO bodily
// fluids, NO tics that read as a slur or a medical/neurological condition; no two
// alike in tone. Assigned at mint, unique per run, grounded into the GM context.
export const NPC_MANNERISMS = Object.freeze([
  "turns a ring on one finger while thinking",
  "never quite finishes a drink",
  "stands a little too straight, like a soldier at ease",
  "counts on their fingers before answering",
  "keeps one hand resting near a pocket",
  "tilts their head when they disagree",
  "smooths an eyebrow with a thumb",
  "lets silences run a beat too long",
  "taps a rhythm against whatever is nearest",
  "folds their arms and then thinks better of it",
  "glances at the exits out of old habit",
  "speaks more softly the angrier they get",
  "finishes other people's sentences",
  "keeps their sleeves rolled to the same exact fold",
  "studies your hands more than your face",
  "laughs one beat after everyone else",
  "cracks their knuckles one at a time, slowly",
  "always knows where the nearest wall is and stays near it",
  "answers a question with a question",
  "picks lint that isn't there off their coat",
  "measures a room by pacing it once, quietly",
  "holds eye contact a shade too long",
  "hums under their breath between sentences",
  "sorts coins or trinkets by size while talking",
  "repeats the last word of a hard truth",
  "keeps a tally of small favors, out loud",
  "shifts weight foot to foot when impatient",
  "traces old scars without noticing",
  "leaves a chair pushed out, never squared",
  "starts to speak, stops, then starts again lower",
  "watches the door whenever it opens, mid-sentence",
  "clasps their hands behind their back to keep them still",
  "names a price and then waits, dead still",
  "wipes clean glasses that are already clean"
]);

/** Committed mannerisms the roster already holds (for per-run uniqueness). */
export function npcTakenMannerisms(run, excludeNpcId = null) {
  return Object.values(run?.npcs || {})
    .filter((npc) => npc && npc.npcId !== excludeNpcId)
    .map((npc) => npc.mannerism)
    .filter((m) => isString(m) && m.trim());
}

// Pure. Returns a pool mannerism not already used in `takenMannerisms`, rotating
// from the seed; falls back to a seeded pick when the pool is exhausted (>34 NPCs).
export function pickUniqueMannerism(takenMannerisms = [], seed = 0) {
  const taken = new Set([...takenMannerisms].map((m) => String(m || "").trim().toLowerCase()).filter(Boolean));
  for (let i = 0; i < NPC_MANNERISMS.length; i += 1) {
    const candidate = NPC_MANNERISMS[(Math.abs(seed) + i) % NPC_MANNERISMS.length];
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return NPC_MANNERISMS[Math.abs(seed) % NPC_MANNERISMS.length];
}

// BACKFILL (item 3d, the gender-backfill pattern): give any committed NPC in
// `npcIds` that predates the mannerism field one now, unique across the roster.
// Mutates run.npcs in place; returns the ids backfilled (empty when none). The
// caller persists the run. Pure aside from the in-place assignment.
export function backfillNpcMannerisms(run, npcIds = []) {
  const ids = Array.isArray(npcIds) ? npcIds : [];
  const done = [];
  for (const npcId of ids) {
    const npc = run?.npcs?.[npcId];
    if (!npc || (isString(npc.mannerism))) {
      continue;
    }
    const seed = Number.isFinite(npc.identitySeed) ? npc.identitySeed : indexFromNpcId(npcId);
    npc.mannerism = pickUniqueMannerism(npcTakenMannerisms(run, npcId), seed);
    done.push(npcId);
  }
  return done;
}

// --- Per-run first-name uniqueness (the two-Maras bug) -----------------------
// Two mints in one run can land the same first name (the model repeats itself,
// or two fallback picks collide) — two committed "Mara"s then share one identity
// in the fiction and the narration can't tell them apart. Uniqueness is enforced
// at MINT time against the committed roster; the narrated-commit path (#27)
// instead dedup-BINDS to the existing entity (npcCommit.js), never renames.

function firstTokenLc(name) {
  return String(name || "").trim().split(/\s+/)[0].toLowerCase();
}

/** Names the committed roster already holds (generated + display), minus one npc. */
export function npcTakenNames(run, excludeNpcId = null) {
  return Object.values(run?.npcs || {})
    .filter((npc) => npc && npc.npcId !== excludeNpcId)
    .flatMap((npc) => [npc.generatedName, npc.displayName])
    .filter((name) => isString(name));
}

/**
 * Pure. Returns `name` if its FIRST name is unused in `takenNames`, else the
 * first unused FALLBACK_NAMES entry (rotating from the seed), else a suffixed
 * form. Articles/initials in placeholder display names ("A shaken traveler")
 * are ignored (tokens < 3 chars never block a real name).
 */
export function ensureUniqueFirstName(name, takenNames = [], identitySeed = 0) {
  const candidate = String(name || "").trim();
  if (!candidate) {
    return candidate;
  }
  const taken = new Set(
    [...takenNames].map(firstTokenLc).filter((token) => token.length >= 3)
  );
  if (!taken.has(firstTokenLc(candidate))) {
    return candidate;
  }
  for (let i = 0; i < FALLBACK_NAMES.length; i += 1) {
    const alt = FALLBACK_NAMES[(Math.abs(identitySeed) + i) % FALLBACK_NAMES.length];
    if (!taken.has(alt.toLowerCase())) {
      return alt;
    }
  }
  return `${candidate} the Younger`;
}

function assemblePortraitPrompt(name, role, appearance, gender = "") {
  // #50: name the gender FIRST so the base model renders the right figure (the
  // Mara-rendered-male bug) instead of defaulting to a male portrait.
  const genderWord =
    gender === "female" ? "a woman, " : gender === "male" ? "a man, " : gender === "non-binary" ? "an androgynous person, " : "";
  return `portrait of ${name}, ${genderWord}a ${String(role).toLowerCase()}, ${appearance}, dark fantasy, detailed`;
}

// Builds a complete, non-null identity. User-provided fields (`existing`) are
// authoritative and never overwritten; AI-parsed fields come next; remaining
// gaps are filled deterministically from the role + identitySeed.
function synthesizeIdentity(parsed, role, identitySeed, existing = {}, takenNames = [], takenMannerisms = []) {
  const safeRole = isString(role) ? role.trim() : "stranger";
  // Uniquify BEFORE the portrait prompt is assembled, so the prompt carries the
  // final name. A USER-provided name is authoritative and never renamed.
  const generatedName = isString(existing.generatedName)
    ? existing.generatedName.trim()
    : ensureUniqueFirstName(
        isString(parsed?.generatedName) ? parsed.generatedName.trim() : pick(FALLBACK_NAMES, identitySeed),
        takenNames,
        identitySeed
      );
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
  // #50: gender — user-set wins, then the model's, then inferred from the final
  // name + appearance; pronouns derive from it. Empty only when nothing signals it.
  const gender =
    normalizeGender(existing.gender) ||
    normalizeGender(parsed?.gender) ||
    inferGenderFromText(`${appearance} ${generatedName}`) ||
    // last resort: keep name and gender coherent (the he/him-Mara mint bug)
    genderHintFromName(generatedName);
  const pronouns = isString(existing.pronouns) ? existing.pronouns.trim() : pronounsForGender(gender);
  // A user-set portraitPrompt wins; otherwise (re)assemble from the final
  // name + gender + appearance so the portrait matches the committed character.
  const portraitPrompt = isString(existing.portraitPrompt)
    ? existing.portraitPrompt.trim()
    : assemblePortraitPrompt(generatedName, safeRole, appearance, gender);
  // Committed mannerism (spit-ban vacuum fill): a user-set value wins; otherwise
  // draw from the CURATED pool (never the model's free text, which is the source
  // of the stock "spits to the side"), unique across the run roster.
  const mannerism = isString(existing.mannerism) && existing.mannerism.trim()
    ? existing.mannerism.trim()
    : pickUniqueMannerism(takenMannerisms, identitySeed);
  return { generatedName, gender, pronouns, appearance, personality, portraitPrompt, mannerism };
}

/**
 * Pure: generates an NPC identity for a role. Calls the text provider, falls
 * back to a deterministic identity on any failure/non-JSON output. Never
 * mutates state.
 * @param {{ role?: string, worldSeed?: string, npcIndex?: number, provider?: string, fetchImpl?: typeof fetch }} [args]
 * @returns {Promise<{ generatedName: string, appearance: string, personality: string, portraitPrompt: string, identitySeed: number }>}
 */
export async function generateNpcIdentity({ role, worldSeed, npcIndex, existing = {}, takenNames = [], takenMannerisms = [], provider, fetchImpl } = {}) {
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

  const identity = synthesizeIdentity(parseIdentity(raw), safeRole, identitySeed, userFields, takenNames, takenMannerisms);
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
      // Per-run first-name uniqueness: never mint a name the roster already holds.
      takenNames: npcTakenNames(run, npcId),
      takenMannerisms: npcTakenMannerisms(run, npcId),
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
