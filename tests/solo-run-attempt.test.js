import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  applyFailureDamage,
  attemptNeedsCheck,
  buildAttemptContext,
  buildAttemptProviderInput,
  resolveAttemptAction,
  validateAttemptAction,
  validateAttemptProviderOutput
} from "../server/solo/attempt.js";

// Forces a failed ability check: roll 1 against an impossible DC.
function failingAttempt(run, overrides = {}) {
  return resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Force the door open",
    ...overrides
  }, {
    fixedRoll: 1,
    attemptProviderFn: () => ({
      summary: "You strain against the door.",
      recommendedAbility: "strength",
      dc: 30,
      advantage: false,
      disadvantage: false,
      successNarration: "The door bursts open.",
      failureNarration: "The door holds firm.",
      proposedEffects: []
    })
  });
}

test("valid attempt resolves and creates timeline event", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Convince the guard I belong here"
  }, {
    fixedRoll: 20,
    attemptProviderFn: () => ({
      summary: "You attempt to convince the guard.",
      recommendedAbility: "persuasion",
      dc: 10,
      advantage: false,
      disadvantage: false,
      successNarration: "The explanation lands.",
      failureNarration: "The explanation fails.",
      proposedEffects: []
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, true);
  assert.equal(result.event.type, "attempt");
  assert.equal(result.run.timeline.at(-1).type, "attempt");
});

test("invalid target is rejected", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const validation = validateAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Threaten the invisible guard",
    targetId: "npc:hidden_guard"
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.map((error) => error.message).join(" "), /visible entity/);
});

test("attempt context excludes hidden target and includes visible entities", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const context = buildAttemptContext(run, {
    type: "attempt",
    actorId: "player",
    intent: "Look around"
  });

  assert.equal(context.ok, true);
  assert.ok(context.visibleEntities.length > 0);
  assert.equal(context.visibleEntities.some((entity) => entity.entityId.includes("hidden")), false);
});

test("provider input exposes contract without raw mutation authority", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const context = buildAttemptContext(run, {
    type: "attempt",
    actorId: "player",
    intent: "Search for hidden compartments"
  });

  const input = buildAttemptProviderInput(context);

  assert.equal(input.ok, true);
  assert.equal(input.instructions.doNotMutateState, true);
  assert.equal(input.instructions.serverRollsChecks, true);
  assert.equal(input.instructions.unsupportedEffectsRejected, true);
});

test("provider output rejects prompt leakage", () => {
  const validation = validateAttemptProviderOutput({
    summary: "SYSTEM: secret prompt",
    recommendedAbility: "persuasion",
    dc: 10,
    advantage: false,
    disadvantage: false,
    successNarration: "USER: leaked input",
    failureNarration: "No.",
    proposedEffects: []
  });

  assert.equal(validation.ok, false);
});

test("provider output rejects unsupported effects", () => {
  const validation = validateAttemptProviderOutput({
    summary: "You try it.",
    recommendedAbility: "strength",
    dc: 10,
    advantage: false,
    disadvantage: false,
    successNarration: "Success.",
    failureNarration: "Failure.",
    proposedEffects: [{ type: "inventory_change", itemId: "gold" }]
  });

  assert.equal(validation.ok, false);
});

test("ability check failure uses failure narration", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Force the door open"
  }, {
    fixedRoll: 1,
    attemptProviderFn: () => ({
      summary: "You try to force the door.",
      recommendedAbility: "strength",
      dc: 30,
      advantage: false,
      disadvantage: false,
      successNarration: "The door bursts open.",
      failureNarration: "The door holds firm.",
      proposedEffects: []
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, false);
  assert.match(result.attemptResult.narration, /holds firm/);
});

test("memory fact effect is persisted when allowed", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Make a memorable promise"
  }, {
    fixedRoll: 20,
    attemptProviderFn: () => ({
      summary: "You make a promise.",
      recommendedAbility: null,
      dc: null,
      advantage: false,
      disadvantage: false,
      successNarration: "The promise is remembered.",
      failureNarration: "The promise is ignored.",
      proposedEffects: [{ type: "memory_fact", text: "The player made a memorable promise." }]
    })
  });

  assert.equal(result.ok, true);
  assert.ok(result.memoryFact);
  assert.equal(result.run.memoryFacts.some((fact) => fact.type === "attempt_memory"), true);
});

