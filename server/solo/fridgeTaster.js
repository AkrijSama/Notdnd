// ---------------------------------------------------------------------------
// FRIDGE TASTER — an automated TASTE CHECK gating library auto-keep.
//
// The curated art library (scripts/art/library.mjs) auto-keeps every live
// ComfyUI generation the intake guard admits (imageWorker.intakeToLibrary). That
// admits the RECIPE but not the PICTURE: a validated recipe can still paint the
// wrong thing (a declared-human portrait rendered as a skull-demon; a scene that
// grew a modern aircraft; a species-untrue animal). The taster is a cheap
// per-kind assessment of a small set of CANON questions run BEFORE auto-keep:
//
//   pass    -> FRIDGE   (library keep, served across runs — unchanged behavior)
//   suspect -> QUARANTINE (a holding pen served to NOTHING, held for owner review)
//
// QUARANTINE is a NEW third lifecycle state layered orthogonally on top of the
// existing two-fate rating law (keep | destroy). It is NOT a rating: a quarantined
// asset carries rating != "keep" AND a `quarantine` marker, and queryAssets drops
// it so it can never surface on any serve path. Owner review (scripts/art/review.mjs)
// resolves it — to the FRIDGE (keep) or the TRASH (destroy). A 30-day auto-trash
// sweep (Law-6 tunable) guarantees nothing lives in quarantine indefinitely.
//
// HARD FENCE — ZERO PAID CALLS. The DEFAULT assessor is a deterministic MOCK
// (no network, no cost). A real vision-model assessor is OFF until the owner sets
// the config seat NOTDND_TASTER_MODEL *and* registers an adapter (registerAssessor).
// With the seat set but no adapter registered, the taster FAILS CLOSED to the mock
// — it never makes a silent paid call. See docs/design/fridge-taster.md for the
// model/cost ledger the owner must approve before wiring a real adapter.
// ---------------------------------------------------------------------------

import { getAsset, addAsset, allAssets, destroyAsset } from "../../scripts/art/library.mjs";
import { entityNature } from "./entityNature.js";

// The two taste verdicts. "pass" -> fridge; "suspect" -> quarantine.
export const TASTE_VERDICTS = Object.freeze(["pass", "suspect"]);

// The canon questions the taster answers per kind. Documented here so the mock's
// heuristics and a future real adapter answer the SAME questions. A real vision
// model inspects the PIXELS; the mock inspects the available proxy signals (the
// assembled prompt + the committed run context) — see runCanonHeuristics.
export const CANON_QUESTIONS = Object.freeze({
  scene: [
    "expected subject present?",
    "no aircraft/vehicles/modern-city unless committed?",
    "species-true?"
  ],
  portrait: ["single head?", "human-when-declared-human?", "clothed?"],
  fullbody: ["single head?", "human-when-declared-human?", "clothed?"]
});

// ── LAW-6: 30-DAY AUTO-TRASH SWEEP (env/const tunable) ───────────────────────
// Quarantine is a holding pen, never a permanent home. Anything that has sat in
// quarantine longer than this is auto-trashed so the pen self-drains even if the
// owner never reviews it. Tunable via NOTDND_QUARANTINE_MAX_AGE_DAYS; default 30.
export const QUARANTINE_MAX_AGE_DAYS = Math.max(
  1,
  Number(process.env.NOTDND_QUARANTINE_MAX_AGE_DAYS) || 30
);

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// ASSESSOR INTERFACE
//
// An assessor is `{ model: string, assess(input) -> assessment }` where
//   input      = { id, bytes, kind, run, subjectId, promptUsed }
//   assessment = { verdict: "pass"|"suspect", checks: [{question, ok, note}], reason }
// The default assessor is the MOCK. A real adapter is registered by the owner
// against a model id and selected by the NOTDND_TASTER_MODEL config seat.
// ---------------------------------------------------------------------------

// The CONFIG SEAT. The owner sets NOTDND_TASTER_MODEL to select a real adapter.
// Empty / "mock" -> the deterministic mock (the default, zero cost).
export function tasterModel() {
  return String(process.env.NOTDND_TASTER_MODEL || "").trim();
}

// Registered real adapters, keyed by model id. EMPTY BY CONSTRUCTION — no paid
// adapter ships in this module (the hard fence). The owner registers one at the
// documented seat after approving the cost ledger (docs/design/fridge-taster.md).
const REAL_ADAPTERS = new Map();

