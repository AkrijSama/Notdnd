// D.5 THE NARRATIVE SUBSTRATE — the thread engine (runtime).
//
// A thread is a committed narrative agenda: a row before it is a sentence
// (docs/inkborne-narrative-substrate-d5-spec.md). Threads generalize momentum
// from one-off events into ORDERED, remembered escalations. This module owns
// their runtime: DUAL-advancement trigger evaluation (descriptive fires on the
// player's own action; prescriptive fires on the momentum clock), the beat-commit
// executor (commit-first + rollback, generalizing commitMomentumPayload with the
// `fact` and `hostileNpc` payload kinds), the ONE-CLOCK scheduler (≤1 driver per
// turn; quest-advance outranks a due thread beat outranks a legacy one-off),
// callbacks (verbatim canonical facts), the narrativeDriver fold-in the GM
// context consumes, and thread lifecycle/resolution.
//
// COHERENCE (the invariants this module must hold):
//  * Threads are born ONLY from server events (scenario load / worldgen /
//    momentum promotion / goal capture) — there is NO API by which model output
//    creates a thread. This module never creates one; it only advances existing
//    run.threads rows.
//  * Hidden threads are ABSENT FROM THE PROMPT: buildThreadNarrativeDriver emits
//    the committed beat (its effect) but NEVER the thread's agenda/title while
//    hidden. The narrator cannot leak state it was never handed.
//  * Beat payloads commit through the sealed set (fact/npc/objectState/quest/
//    hostileNpc); ALLOWED_EFFECT_TYPES is untouched — beats are resolver output,
//    not provider effects.
//  * Callbacks are server-selected VERBATIM canonical facts; the model never
//    retrieves or invents memory.

import { validateSoloRun, createEmptyExpressionVariants } from "./schema.js";
import { resolveStatBlock } from "../campaign/bestiary.js";

const MAX_ACTIVE_THREADS = 3; // DW anti-noise cap (scenarios §1.2).

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hashSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
function isoNow(options) {
  if (typeof options?.now === "string") return options.now;
  if (options?.now instanceof Date) return options.now.toISOString();
  return new Date().toISOString();
}
function turnCounter(run) {
  return run?.flags?.momentum?.turnCount ?? 0;
}
function activeThreads(run) {
  return Object.values(run?.threads || {}).filter((t) => t && t.status === "active");
}
function currentBeat(thread) {
  const beats = Array.isArray(thread?.beats) ? thread.beats : [];
  const beat = beats[thread.beatIndex ?? 0];
  return beat && beat.status !== "committed" && beat.status !== "skipped" ? beat : null;
}
function findBeat(thread, beatId) {
  return (thread?.beats || []).find((b) => b.beatId === beatId) || null;
}

// ── trigger predicates (the closed vocabulary; reconciled spine §C4) ───────────
// requiresBeat / questState are shared; the rest split by mode. Symbolic location
// refs are resolved to REAL ids by the loader, so eval is a plain id compare.
function requiresBeatMet(thread, cond) {
  if (!cond || cond.requiresBeat === undefined) return true;
  const b = findBeat(thread, cond.requiresBeat);
  return Boolean(b && b.status === "committed");
}
function questStateMet(run, spec) {
  if (!isPlainObject(spec)) return true;
  const id = spec.questId || spec.questRef;
  const quest = run.quests?.[id];
  if (!quest) return false;
  if (spec.status && quest.status !== spec.status) return false;
  if (typeof spec.minStage === "number" && (quest.stage ?? 0) < spec.minStage) return false;
  return true;
}
function canonKeywordsPresent(run, keywords) {
  const words = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (!words.length) return false;
  // The haystack is the STABLE canonical surface: fact/timeline text PLUS the
  // committed entity ids and tags. Matching ids (e.g. "npc_collector") makes a
  // trigger robust to the live identity worker renaming an NPC's display name —
  // the fiction may call the collector "Soren", but the committed row is still
  // npc_collector, and the outcome fact carries it in entityIds/payload.
  const haystack = [];
  for (const f of run.memoryFacts || []) {
    haystack.push(String(f.text || "").toLowerCase());
    haystack.push((f.entityIds || []).join(" ").toLowerCase());
    haystack.push((f.tags || []).join(" ").toLowerCase());
    if (Array.isArray(f.payload?.defeated)) haystack.push(f.payload.defeated.join(" ").toLowerCase());
  }
  for (const e of run.timeline || []) {
    haystack.push(String(e.summary || e.title || "").toLowerCase());
    haystack.push((e.entityIds || []).join(" ").toLowerCase());
  }
  return words.some((w) => haystack.some((h) => h.includes(w)));
}

