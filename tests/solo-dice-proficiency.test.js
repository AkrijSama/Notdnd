import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildCharacter, toRunPlayer } from "../server/solo/characterBuild.js";
import { resolveAbilityCheck, validateAbilityCheck, SKILLS } from "../server/solo/rules.js";
import { resolveAttemptAction } from "../server/solo/attempt.js";

function abilityScores(overrides = {}) {
  return {
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    ...overrides
  };
}

// --- FIX 1: proficiency reaches skill checks via player.skills -------------

test("toRunPlayer projects proficiency-only skill modifiers", () => {
  const built = buildCharacter({
    characterClass: "Rogue", // proficient: Stealth (chosen) etc.
    background: "Criminal", // Deception, Stealth
    baseAbilityScores: abilityScores({ dexterity: 16 }),
    chosenSkills: ["Stealth"]
  });
  const player = toRunPlayer(built, { abilities: {}, resources: {} });

  // player.skills carries ONLY the proficiency component (the resolver adds the
  // ability modifier separately) — so trained = proficiencyBonus, untrained = 0.
  assert.equal(player.skills.stealth, 2);
  assert.equal(player.skills.arcana, 0);
});

test("a trained skill rolls higher than an untrained one through the live resolver", () => {
  const built = buildCharacter({
    characterClass: "Rogue",
    background: "Criminal",
    baseAbilityScores: abilityScores({ dexterity: 16 }), // +3
    chosenSkills: ["Stealth"]
  });
  const run = createDefaultSoloRun({ runId: "prof_check" });
  run.player = toRunPlayer(built, run.player);

  const stealth = resolveAbilityCheck(run, {
    checkId: "c", rulesetId: "5e_srd", ability: "dexterity", skill: "stealth", dc: 10
  }, { fixedRoll: 10 });

  // 10 (roll) + 3 (DEX) + 2 (proficiency) = 15 — not the +3 of an untrained roll.
  assert.equal(stealth.abilityModifier, 3);
  assert.equal(stealth.skillModifier, 2);
  assert.equal(stealth.total, 15);

  const acrobatics = resolveAbilityCheck(run, {
    checkId: "c", rulesetId: "5e_srd", ability: "dexterity", skill: "acrobatics", dc: 10
  }, { fixedRoll: 10 });
  // Rogue here is not proficient in Acrobatics: 10 + 3 + 0 = 13.
  assert.equal(acrobatics.skillModifier, 0);
  assert.equal(acrobatics.total, 13);
});

// --- FIX 2: full skill vocabulary is live ---------------------------------

test("live resolver recognizes the full 18-skill vocabulary", () => {
  assert.equal(SKILLS.length, 18);
  for (const [skill, ability] of [["acrobatics", "dexterity"], ["animal handling", "wisdom"], ["sleight of hand", "dexterity"]]) {
    const ok = validateAbilityCheck({ checkId: "c", rulesetId: "notdnd_basic", ability, skill, dc: 10 }).ok;
    assert.equal(ok, true, `${skill} should be a recognized skill`);
  }
});

// --- FIX 3: no silent auto-succeed + intent-derived DC fallback ------------

test("attempt with no provider ability/DC still rolls and can fail", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, {
    type: "attempt", actorId: "player", intent: "Force the heavy door"
  }, {
    fixedRoll: 1,
    attemptProviderFn: () => ({
      summary: "You strain at the door.",
      recommendedAbility: null,
      dc: null,
      advantage: false,
      disadvantage: false,
      successNarration: "It swings open.",
      failureNarration: "It does not budge.",
      proposedEffects: []
    })
  });

  assert.equal(result.ok, true);
  assert.ok(result.attemptResult.checkResult, "a check is rolled, never skipped");
  assert.equal(result.attemptResult.success, false); // roll 1 vs an inferred DC
});

test("fallback DC scales with intent difficulty instead of a flat 10", () => {
  const easy = resolveAttemptAction(createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" }), {
    type: "attempt", actorId: "player", intent: "Open the door"
  }, { fixedRoll: 8 });
  const hard = resolveAttemptAction(createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" }), {
    type: "attempt", actorId: "player", intent: "Sneak past the guards"
  }, { fixedRoll: 8 });

  assert.equal(easy.attemptResult.checkResult.dc, 8);
  assert.equal(hard.attemptResult.checkResult.dc, 16);
  assert.equal(easy.attemptResult.success, true); // 8 + 0 >= 8
  assert.equal(hard.attemptResult.success, false); // 8 + 0 < 16
});