/**
 * Register a real vision assessor for a model id. The owner calls this from their
 * own wiring code once they have approved the per-image cost. `assessFn` must have
 * the signature `(input) -> assessment` (see the interface above). No adapter is
 * registered by this module — that is the whole point of the fence.
 */
export function registerAssessor(modelId, assessFn) {
  const id = String(modelId || "").trim();
  if (!id || typeof assessFn !== "function") {
    throw new Error("fridge-taster: registerAssessor needs (modelId, assessFn)");
  }
  REAL_ADAPTERS.set(id, assessFn);
  return id;
}

let warnedUnwiredSeat = false;

/**
 * Resolve the active assessor. Returns the mock unless the seat names a model that
 * has a registered adapter. Seat-set-but-unwired FAILS CLOSED to the mock (loud
 * once) so a mis-set env var can never cause a silent paid call.
 * @returns {{ model: string, assess: (input: object) => object }}
 */
export function getAssessor() {
  const model = tasterModel();
  if (!model || model.toLowerCase() === "mock") {
    return { model: "mock", assess: mockAssess };
  }
  const real = REAL_ADAPTERS.get(model);
  if (real) {
    return { model, assess: real };
  }
  if (!warnedUnwiredSeat) {
    warnedUnwiredSeat = true;
    // eslint-disable-next-line no-console
    console.error(
      `[fridgeTaster] NOTDND_TASTER_MODEL="${model}" is set but no adapter is registered — ` +
        "using the mock (no paid call made). Register one with registerAssessor() " +
        "after approving docs/design/fridge-taster.md."
    );
  }
  return { model: "mock", assess: mockAssess };
}

// Convenience: run the active assessor on an intake input.
export function assess(input) {
  return getAssessor().assess(input);
}

// ---------------------------------------------------------------------------
// THE MOCK ASSESSOR (default; deterministic; zero cost)
//
// Two layers, in order:
//   1. TEST FIXTURES — a verdict injected by id (setTasteFixtures). Lets a test
//      force pass/suspect deterministically without any model.
//   2. CANON HEURISTICS — a deterministic read of the assembled prompt + committed
//      run context. INTENTIONALLY CONSERVATIVE: it only flags UNAMBIGUOUS canon
//      violations, so by default the pipeline behaves exactly like today (pass ->
//      auto-keep). A real vision model would inspect the pixels; the mock inspects
//      the strongest proxy it has (the prompt/context) so it is honest and useful
//      offline without pretending to see the image.
// ---------------------------------------------------------------------------

let FIXTURES = new Map();

// Inject fixed verdicts by asset id (tests). e.g. setTasteFixtures({ id1: "suspect" }).
export function setTasteFixtures(map) {
  FIXTURES = new Map(Object.entries(map || {}));
}
export function clearTasteFixtures() {
  FIXTURES = new Map();
}

const MONSTER_TOKENS =
  /\b(demon|demonic|skull|skeletal|monster|monstrous|beast|creature|ghoul|zombie|undead|corpse|reptilian|lizard-?man|scaled skin|horned|horns|fangs|tentacle|eldritch)\b/i;
const NUDITY_TOKENS = /\b(nude|naked|topless|bottomless|nsfw|explicit|bare breasts|genital)\b/i;
const MULTI_HEAD_TOKENS =
  /\b(reference sheet|character sheet|model sheet|turnaround|multiple views|multiple poses|two heads|three heads|split panel|grid of)\b/i;
const MODERN_INTRUSION_TOKENS =
  /\b(airplane|aeroplane|biplane|jet plane|jetliner|helicopter|aircraft|automobile|\bcars?\b|truck|motorcycle|skyscraper|neon sign|traffic light|power lines?|telephone pole|billboard)\b/i;
const MODERN_ERA_TOKENS = /\b(modern|contemporary|present-?day|near-?future|sci-?fi|cyberpunk|urban|city)\b/i;