// DESCRIPTIVE — fires on the player's OWN committed action this finalize (never
// starves a busy player). Evaluated every finalize, regardless of tension/turn
// class (reconciled spine §C5).
function descriptiveTriggerMet(run, thread, beat, result) {
  const desc = beat.trigger?.descriptive;
  if (!isPlainObject(desc)) return false;
  if (!requiresBeatMet(thread, desc)) return false;
  if (desc.onQuestAccepted !== undefined) {
    const accepted = result?.questAccepted?.questId || result?.questAccepted;
    const want = desc.onQuestAccepted === true ? Boolean(accepted) : accepted === (desc.onQuestAccepted?.questId || desc.onQuestAccepted);
    if (!want) return false;
  }
  if (desc.onPlayerAt !== undefined && run.currentLocationId !== desc.onPlayerAt) return false;
  if (desc.onQuestStage !== undefined && !questStateMet(run, { ...desc.onQuestStage, questId: desc.onQuestStage.questId || desc.onQuestStage.questRef })) return false;
  if (desc.onQuestState !== undefined && !questStateMet(run, { ...desc.onQuestState, questId: desc.onQuestState.questId || desc.onQuestState.questRef })) return false;
  if (desc.onCanon !== undefined && !canonKeywordsPresent(run, desc.onCanon.keywords)) return false;
  // At least one positive condition must be present (a bare requiresBeat is not a
  // player-action trigger — it would fire on any turn).
  const hasPositive =
    desc.onQuestAccepted !== undefined || desc.onPlayerAt !== undefined ||
    desc.onQuestStage !== undefined || desc.onQuestState !== undefined || desc.onCanon !== undefined;
  return hasPositive;
}

// PRESCRIPTIVE — fires on the momentum clock (a quiet/failed turn past cadence).
function prescriptiveTriggerMet(run, thread, beat) {
  const pre = beat.trigger?.prescriptive;
  if (!isPlainObject(pre)) return false;
  if (!requiresBeatMet(thread, pre)) return false;
  if (typeof pre.minTurn === "number" && turnCounter(run) < pre.minTurn) return false;
  if (pre.questState !== undefined && !questStateMet(run, { ...pre.questState, questId: pre.questState.questId || pre.questState.questRef })) return false;
  if (typeof pre.minTurnsSinceBeat === "number") {
    const last = thread.clock?.lastFiredTurn;
    if (last !== null && last !== undefined && turnCounter(run) - last < pre.minTurnsSinceBeat) return false;
  }
  return true;
}

// Per-thread cadence: never two beats from one thread inside minTurnsBetweenBeats.
function clockAllows(run, thread) {
  const min = thread.clock?.minTurnsBetweenBeats ?? 0;
  const last = thread.clock?.lastFiredTurn;
  if (last === null || last === undefined) return true;
  return turnCounter(run) - last >= min;
}

// ── symbolic ref resolution (commit time) ─────────────────────────────────────
// The loader resolves fixed symbolic refs (second_location …) to real ids at load
// time; only the DYNAMIC token {player_location} is resolved here, at commit.
function resolveRef(run, ref) {
  if (ref === "{player_location}") return run.currentLocationId;
  return ref;
}
function interpolate(run, text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\{world\}/g, run.world?.name || "the world")
    .replace(/\{place\}/g, run.locations?.[run.currentLocationId]?.name || "here")
    .replace(/\{player_location\}/g, run.locations?.[run.currentLocationId]?.name || "here");
}

