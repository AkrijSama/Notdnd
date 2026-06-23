import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  buildAttemptContext,
  buildAttemptProviderInput,
  resolveAttemptAction,
  validateAttemptAction,
  validateAttemptProviderOutput
} from "../server/solo/attempt.js";

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
