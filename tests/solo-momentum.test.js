import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import {
  MOMENTUM_TUNING,
  ensureMomentumState,
  classifyTurnForMomentum,
  advanceMomentum,
  fireMomentumEvent,
  getRecentDevelopment
} from "../server/solo/momentum.js";
import { MOMENTUM_TEMPLATES, momentumCandidates } from "../server/campaign/momentumEvents.js";

// THE MOMENTUM ENGINE: the world moves on its own — but ONLY through committed
// state. Every fired event places real state (cast/objectState/quest) BEFORE it
// is narrated; a quiet session gets interrupted by ~turn 4; progress is never
// trampled; nothing repeats.

const T = (n) => `2026-03-01T00:00:${String(n).padStart(2, "0")}.000Z`;

function freshRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_momentum_test";
  return run;
}

// ── classification ───────────────────────────────────────────────────────────
test("turn classification: quiet vs fail vs progress", () => {
  assert.equal(classifyTurnForMomentum({ attemptResult: { success: true, needsCheck: false } }), "quiet",
    "a no-stakes narrative success commits nothing -> quiet");
  assert.equal(classifyTurnForMomentum({ attemptResult: { success: false, needsCheck: true } }), "fail");
  assert.equal(classifyTurnForMomentum({ action: { type: "move" } }), "progress");
  assert.equal(classifyTurnForMomentum({ searchResult: { found: true } }), "progress");
  assert.equal(classifyTurnForMomentum({ takeResult: { taken: true } }), "progress");
  assert.equal(classifyTurnForMomentum({ questAccepted: { questId: "q" } }), "progress");
  assert.equal(classifyTurnForMomentum({ questJustAdvanced: { questId: "q" } }), "progress");
  assert.equal(classifyTurnForMomentum({ attemptResult: { success: true, needsCheck: true } }), "quiet",
    "a WON roll that commits nothing is still theater — tension builds through it");
  assert.equal(classifyTurnForMomentum({ attemptResult: { success: true, needsCheck: true }, questJustAdvanced: { questId: "q" } }), "progress",
    "a win that MATTERS registers through its committed effect");
  assert.equal(classifyTurnForMomentum({ talkResult: { revealed: true } }), "progress");
  assert.equal(classifyTurnForMomentum({ talkResult: { revealed: false } }), "quiet",
    "repeating an old beat advances nothing");
});

// ── the clock ────────────────────────────────────────────────────────────────
test("three quiet turns fire the world; progress bleeds tension and never fires", () => {
  const run = freshRun();
  const quiet = { attemptResult: { success: true, needsCheck: false } };
  const t1 = advanceMomentum(run, quiet, { now: T(1) });
  const t2 = advanceMomentum(run, quiet, { now: T(2) });
  assert.equal(t1.fired, null);
  assert.equal(t2.fired, null);
  assert.equal(run.flags.momentum.tension, 4, "two quiet turns = 4 tension");
  const t3 = advanceMomentum(run, quiet, { now: T(3) });
  assert.ok(t3.fired, "the third quiet turn crosses the threshold — the world MOVES (by turn ~4)");
  assert.equal(run.flags.momentum.tension, 0, "firing resets the clock");
  assert.equal(validateSoloRun(run).ok, true, "the committed event left a valid run");

  // Progress never fires and bleeds pressure.
  const run2 = freshRun();
  ensureMomentumState(run2).tension = MOMENTUM_TUNING.fireAt + 4;
  const p = advanceMomentum(run2, { action: { type: "move" }, moved: {} }, { now: T(4) });
  assert.equal(p.fired, null, "a progress turn NEVER fires — active stakes are not trampled");
  assert.equal(run2.flags.momentum.tension, MOMENTUM_TUNING.fireAt + 4 - MOMENTUM_TUNING.progressRelief);
});

test("cooldown: after a fire, the next window cannot fire for cooldownTurns", () => {
  const run = freshRun();
  const quiet = { attemptResult: { success: true, needsCheck: false } };
  for (let i = 1; i <= 3; i += 1) advanceMomentum(run, quiet, { now: T(i) });
  assert.ok(run.flags.momentum.lastFiredTurn !== null, "first fire happened");
  // Build max pressure again immediately — cooldown must hold it.
  let firedDuringCooldown = false;
  for (let i = 4; i <= 6; i += 1) {
    const r = advanceMomentum(run, quiet, { now: T(i) });
    if (r.fired) firedDuringCooldown = true;
  }
  assert.equal(firedDuringCooldown, false, "no second event inside the cooldown window");
  const after = advanceMomentum(run, quiet, { now: T(7) });
  assert.ok(after.fired, "pressure fires again once the cooldown has passed");
});