test("invalid provider output falls back safely", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Do something strange"
  }, {
    attemptProviderFn: () => ({
      summary: "",
      recommendedAbility: "fake_skill",
      dc: 99,
      advantage: "no",
      disadvantage: false,
      successNarration: "",
      failureNarration: "",
      proposedEffects: [{ type: "stat_change" }]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.warnings.includes("ATTEMPT_PROVIDER_FALLBACK"), true);
});

// HARDEN (K/M degraded mode): when the GM provider is unavailable the
// deterministic fallback narration must still describe the OUTCOME by echoing
// the player's intent — never the flat "nothing happened" line that prompted
// this work. The live GM narration replaces it on the normal path.
test("rolled-success fallback narration echoes the intent (not a flat filler line)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // No attemptProviderFn -> deterministic defaultProviderOutput path.
  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Search the Data Den for hidden caches"
  }, { fixedRoll: 20 });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, true);
  assert.ok(result.attemptResult.checkResult, "contested search still rolls");
  // Outcome line references what the player actually did.
  assert.match(result.attemptResult.narration, /search the Data Den for hidden caches/i);
  assert.doesNotMatch(result.attemptResult.narration, /works well enough for now/i);
});

test("no-roll movement fallback narration echoes the intent", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Head toward the night market"
  });
  assert.equal(result.attemptResult.needsCheck, false);
  assert.equal(result.attemptResult.checkResult, null);
  assert.match(result.attemptResult.narration, /head toward the night market/i);
});

test("fallback narration strips characters that would break provider validation", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Search <b>the</b> room | table"
  }, { fixedRoll: 20 });
  assert.equal(result.ok, true);
  // No angle brackets or pipes survive into the narration.
  assert.doesNotMatch(result.attemptResult.narration, /[<>|]/);
});

test("failed attempt costs the player HP and surfaces the damage", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = run.player.resources.hitPoints.current; // 10 by default

  const result = failingAttempt(run);

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, false);
  assert.ok(result.attemptResult.damage, "damage is surfaced in the result");
  assert.equal(result.attemptResult.damage.amount, 2);
  assert.equal(result.attemptResult.damage.hpBefore, before);
  assert.equal(result.attemptResult.damage.hpAfter, before - 2);
  assert.equal(result.attemptResult.damage.downed, false);
  // The mutated run reflects the new HP for the scene payload to read back.
  assert.equal(result.run.player.resources.hitPoints.current, before - 2);
});

test("successful attempt does not cost HP", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = run.player.resources.hitPoints.current;

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Convince the guard"
  }, {
    fixedRoll: 20,
    attemptProviderFn: () => ({
      summary: "You make your case.",
      recommendedAbility: "persuasion",
      dc: 5,
      advantage: false,
      disadvantage: false,
      successNarration: "They nod you through.",
      failureNarration: "They wave you off.",
      proposedEffects: []
    })
  });

  assert.equal(result.attemptResult.success, true);
  assert.equal(result.attemptResult.damage, null);
  assert.equal(result.run.player.resources.hitPoints.current, before);
});

test("HP clamps at 0 (never negative) and reaching 0 HP sets the player dying", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.player.resources.hitPoints.current = 1; // one hit from going down

  const result = failingAttempt(run);

  assert.equal(result.ok, true, "dying run still validates");
  assert.equal(result.attemptResult.damage.hpBefore, 1);
  assert.equal(result.attemptResult.damage.hpAfter, 0);
  assert.equal(result.attemptResult.damage.amount, 1); // only the HP actually lost
  assert.equal(result.attemptResult.damage.downed, true);
  assert.equal(result.run.player.resources.hitPoints.current, 0);
  // 5e lethality: reaching 0 HP is now 'dying' (death saves begin), NOT a
  // consequence-free "downed" blackout.
  assert.equal(result.run.player.status, "dying");
  assert.equal(result.attemptResult.damage.dying, true);
});

test("applyFailureDamage never drives HP below zero", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.player.resources.hitPoints.current = 0;

  const record = applyFailureDamage(run, 5);

  assert.equal(record.hpBefore, 0);
  assert.equal(record.hpAfter, 0);
  assert.equal(record.amount, 0);
  assert.equal(record.downed, true);
  assert.equal(run.player.resources.hitPoints.current, 0);
});

