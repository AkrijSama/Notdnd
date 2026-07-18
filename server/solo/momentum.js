import crypto from "node:crypto";
import { validateSoloRun } from "./schema.js";
import { momentumCandidates } from "../campaign/momentumEvents.js";
import { loadThreadsFromJson } from "./threads.js";
import { mintTraceFromSpawn } from "./essence.js";

// item 4b — MOMENTUM PROMOTION (closes the fake-urgency class at its source). A
// momentum event whose build() returns a `deadline` { minutes, consequenceBrief,
// consequenceDecision } also COMMITS a thread with a world-clock deadline, so the
// urgency the GM narrates ("the storm is minutes away") is backed by a committed
// referent (deadlineAudit) instead of invented. The threads engine owns the clock /
// expiry / consequence machinery; this only births the front from the event.
function promoteEventToDeadlineThread(run, event, built) {
  const deadline = built && built.deadline;
  if (!deadline || !Number.isFinite(Number(deadline.minutes))) return null;
  const threadId = `thread_momentum_${event.templateId}`;
  if (run.threads && run.threads[threadId]) return null; // already promoted this run
  const nowMin = Number(run?.world?.time?.minutes);
  const expiresAtMinutes = Number.isFinite(nowMin) ? nowMin + Math.round(Number(deadline.minutes)) : null;
  const front = {
    frontId: threadId,
    kind: "danger",
    origin: "momentum",
    title: event.title,
    agenda: event.brief,
    revealState: "revealed", // the player was just told — committed, known pressure
    groundedIn: { locationRefs: [run.currentLocationId] },
    clock: { minTurnsBetweenBeats: 1, expiresAtMinutes },
    beats: [
      {
        beatId: "b_consequence",
        label: "the deadline lapses",
        reveal: "revealed",
        brief: String(deadline.consequenceBrief || `${event.title} — the moment to act has passed.`),
        decision: String(deadline.consequenceDecision || "React to what has now happened."),
        trigger: { prescriptive: { minTurn: 0 } },
        payload: { fact: { text: String(deadline.consequenceBrief || `${event.title}: the window closed.`) } }
      }
    ],
    resolution: [{ kind: "beat_final", outcome: "expired" }]
  };
  const res = loadThreadsFromJson(run, [front], {});
  return res.loaded.length ? { threadId, expiresAtMinutes } : null;
}

// ---------------------------------------------------------------------------
// THE MOMENTUM ENGINE — the world's own forward pressure.
//
// The verified gap this closes: the turn pipeline was purely REACTIVE — zero
// proactive mechanism (no event injection, no clocks, no GM-initiated
// complications). A player poking a static scene got a mirror, not a GM; the
// 13-turn static diorama session was structurally guaranteed by the code.
//
// Architecture (propose -> server-adjudicate -> commit -> narrate):
//   1. SITUATION PRESSURE: a per-run tension clock (run.flags.momentum) advances
//      on quiet turns (+2) and failures (+1); real progress bleeds it off (-1).
//      It can only FIRE on a non-progress turn, past a cooldown, on a live run.
//   2. SELECTION: when it fires, the SERVER selects a template from the
//      server-authored pool (campaign/momentumEvents.js) — seeded-deterministic
//      (worldSeed + turn counter). An optional rankFn may reorder the shortlist
//      (that is the LLM's entire permitted role: choosing among real options —
//      it can never introduce one).
//   3. COMMIT: the event's payload is written to run state FIRST — an arriving
//      NPC into the cast, an objectState onto the location (same entry shape as
//      the consequence spine, so foreclosure composes), a hook as a real tracked
//      quest — plus a memoryFact and a timeline event. validateSoloRun gates the
//      result; a payload that doesn't validate is rolled back and NOT narrated.
//   4. NARRATE: the committed record rides the GM context (result.momentumEvent
//      -> narration directive; scene.recentDevelopment -> next-scene context).
//      Nothing is narrated that was not committed in step 3.
// ---------------------------------------------------------------------------