test("a dying or terminal run is never interrupted", () => {
  const run = freshRun();
  ensureMomentumState(run).tension = 99;
  run.player.status = "dying";
  const r = advanceMomentum(run, { attemptResult: { success: false } }, { now: T(1) });
  assert.equal(r.fired, null, "no weather reports while bleeding out");
  run.player.status = "alive";
  run.status = "completed";
  const r2 = advanceMomentum(run, { attemptResult: { success: false } }, { now: T(2) });
  assert.equal(r2.fired, null, "a finished run's world stays still");
});

// ── commit-first coherence ───────────────────────────────────────────────────
test("EVERY template commits real state: arrival -> cast, hazard -> objectState, hook -> quest", () => {
  for (const template of MOMENTUM_TEMPLATES) {
    const run = freshRun();
    // Give tag-restricted templates a matching location.
    run.locations[run.currentLocationId].tags = [...template.locationKinds.filter((k) => k !== "any"), "placeholder"];
    const built = template.build(run);
    if (!built) continue; // graph-dependent template declined — allowed
    assert.ok(built.npc || built.objectState || built.quest,
      `${template.templateId}: a template with no committable payload is a narrate-into-void generator`);
    assert.ok(built.title && built.brief && built.decision, `${template.templateId}: title/brief/decision required`);
    ensureMomentumState(run);
    const before = JSON.stringify({ npcs: Object.keys(run.npcs), quests: Object.keys(run.quests) });
    const event = fireMomentumEventVia(run, template);
    assert.ok(event, `${template.templateId}: should instantiate on a matching location`);
    const npcCount = Object.keys(run.npcs).length;
    const questCount = Object.keys(run.quests).length;
    const objectStates = run.locations[run.currentLocationId].flags?.objectStates || {};
    const committedSomething =
      (event.committed.npcId && run.npcs[event.committed.npcId]) ||
      (event.committed.questId && run.quests[event.committed.questId]) ||
      (event.committed.objectStateKey && objectStates[event.committed.objectStateKey]);
    assert.ok(committedSomething, `${template.templateId}: the narrated claim exists in state`);
    assert.equal(validateSoloRun(run).ok, true, `${template.templateId}: run still validates after commit`);
    assert.ok(before.length > 0 && (npcCount >= 0 || questCount >= 0)); // structure sanity
  }
});

// Helper: force-fire a SPECIFIC template through the real engine path by
// narrowing the candidate pool (selection stays the engine's).
function fireMomentumEventVia(run, template) {
  const momentum = ensureMomentumState(run);
  momentum.firedTemplateIds = MOMENTUM_TEMPLATES
    .filter((t) => t.templateId !== template.templateId)
    .map((t) => t.templateId);
  return fireMomentumEvent(run, { now: T(9) });
}

test("selection is seeded-deterministic and never repeats a fired template", () => {
  const a = freshRun();
  const b = freshRun();
  ensureMomentumState(a);
  ensureMomentumState(b);
  const ea = fireMomentumEvent(a, { now: T(1) });
  const eb = fireMomentumEvent(b, { now: T(1) });
  assert.equal(ea.templateId, eb.templateId, "same seed + same turn -> same pick");
  // No-repeat: the fired template leaves the candidate pool.
  const remaining = momentumCandidates(a, a.flags.momentum.firedTemplateIds).map((t) => t.templateId);
  assert.ok(!remaining.includes(ea.templateId), "a fired template cannot fire again");
});

test("the bounded ranker can reorder the shortlist but can NOT introduce an option", () => {
  const run = freshRun();
  ensureMomentumState(run);
  const rankFn = () => ["not_a_real_template", "arrival_watcher"];
  const event = fireMomentumEvent(run, { now: T(1), rankFn });
  assert.ok(event, "ranked fire still fires");
  assert.notEqual(event.templateId, "not_a_real_template", "an invented option is discarded");
  assert.ok(MOMENTUM_TEMPLATES.some((t) => t.templateId === event.templateId), "the pick is a real authored template");
});