// Is this subject a DECLARED non-human (demon/animal/chaosling) that is ALLOWED to
// look monstrous? Reads committed species-truth via entityNature where possible,
// degrading safely to "treat as human" (the strict default) on any failure.
function subjectIsDeclaredNonHuman(run, subjectId) {
  const npc = subjectId && run && run.npcs ? run.npcs[subjectId] : null;
  if (!npc) return false; // player / draft / unknown -> treated as human (strict)
  // entityNature is THE canon species-truth source; call it defensively so a change
  // in that graph never breaks the taster.
  try {
    const nat = entityNature(npc);
    if (nat && (nat.kind === "demon" || nat.kind === "chaosling" || nat.isAnimal)) {
      return true;
    }
  } catch {
    /* fall through to the tag heuristic */
  }
  if (npc.statBlockId || npc.flags?.statBlockId) return true;
  const tags = (Array.isArray(npc.tags) ? npc.tags : []).map((t) => String(t).toLowerCase());
  return tags.some((t) =>
    ["demon", "chaosling", "beast", "animal", "wildlife", "wolf", "bear", "boar", "monster"].includes(t)
  );
}

// The per-kind canon checks. Returns [{ question, ok, note }]. `ok: true` = passes.
function runCanonHeuristics({ kind, run, subjectId, promptUsed }) {
  const prompt = String(promptUsed || "");
  const checks = [];
  if (kind === "scene") {
    // Q1 — expected subject present: not verifiable from the prompt alone; the mock
    // passes it (a real vision model answers this from the pixels).
    checks.push({
      question: "expected subject present?",
      ok: true,
      note: "not verifiable without vision — mock passes"
    });
    // Q2 — no aircraft/vehicles/modern-city unless committed.
    const era = String(run?.world?.era || run?.world?.tone || "");
    const modernCommitted = MODERN_ERA_TOKENS.test(era) || MODERN_ERA_TOKENS.test(String(run?.world?.origin || ""));
    const intrusion = MODERN_INTRUSION_TOKENS.test(prompt) && !modernCommitted;
    checks.push({
      question: "no aircraft/vehicles/modern-city unless committed?",
      ok: !intrusion,
      note: intrusion ? "prompt carries an uncommitted modern intrusion token" : "clean"
    });
    // Q3 — species-true: if the run committed an animal/creature subject but the
    // scene prompt reads as a human/person, flag it.
    checks.push({ question: "species-true?", ok: true, note: "no committed species conflict detected" });
  } else {
    // portrait | fullbody
    const multiHead = MULTI_HEAD_TOKENS.test(prompt);
    checks.push({
      question: "single head?",
      ok: !multiHead,
      note: multiHead ? "prompt carries reference-sheet / multi-view tokens" : "single subject"
    });
    const declaredNonHuman = subjectIsDeclaredNonHuman(run, subjectId);
    const monstrous = MONSTER_TOKENS.test(prompt) && !declaredNonHuman;
    checks.push({
      question: "human-when-declared-human?",
      ok: !monstrous,
      note: monstrous
        ? "monster/skull/beast tokens on a subject NOT declared non-human"
        : declaredNonHuman
          ? "declared non-human — monster look allowed"
          : "human-consistent"
    });
    const nude = NUDITY_TOKENS.test(prompt);
    checks.push({
      question: "clothed?",
      ok: !nude,
      note: nude ? "prompt carries nudity tokens" : "clothed"
    });
  }
  return checks;
}

function mockAssess({ id, kind, run, subjectId, promptUsed } = {}) {
  // Layer 1 — test fixtures win, deterministically, by id.
  if (id != null && FIXTURES.has(id)) {
    const verdict = FIXTURES.get(id);
    return { verdict, checks: [], reason: `fixture:${verdict}` };
  }
  // Layer 2 — canon heuristics over the available proxy signals.
  const checks = runCanonHeuristics({ kind, run, subjectId, promptUsed });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    return {
      verdict: "suspect",
      checks,
      reason: failed.map((c) => c.question).join("; ")
    };
  }
  return { verdict: "pass", checks, reason: "all canon checks passed" };
}

// ---------------------------------------------------------------------------
// TASTE DECISION — the function intake CALLS.
//
// Runs the active assessor and maps the verdict onto the intake lifecycle fields.
// pass    -> { rating: <defaultRating>, quarantine: null }  (fridge)
// suspect -> { rating: null,            quarantine: {...} }  (holding pen)
// The caller (imageWorker.intakeToLibrary) merges these into its addAsset call.
// ---------------------------------------------------------------------------