// ── beat commit executor (commit-first + rollback; the 5 payload kinds) ───────
// Returns { committed: {...ids}, undo } on success, or null if nothing committable
// / adjudication failed (the beat is then skipped, never narrated).
function commitBeatPayload(run, thread, beat, options) {
  const payload = beat.payload || {};
  const now = isoNow(options);
  const committed = { npcIds: [], objectStateKeys: [], questIds: [], factIds: [] };
  const undo = [];

  if (isPlainObject(payload.fact)) {
    const factId = `fact_thread_${thread.threadId}_${beat.beatId}`;
    run.memoryFacts = run.memoryFacts || [];
    run.memoryFacts.push({
      factId,
      entityIds: [...new Set([run.runId, run.currentLocationId, ...(thread.groundedIn?.entityIds || [])])],
      type: "thread_beat",
      text: interpolate(run, payload.fact.text),
      source: "system",
      createdAt: now,
      tags: ["system", "thread", thread.kind],
      edition: run.edition,
      policyProfileId: run.policyProfileId,
      contentTags: [],
      canonical: true,
      confidence: 1,
      supersedesFactIds: [],
      payload: { threadId: thread.threadId, beatId: beat.beatId }
    });
    committed.factIds.push(factId);
    undo.push(() => { run.memoryFacts = run.memoryFacts.filter((f) => f.factId !== factId); });
  }

  if (isPlainObject(payload.objectState)) {
    const os = payload.objectState;
    const locId = resolveRef(run, os.locationId) || run.currentLocationId;
    const loc = run.locations?.[locId];
    if (loc) {
      loc.flags = loc.flags || {};
      loc.flags.objectStates = loc.flags.objectStates || {};
      const key = os.key;
      loc.flags.objectStates[key] = { state: os.state, retryEffect: os.retryEffect || "none", reason: interpolate(run, os.reason) || "", setBy: "thread", threadId: thread.threadId };
      committed.objectStateKeys.push(key);
      undo.push(() => { delete loc.flags.objectStates[key]; });
    }
  }

  for (const kind of ["npc", "hostileNpc"]) {
    if (!isPlainObject(payload[kind])) continue;
    const p = payload[kind];
    const npcId = p.npcId;
    if (!npcId || run.npcs?.[npcId]) continue; // never overwrite a committed NPC
    const placeAt = resolveRef(run, p.placeAt) || run.currentLocationId;
    const npc = {
      npcId,
      displayName: interpolate(run, p.displayName) || npcId,
      role: p.role || (kind === "hostileNpc" ? "enforcer" : "stranger"),
      known: true,
      status: "active",
      currentLocationId: placeAt,
      memoryFactIds: [],
      expressionVariants: createEmptyExpressionVariants(),
      tags: kind === "hostileNpc" ? ["hostile"] : [],
      flags: kind === "hostileNpc" ? { hostile: true, threadId: thread.threadId } : { threadId: thread.threadId },
      dialogueBeats: Array.isArray(p.dialogueBeats) ? p.dialogueBeats.map((d, i) => ({
        beatId: `${npcId}_beat_${i}`,
        label: d.label || "",
        text: interpolate(run, d.text) || "",
        linkedQuestIds: [],
        linkedMemoryFactIds: []
      })) : []
    };
    // D.4/D.5 seam: a hostileNpc carries its statBlockId; combat entry reads it.
    if (kind === "hostileNpc") {
      if (!resolveStatBlock(p.statBlockId)) {
        // Unknown stat block → the whole beat is invalid; skip (never narrate a phantom).
        undo.forEach((fn) => fn());
        return null;
      }
      npc.statBlockId = p.statBlockId;
    }
    run.npcs = run.npcs || {};
    run.npcs[npcId] = npc;
    committed.npcIds.push(npcId);
    undo.push(() => { delete run.npcs[npcId]; });
  }

  if (isPlainObject(payload.quest)) {
    const q = payload.quest;
    const questId = q.questId || q.questRef;
    if (questId && !run.quests?.[questId]) {
      run.quests = run.quests || {};
      run.quests[questId] = {
        questId,
        status: "active",
        stage: 0,
        title: interpolate(run, q.title) || questId,
        description: interpolate(run, q.summary || q.description) || "",
        relatedEntityIds: [],
        memoryFactIds: [],
        authoredBy: "thread",
        flags: { threadId: thread.threadId }
      };
      committed.questIds.push(questId);
      undo.push(() => { delete run.quests[questId]; });
    }
  }

  const any = committed.npcIds.length || committed.objectStateKeys.length || committed.questIds.length || committed.factIds.length;
  if (!any) return null; // a beat that commits nothing is invalid content

  return { committed, undo: () => undo.forEach((fn) => fn()) };
}