export const MOMENTUM_TUNING = Object.freeze({
  fireAt: 6, // tension threshold — 3 fully quiet turns (2+2+2)
  quietStep: 2, // a turn that committed NOTHING: the world leans in
  failStep: 1, // a failed contested attempt: pressure, but the turn had teeth
  progressRelief: 1, // real progress bleeds tension off (never below 0)
  cooldownTurns: 3 // minimum turns between fires — pressure, not spam
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromOption(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return nowIso();
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

// Deterministic non-negative hash (same construction as quests.hashSeed) — the
// selection seed is worldSeed + turnCount, so the SAME run replays identically
// and two runs differ.
function hashSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** The per-run momentum state, created on first touch. Lives in run.flags. */
export function ensureMomentumState(run) {
  if (!isPlainObject(run.flags)) {
    run.flags = {};
  }
  if (!isPlainObject(run.flags.momentum)) {
    run.flags.momentum = {
      tension: 0,
      turnCount: 0,
      lastFiredTurn: null,
      firedTemplateIds: [],
      lastEvent: null
    };
  }
  return run.flags.momentum;
}

/**
 * Classifies a resolved turn for the clock. PROGRESS = the turn committed real
 * advancement (move, reveal, take, accept, quest movement, item use, a won
 * contested roll, a rest, a newly revealed conversation beat). FAIL = a
 * contested attempt that missed. QUIET = everything else — the turn changed
 * nothing (the static-diorama class).
 * @param {object} result the finalize-stage action result
 * @returns {"progress"|"fail"|"quiet"}
 */
export function classifyTurnForMomentum(result) {
  if (!isPlainObject(result)) {
    return "quiet";
  }
  const progressed =
    Boolean(result.moved) ||
    result.action?.type === "move" ||
    result.searchResult?.found === true ||
    result.takeResult?.taken === true ||
    Boolean(result.questAccepted) ||
    Boolean(result.questJustAdvanced) ||
    Boolean(result.runWon) ||
    (Array.isArray(result.playerObjectiveCaptured) ? result.playerObjectiveCaptured.length > 0 : Boolean(result.playerObjectiveCaptured)) ||
    result.useItemResult?.ok === true ||
    Boolean(result.useItemResult?.itemId) ||
    Boolean(result.restResult?.allowed) ||
    result.talkResult?.revealed === true;
  // NOTE deliberately absent: a WON contested roll is NOT progress by itself.
  // A win that matters lands a committed effect (quest advance, reveal, object
  // change) and registers through those; a won roll that commits nothing is the
  // static-diorama class in a trench coat — tension builds through it.
  if (progressed) {
    return "progress";
  }
  if (result.attemptResult && result.attemptResult.success === false) {
    return "fail";
  }
  return "quiet";
}

// The player-facing HP gauge (dying players are not interrupted by the weather).
function playerIsDying(run) {
  const status = run?.player?.status;
  return status === "dying" || status === "dead";
}

function createMomentumMemoryFact(run, event, options) {
  const now = isoFromOption(options.now);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    factId: idFactory("fact_momentum"),
    entityIds: [...new Set([run.runId, run.currentLocationId, ...(event.committed.entityIds || [])])],
    type: "momentum_event",
    text: event.brief,
    source: "system",
    createdAt: now,
    tags: ["system", "momentum"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: { templateId: event.templateId, kind: event.kind }
  };
}

function createMomentumTimelineEvent(run, event, memoryFact, options) {
  const now = isoFromOption(options.now);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    eventId: idFactory("event_momentum"),
    type: "momentum",
    title: event.title,
    summary: event.brief,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, run.currentLocationId, ...(event.committed.entityIds || [])])],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "momentum"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: { templateId: event.templateId, kind: event.kind, committed: event.committed }
  };
}

// Match-token derivation for hazard objectStates (mirrors the consequence
// spine's player-derived keys): significant words from the label, so a later
// attempt that re-targets "the east wall" hits the same entry and foreclosure
// composes.
function labelTokens(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length >= 3 && !["the", "and", "for"].includes(word));
}

/**
 * COMMITS a built template payload into the run — the adjudication step. Every
 * claim in the event's brief must land in state here: an arrival places the NPC
 * in the cast, a hazard writes the objectState entry (consequence-spine shape),
 * a hook instantiates the quest. Returns the committed record (entity ids per
 * domain) or null when the payload has nothing to commit (that template is then
 * rejected — an event with no committed state is never narrated).
 */