test("damage is an allowed proposed-effect type", () => {
  const validation = validateAttemptProviderOutput({
    summary: "A risky shove.",
    recommendedAbility: "strength",
    dc: 10,
    advantage: false,
    disadvantage: false,
    successNarration: "It works.",
    failureNarration: "It backfires.",
    proposedEffects: [{ type: "damage" }]
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

// --- FIX H: roll gate — trivial movement/observation resolves with no dice ---

test("attemptNeedsCheck classifies movement/observation as no-roll and contest as roll", () => {
  // Movement / travel / navigation — the reported over-rolling bug.
  for (const intent of [
    "Head toward NightCity Market",
    "head to the market",
    "go to the docks",
    "walk into the tavern",
    "travel north",
    "enter the warehouse",
    "leave the alley",
    "Look around the room",
    "glance at the crowd"
  ]) {
    assert.equal(attemptNeedsCheck(intent), false, `"${intent}" should not roll`);
  }
  // Genuinely contested / uncertain — must still roll.
  for (const intent of [
    "Sneak past the guards",
    "Pick the lock",
    "Climb the wall",
    "Persuade the merchant",
    "Force the door open",
    "Search for hidden compartments",
    "Attack the bandit"
  ]) {
    assert.equal(attemptNeedsCheck(intent), true, `"${intent}" should roll`);
  }
  // Contested verb wins even when a movement word is also present.
  assert.equal(attemptNeedsCheck("sneak toward the gate"), true);
  // Ambiguous intents default to rolling (don't break uncertain actions).
  assert.equal(attemptNeedsCheck("do something strange"), true);
});

test("an explicit provider needsCheck overrides the heuristic", () => {
  // Movement verb that the heuristic would skip, but the provider forces a check.
  assert.equal(attemptNeedsCheck("walk across the rotten bridge", { needsCheck: true }), true);
  // Contested verb the heuristic would roll, but the provider waives it.
  assert.equal(attemptNeedsCheck("search the open shelf", { needsCheck: false }), false);
});

test("a no-roll movement attempt resolves narratively without dice or HP cost", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = run.player.resources.hitPoints.current;

  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Head toward NightCity Market"
  }, { fixedRoll: 1 }); // a forced low roll must NOT matter — no check is made

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.needsCheck, false);
  assert.equal(result.attemptResult.checkResult, null, "no dice for a no-stakes move");
  assert.equal(result.attemptResult.success, true, "the move just happens");
  assert.equal(result.attemptResult.damage, null, "no failure cost without a check");
  assert.equal(result.run.player.resources.hitPoints.current, before);
  assert.ok(result.attemptResult.narration.trim().length > 0, "still narrates");
  assert.equal(result.event.type, "attempt");
});

test("a no-roll attempt still applies a provider memory effect", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Walk to the shrine"
  }, {
    attemptProviderFn: () => ({
      summary: "You walk to the shrine.",
      recommendedAbility: null,
      dc: null,
      needsCheck: false,
      advantage: false,
      disadvantage: false,
      successNarration: "The shrine looms quietly as you arrive.",
      failureNarration: "—",
      proposedEffects: [{ type: "memory_fact", text: "The player visited the old shrine." }]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.needsCheck, false);
  assert.equal(result.attemptResult.checkResult, null);
  assert.ok(result.memoryFact, "memory effect persists even without a roll");
  assert.match(result.attemptResult.narration, /shrine/);
});

test("a contested attempt still rolls a real check (regression guard)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "Sneak past the guards"
  }, { fixedRoll: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.needsCheck, true);
  assert.ok(result.attemptResult.checkResult, "contested action rolls");
  assert.equal(result.attemptResult.success, false);
});

test("provider output accepts a needsCheck boolean", () => {
  const validation = validateAttemptProviderOutput({
    summary: "You stroll over.",
    recommendedAbility: null,
    dc: null,
    needsCheck: false,
    advantage: false,
    disadvantage: false,
    successNarration: "You arrive.",
    failureNarration: "—",
    proposedEffects: []
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  const bad = validateAttemptProviderOutput({
    summary: "x",
    successNarration: "x",
    failureNarration: "x",
    needsCheck: "yes",
    proposedEffects: []
  });
  assert.equal(bad.ok, false);
});