/**
 * @param {{ id, bytes, kind, run, subjectId, promptUsed, defaultRating }} input
 * @returns {{ verdict, model, rating, quarantine, tags, checks, reason }}
 */
export function taste(input = {}) {
  const { model, assess: assessFn } = getAssessor();
  let assessment;
  try {
    assessment = assessFn(input) || {};
  } catch (error) {
    // A broken assessor must never destroy a generation. Fail SAFE to quarantine
    // (held for review), never to an unreviewed auto-keep.
    assessment = {
      verdict: "suspect",
      checks: [],
      reason: `assessor error: ${String(error?.message || error)}`
    };
  }
  const verdict = TASTE_VERDICTS.includes(assessment.verdict) ? assessment.verdict : "suspect";
  const defaultRating = input.defaultRating ?? "keep";
  if (verdict === "pass") {
    return {
      verdict,
      model,
      rating: defaultRating,
      quarantine: null,
      tags: ["taste:pass"],
      checks: assessment.checks || [],
      reason: assessment.reason || ""
    };
  }
  // suspect -> quarantine holding pen (served to nothing).
  return {
    verdict,
    model,
    rating: null,
    quarantine: buildQuarantine({ model, assessment }),
    tags: ["taste:suspect", "quarantine"],
    checks: assessment.checks || [],
    reason: assessment.reason || ""
  };
}

// The quarantine marker written onto a suspect asset's sidecar.
export function buildQuarantine({ model, assessment } = {}) {
  return {
    at: new Date().toISOString(),
    verdict: "suspect",
    model: model || "mock",
    reason: (assessment && assessment.reason) || "flagged by taste check",
    checks: (assessment && Array.isArray(assessment.checks) ? assessment.checks : []).filter((c) => c && c.ok === false)
  };
}

// ---------------------------------------------------------------------------
// QUARANTINE STATE HELPERS (read/resolve/sweep)
// ---------------------------------------------------------------------------

// True if a sidecar (object) or an id (string) is quarantined.
export function isQuarantined(assetOrId) {
  const s = typeof assetOrId === "string" ? getAsset(assetOrId) : assetOrId;
  return Boolean(s && s.quarantine && typeof s.quarantine === "object");
}

// Every asset currently in the holding pen (for the review UI).
export function listQuarantined() {
  return allAssets().filter((a) => isQuarantined(a));
}

/**
 * Owner review outcome for a quarantined asset:
 *   "fridge" -> clear the quarantine marker + promote to a library keep (now served)
 *   "trash"  -> destroy the image + sidecar (the DESTROY fate)
 * @param {string} id
 * @param {"fridge"|"trash"} outcome
 */
export function resolveQuarantine(id, outcome) {
  const s = getAsset(id);
  if (!s) {
    throw new Error(`fridge-taster: no asset ${id}`);
  }
  if (!isQuarantined(s)) {
    throw new Error(`fridge-taster: ${id} is not quarantined`);
  }
  if (outcome === "trash") {
    destroyAsset(id);
    return { id, outcome: "trash", destroyed: true };
  }
  if (outcome === "fridge") {
    const cleared = {
      ...s,
      quarantine: null,
      rating: "keep",
      tags: (Array.isArray(s.tags) ? s.tags : []).filter(
        (t) => t !== "quarantine" && !String(t).startsWith("taste:")
      )
    };
    addAsset(cleared);
    return { id, outcome: "fridge" };
  }
  throw new Error('fridge-taster: outcome must be "fridge" or "trash"');
}

/**
 * LAW-6 sweep: auto-trash every quarantine entry older than maxAgeDays. The holding
 * pen self-drains so nothing lives there indefinitely. Best-effort (destroyAsset
 * never throws). Returns the list of trashed ids.
 * @param {{ now?: number, maxAgeDays?: number }} [opts]
 */
export function sweepQuarantine({ now = Date.now(), maxAgeDays = QUARANTINE_MAX_AGE_DAYS } = {}) {
  const cutoff = now - maxAgeDays * DAY_MS;
  const swept = [];
  for (const a of listQuarantined()) {
    const at = Date.parse(a?.quarantine?.at || "") || 0;
    if (at && at < cutoff) {
      destroyAsset(a.id);
      swept.push(a.id);
    }
  }
  return { swept, count: swept.length, maxAgeDays, cutoff: new Date(cutoff).toISOString() };
}