export function commitMomentumPayload(run, built, options = {}) {
  const now = isoFromOption(options.now);
  const committed = { entityIds: [] };
  let wrote = false;

  if (isPlainObject(built.npc) && isString(built.npc.npcId)) {
    if (!isPlainObject(run.npcs)) {
      run.npcs = {};
    }
    if (run.npcs[built.npc.npcId]) {
      return null; // collision — adjudication rejects, engine picks nothing this turn
    }
    run.npcs[built.npc.npcId] = built.npc;
    committed.npcId = built.npc.npcId;
    committed.entityIds.push(built.npc.npcId);
    wrote = true;
  }

  if (isPlainObject(built.objectState) && isString(built.objectState.key)) {
    const location = run.locations?.[built.objectState.locationId || run.currentLocationId];
    if (!isPlainObject(location)) {
      return null;
    }
    if (!isPlainObject(location.flags)) {
      location.flags = {};
    }
    if (!isPlainObject(location.flags.objectStates)) {
      location.flags.objectStates = {};
    }
    const label = isString(built.objectState.label) ? built.objectState.label : built.objectState.key;
    location.flags.objectStates[built.objectState.key] = {
      objectId: built.objectState.key,
      label,
      state: isString(built.objectState.state) ? built.objectState.state : "changed",
      retryEffect: ["blocked", "harder"].includes(built.objectState.retryEffect) ? built.objectState.retryEffect : "none",
      reason: isString(built.objectState.reason) ? built.objectState.reason : "",
      matchTokens: labelTokens(label),
      targetId: null,
      sourceIntent: "",
      since: now
    };
    committed.objectStateKey = built.objectState.key;
    wrote = true;
  }

  if (isPlainObject(built.quest) && isString(built.quest.questId)) {
    if (!isPlainObject(run.quests)) {
      run.quests = {};
    }
    if (run.quests[built.quest.questId]) {
      return null;
    }
    run.quests[built.quest.questId] = built.quest;
    committed.questId = built.quest.questId;
    committed.entityIds.push(built.quest.questId);
    wrote = true;
  }

  return wrote ? committed : null;
}

/**
 * Fires ONE momentum event: seeded selection from the server-authored shortlist,
 * commit-first instantiation, memoryFact + timeline event. Returns the event
 * record or null (no viable candidate / nothing committable). options.rankFn, if
 * provided, may REORDER the candidate shortlist (the bounded LLM slot) — the
 * pick is still made from the same real options and adjudicated identically.
 */
export function fireMomentumEvent(run, options = {}) {
  const momentum = ensureMomentumState(run);
  let candidates = momentumCandidates(run, momentum.firedTemplateIds);
  if (candidates.length === 0) {
    return null;
  }
  if (typeof options.rankFn === "function") {
    // The LLM's entire permitted role: rank the server's shortlist. The result
    // is filtered back against the original candidates — anything it invents,
    // duplicates, or smuggles in is discarded.
    try {
      const ranked = options.rankFn(candidates.map((t) => t.templateId));
      if (Array.isArray(ranked)) {
        const byId = new Map(candidates.map((t) => [t.templateId, t]));
        const reordered = ranked.map((id) => byId.get(id)).filter(Boolean);
        const missing = candidates.filter((t) => !reordered.includes(t));
        if (reordered.length > 0) {
          candidates = [...reordered, ...missing];
        }
      }
    } catch {
      // Ranker failure is never fatal — deterministic order stands.
    }
  }
  const seed = hashSeed(`${run.worldSeed || run.runId}|momentum|${momentum.turnCount}`);
  // rankFn puts its preference FIRST; the seed picks within the top half so a
  // ranker biases but never fully controls, and no-ranker stays fully seeded.
  const window = typeof options.rankFn === "function" ? Math.max(1, Math.ceil(candidates.length / 2)) : candidates.length;

  // Rotate through the shortlist from the seeded index: a candidate whose build
  // declines (bare graph) or whose commit fails ADJUDICATION is skipped, not
  // fatal — the next real option is tried. Still deterministic for a given seed.
  let template = null;
  let built = null;
  let committed = null;
  for (let offset = 0; offset < candidates.length && !committed; offset += 1) {
    template = candidates[(seed + offset) % (offset === 0 ? window : candidates.length)];
    built = template.build(run);
    if (!built) {
      continue;
    }
    committed = commitMomentumPayload(run, built, options);
    if (!committed) {
      continue;
    }
    // ADJUDICATION GATE: the committed run must still validate. If the payload
    // broke the schema, undo EXACTLY what was written (the commit surface is
    // enumerated) and try the next candidate — an invalid event is never narrated.
    const validation = validateSoloRun(run);
    if (!validation.ok) {
      if (committed.npcId) {
        delete run.npcs[committed.npcId];
      }
      if (committed.questId) {
        delete run.quests[committed.questId];
      }
      if (committed.objectStateKey) {
        const location = run.locations?.[built.objectState?.locationId || run.currentLocationId];
        if (location?.flags?.objectStates) {
          delete location.flags.objectStates[committed.objectStateKey];
        }
      }
      committed = null;
    }
  }
  if (!committed) {
    return null;
  }

  const event = {
    eventId: (typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory)("momentum"),
    templateId: template.templateId,
    kind: template.kind,
    title: built.title,
    brief: built.brief,
    decision: built.decision,
    committed,
    firedAtTurn: momentum.turnCount
  };

  // ESSENCE-SIGHT (verdance-region-v1 §law-5): a hazard event that spawns a
  // demon/rapture mints an outbound essence trail at fire time — demons drift
  // (regional law 2). `built.spawn` is the committed marker; ordinary hazards
  // (collapse/fire/storm/tracks) carry none, so this is a no-op for them.
  if (built.spawn && typeof built.spawn === "object") {
    const at = (typeof built.spawn.at === "string" && built.spawn.at) || built.objectState?.locationId || run.currentLocationId;
    const nowMin = Number(run?.world?.time?.minutes);
    mintTraceFromSpawn(run, built.spawn, {
      id: `trace_${event.eventId}`,
      locationId: at,
      nowMinutes: Number.isFinite(nowMin) ? nowMin : undefined
    });
  }

  const memoryFact = createMomentumMemoryFact(run, event, options);
  const timelineEvent = createMomentumTimelineEvent(run, event, memoryFact, options);
  run.memoryFacts = [...(run.memoryFacts || []), memoryFact];
  run.timeline = [...(run.timeline || []), timelineEvent];

  // item 4b — a deadline-bearing event commits its thread clock alongside its stakes.
  const promoted = promoteEventToDeadlineThread(run, event, built);
  if (promoted) {
    event.deadlineThread = promoted;
  }

  momentum.tension = 0;
  momentum.lastFiredTurn = momentum.turnCount;
  momentum.firedTemplateIds = [...momentum.firedTemplateIds, template.templateId];
  momentum.lastEvent = {
    eventId: event.eventId,
    templateId: event.templateId,
    kind: event.kind,
    title: event.title,
    brief: event.brief,
    decision: event.decision,
    firedAtTurn: event.firedAtTurn
  };
  return event;
}