// Commit a beat with the momentum adjudication discipline: write → validate →
// roll back exactly what was written if invalid (never narrate an invalid beat).
function fireBeat(run, thread, beat, options) {
  const outcome = commitBeatPayload(run, thread, beat, options);
  if (!outcome) return null;
  const validation = validateSoloRun(run);
  if (!validation.ok) {
    outcome.undo();
    beat.status = "skipped";
    return null;
  }
  beat.status = "committed";
  thread.beatIndex = (thread.beatIndex ?? 0) + 1;
  thread.clock = thread.clock || {};
  thread.clock.lastFiredTurn = turnCounter(run);
  // Same-turn beat_final closure: when the last rung commits and the thread
  // resolves by beat_final, flip it here so it doesn't linger one turn as "active"
  // with a spent ladder. (ground_lost / quest closures run in resolveThreadLifecycle.)
  const ladderDone = thread.beatIndex >= (thread.beats?.length ?? 0);
  if (ladderDone && (thread.resolution || []).some((r) => r.kind === "beat_final")) {
    thread.status = "resolved";
  }
  const driver = buildThreadNarrativeDriver(run, thread, beat, outcome.committed);
  return { thread, beat, committed: outcome.committed, driver };
}

// ── the narrativeDriver fold-in (what the GM context consumes) ────────────────
// HIDDEN threads: the beat's committed EFFECT rides (brief/decision), but the
// thread's agenda/title/pattern do NOT — threadKnown:false. The narrator narrates
// what happened, never the unnamed plot. This is the load-bearing invariant.
export function buildThreadNarrativeDriver(run, thread, beat, committed) {
  const known = thread.revealState !== "hidden";
  const total = Array.isArray(thread.beats) ? thread.beats.length : 0;
  const idx = (thread.beatIndex ?? 1) - 1;
  const escalation = total <= 1 ? "final" : idx <= 0 ? "first" : idx >= total - 1 ? "final" : "second";
  return {
    source: "thread",
    threadId: thread.threadId,
    threadKnown: known,
    // agenda/title only when known — never leak a hidden pattern into the prompt.
    agenda: known ? thread.agenda : undefined,
    beat: {
      title: beat.label || "",
      brief: interpolate(run, beat.brief) || "",
      decision: interpolate(run, beat.decision) || ""
    },
    committed: committed || {},
    callbacks: selectCallbacks(run, thread),
    escalation
  };
}

// Callbacks — the "remembered forward" feel. Server-selected VERBATIM canonical
// fact text, deterministic; the model never searches memory itself.
function selectCallbacks(run, thread) {
  const q = thread.callbackQuery || {};
  const entityIds = new Set(q.entityIds || []);
  const keywords = (q.keywords || []).map((k) => String(k).toLowerCase());
  const matches = [];
  for (const fact of run.memoryFacts || []) {
    if (!fact.canonical) continue;
    if (fact.payload?.threadId === thread.threadId && matches.length < 4) { matches.push(fact); continue; }
    const byEntity = (fact.entityIds || []).some((id) => entityIds.has(id));
    const byKeyword = keywords.length && keywords.some((k) => String(fact.text || "").toLowerCase().includes(k));
    if (byEntity || byKeyword) matches.push(fact);
  }
  // Most recent 1–2, verbatim.
  return matches.slice(-2).map((f) => f.text);
}

