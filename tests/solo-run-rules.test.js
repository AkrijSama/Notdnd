import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  resolveAbilityCheck,
  resolveAbilityModifier,
  rollD20,
  validateAbilityCheck
} from "../server/solo/rules.js";

function baseCheck(overrides = {}) {
  return {
    checkId: "check_test",
    rulesetId: "notdnd_basic",
    ability: "intelligence",
    skill: "investigation",
    dc: 10,
    ...overrides
  };
}

test("ability modifier calculation matches 5e-style floor formula", () => {
  assert.equal(resolveAbilityModifier(8), -1);
  assert.equal(resolveAbilityModifier(10), 0);
  assert.equal(resolveAbilityModifier(13), 1);
  assert.equal(resolveAbilityModifier(20), 5);
});

test("d20 roll can be deterministic in tests", () => {
  assert.equal(rollD20({ fixedRoll: 12 }), 12);
  assert.equal(rollD20({ rng: () => 0 }), 1);
  assert.equal(rollD20({ rng: () => 0.999 }), 20);
});

test("ability check success", () => {
  const run = createDefaultSoloRun({ runId: "rules_success" });
  run.player.abilities.intelligence = 14;
  run.player.skills.investigation = 2;

  const result = resolveAbilityCheck(run, baseCheck({ dc: 15 }), { fixedRoll: 12 });

  assert.equal(result.ok, true);
  assert.equal(result.abilityModifier, 2);
  assert.equal(result.skillModifier, 2);
  assert.equal(result.total, 16);
  assert.equal(result.success, true);
});

test("ability check failure", () => {
  const run = createDefaultSoloRun({ runId: "rules_failure" });

  const result = resolveAbilityCheck(run, baseCheck({ dc: 18 }), { fixedRoll: 9 });

  assert.equal(result.ok, true);
  assert.equal(result.total, 9);
  assert.equal(result.success, false);
});

test("advantage keeps higher roll", () => {
  const run = createDefaultSoloRun({ runId: "rules_advantage" });

  const result = resolveAbilityCheck(run, baseCheck({ advantage: true }), { fixedRolls: [3, 17] });

  assert.deepEqual(result.rolls, [3, 17]);
  assert.equal(result.keptRoll, 17);
});

test("disadvantage keeps lower roll", () => {
  const run = createDefaultSoloRun({ runId: "rules_disadvantage" });

  const result = resolveAbilityCheck(run, baseCheck({ disadvantage: true }), { fixedRolls: [18, 4] });

  assert.deepEqual(result.rolls, [18, 4]);
  assert.equal(result.keptRoll, 4);
});

test("invalid ability is rejected", () => {
  const result = validateAbilityCheck(baseCheck({ ability: "alchemy" }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "ability"));
});

test("invalid skill is rejected", () => {
  const result = validateAbilityCheck(baseCheck({ skill: "acrobatics" }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "skill"));
});