/**
 * The per-turn tick, called from the action finalizer on the post-action run.
 * Advances the clock by the turn's classification and fires at most one event
 * when pressure, cadence, and run-state allow. Mutates run.flags.momentum (the
 * resolver already works on a per-action clone). Returns { fired } — the event
 * or null.
 * @param {object} run   post-action run (the clone that will persist)
 * @param {object} result the action result (for classification)
 * @param {object} [options] { now, idFactory, rankFn, tuning }
 */
export function advanceMomentum(run, result, options = {}) {
  const tuning = { ...MOMENTUM_TUNING, ...(isPlainObject(options.tuning) ? options.tuning : {}) };
  const momentum = ensureMomentumState(run);
  momentum.turnCount += 1;

  const cls = classifyTurnForMomentum(result);
  if (cls === "quiet") {
    momentum.tension += tuning.quietStep;
  } else if (cls === "fail") {
    momentum.tension += tuning.failStep;
  } else {
    momentum.tension = Math.max(0, momentum.tension - tuning.progressRelief);
  }

  // Fire conditions: enough pressure, NOT a progress turn (never trample an
  // advancing arc), past the cooldown, on a live, non-dying run.
  const cooledDown =
    momentum.lastFiredTurn === null || momentum.turnCount - momentum.lastFiredTurn > tuning.cooldownTurns;
  if (
    cls !== "progress" &&
    !options.suppressFire && // D.5 ≤1-driver: a quest/thread already drove this turn
    momentum.tension >= tuning.fireAt &&
    cooledDown &&
    run.status === "active" &&
    !playerIsDying(run)
  ) {
    // D.5 ONE CLOCK: the fire slot is offered FIRST to the thread engine (a due
    // PRESCRIPTIVE beat), then falls back to the legacy momentum one-off pool.
    // threadFireFn is injected by finalizeQuestProgress; absent (legacy callers),
    // behavior is unchanged.
    if (typeof options.threadFireFn === "function") {
      const threadBeat = options.threadFireFn(run, options);
      if (threadBeat) {
        momentum.tension = 0;
        momentum.lastFiredTurn = momentum.turnCount;
        return { fired: null, threadBeat, classification: cls };
      }
    }
    const fired = fireMomentumEvent(run, options);
    return { fired: fired || null, classification: cls };
  }
  return { fired: null, classification: cls };
}

/**
 * Scene-payload surface: the most recent committed development while it is
 * FRESH (the turn it fired + the next), so the GM context can keep it present
 * without re-announcing stale news forever. Null otherwise.
 */
export function getRecentDevelopment(run) {
  const momentum = run?.flags?.momentum;
  if (!isPlainObject(momentum) || !isPlainObject(momentum.lastEvent)) {
    return null;
  }
  const age = momentum.turnCount - (momentum.lastEvent.firedAtTurn ?? 0);
  if (age > 1) {
    return null;
  }
  const { title, brief, decision, kind, eventId } = momentum.lastEvent;
  return { eventId, kind, title, brief, decision };
}