// ── the scheduler ─────────────────────────────────────────────────────────────
// DESCRIPTIVE pass — called from finalizeQuestProgress on the player's own turn,
// BEFORE the momentum clock. Fires at most ONE due beat (≤1 driver). Returns
// { fired, beat, thread, driver } or { fired:false }.
export function advanceThreads(run, result, options = {}) {
  if (!isPlainObject(run.threads) || !Object.keys(run.threads).length) return { fired: false };
  if (run.player?.status === "dying" || run.player?.status === "dead") return { fired: false };

  const due = [];
  for (const thread of activeThreads(run)) {
    if (!clockAllows(run, thread)) continue;
    const beat = currentBeat(thread);
    if (!beat) continue;
    if (descriptiveTriggerMet(run, thread, beat, result)) due.push({ thread, beat });
  }
  if (!due.length) return { fired: false };

  // Seeded selection among due beats (the momentum.js:293 pattern).
  const seed = hashSeed(`${run.worldSeed || run.runId}|threads|${turnCounter(run)}`);
  const chosen = due[seed % due.length];
  const fired = fireBeat(run, chosen.thread, chosen.beat, options);
  if (!fired) return { fired: false };
  return { fired: true, beat: fired.beat, thread: fired.thread, driver: fired.driver };
}

// PRESCRIPTIVE pass — injected into advanceMomentum as threadFireFn. When the
// clock fires, the slot is offered here first (a due prescriptive beat), else the
// legacy one-off pool fires. Returns the fired beat record or null.
export function fireDueThreadBeatOnClock(run, options = {}) {
  if (!isPlainObject(run.threads)) return null;
  if (run.player?.status === "dying" || run.player?.status === "dead") return null;
  const due = [];
  for (const thread of activeThreads(run)) {
    if (!clockAllows(run, thread)) continue;
    const beat = currentBeat(thread);
    if (!beat) continue;
    if (prescriptiveTriggerMet(run, thread, beat)) due.push({ thread, beat });
  }
  if (!due.length) return null;
  const seed = hashSeed(`${run.worldSeed || run.runId}|threads-clock|${turnCounter(run)}`);
  const chosen = due[seed % due.length];
  return fireBeat(run, chosen.thread, chosen.beat, options);
}

// ── lifecycle / resolution ────────────────────────────────────────────────────
// Evaluated in the same finalize pass as advanceQuests. A thread closes when any
// resolution rule matches. Returns the list of threads that resolved this turn.
export function resolveThreadLifecycle(run, result, options = {}) {
  const resolved = [];
  for (const thread of activeThreads(run)) {
    const rules = Array.isArray(thread.resolution) ? thread.resolution : [];
    let outcome = null;
    for (const rule of rules) {
      if (rule.kind === "beat_final") {
        if ((thread.beatIndex ?? 0) >= (thread.beats?.length ?? 0)) outcome = rule.outcome || "resolved";
      } else if (rule.kind === "ground_lost") {
        const grounds = thread.groundedIn?.entityIds || [];
        const lost = grounds.some((id) => {
          const npc = run.npcs?.[id];
          return npc && (npc.status === "dead" || npc.flags?.defeated === true);
        });
        // A regroundBeat (authored) would instead re-target; not exercised in the slice.
        if (lost && !rule.regroundBeat) outcome = rule.outcome || "resolved";
      } else if (rule.kind === "quest") {
        const q = run.quests?.[rule.questId || rule.questRef];
        if (q && (rule.on ? q.status === rule.on : q.status === "completed")) outcome = rule.outcome || "resolved";
      }
      if (outcome) break;
    }
    if (outcome) {
      thread.status = outcome === "expired" ? "expired" : "resolved";
      resolved.push({ threadId: thread.threadId, outcome });
    }
  }
  return resolved;
}