// ── end-to-end through the resolver ─────────────────────────────────────────
test("PIPELINE: three idle free-text turns -> the world moves, committed BEFORE narrated", () => {
  let run = freshRun();
  // Pinned no-stakes interpreter output: an idle poke resolves narratively with
  // NO roll (deterministic "quiet" classification — a live roll could randomly
  // fail and classify as "fail" (+1), making the fire turn dice-dependent).
  const idle = (r, text, n) =>
    resolveSoloAction(r, {
      type: "attempt", actorId: "player", intent: text,
      testHook: { providerOutput: {
        summary: `You attempt: ${text}`, recommendedAbility: "wisdom", dc: 10,
        needsCheck: false, advantage: false, disadvantage: false,
        successNarration: "Time passes.", failureNarration: "Time passes.",
        proposedEffects: [], failureConsequence: null
      } }
    }, { now: T(n) });

  const r1 = idle(run, "wait and listen to the wind", 1);
  assert.equal(r1.momentumEvent, undefined, "turn 1: world holds");
  const r2 = idle(r1.run, "stand still and think about my next move", 2);
  assert.equal(r2.momentumEvent, undefined, "turn 2: world holds");
  const r3 = idle(r2.run, "hum a quiet tune to myself", 3);
  assert.ok(r3.momentumEvent, "turn 3 of poking a static scene: the world MOVES");
  const ev = r3.momentumEvent;
  // The anti-void contract: the event's committed record EXISTS in the result run.
  const inCast = ev.committed.npcId && r3.run.npcs[ev.committed.npcId];
  const inQuests = ev.committed.questId && r3.run.quests[ev.committed.questId];
  const inObjects = ev.committed.objectStateKey &&
    r3.run.locations[r3.run.currentLocationId].flags?.objectStates?.[ev.committed.objectStateKey];
  assert.ok(inCast || inQuests || inObjects, "the event exists in STATE, not just in prose");
  assert.equal(validateSoloRun(r3.run).ok, true);
  // The scene surface carries it while fresh.
  assert.ok(getRecentDevelopment(r3.run), "recentDevelopment surfaces for the GM context");
});

test("PIPELINE: an actively progressing session is never interrupted", () => {
  let run = freshRun();
  // Real progress every turn: move out, search (default graph has no details ->
  // found:false is QUIET, so use moves + a granted-item turn instead).
  const r1 = resolveSoloAction(run, { type: "move", actorId: "player", toLocationId: "second_location" }, { now: T(1) });
  assert.equal(r1.momentumEvent, undefined);
  const r2 = resolveSoloAction(r1.run, { type: "move", actorId: "player", toLocationId: "third_location" }, { now: T(2) });
  assert.equal(r2.momentumEvent, undefined);
  const r3 = resolveSoloAction(r2.run, { type: "move", actorId: "player", toLocationId: "second_location" }, { now: T(3) });
  assert.equal(r3.momentumEvent, undefined, "three straight progress turns: zero interruptions");
  assert.equal(r3.run.flags.momentum?.tension ?? 0, 0, "progress keeps the clock at rest");
});

test("an arrival's NPC is a real, talkable cast member (not scenery)", () => {
  const run = freshRun();
  ensureMomentumState(run);
  const event = fireMomentumEventVia(run, MOMENTUM_TEMPLATES.find((t) => t.templateId === "arrival_watcher"));
  assert.ok(event.committed.npcId);
  const npc = run.npcs[event.committed.npcId];
  assert.equal(npc.currentLocationId, run.currentLocationId, "placed HERE, in the live scene");
  assert.equal(npc.status, "present");
  assert.ok(Array.isArray(npc.dialogueBeats) && npc.dialogueBeats.length > 0, "arrives with something to say");
});

test("the courier arrival carries a REAL acceptable offer (momentum pairs with the hook machinery)", () => {
  const run = freshRun();
  ensureMomentumState(run);
  const event = fireMomentumEventVia(run, MOMENTUM_TEMPLATES.find((t) => t.templateId === "arrival_courier"));
  const npc = run.npcs[event.committed.npcId];
  assert.ok(npc.questOffer && npc.questOffer.accepted === false, "the courier holds an open offer");
  assert.ok(npc.questOffer.quest?.questId, "the offer wraps a real instantiable quest");
});
