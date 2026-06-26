import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_ARRAY,
  abilityModifier,
  getBackground,
  getClass,
  getRace,
  pointBuyCost,
  proficiencyBonusForLevel,
  rollAbilityScores
} from "../server/solo/dndData.js";
import { buildCharacter } from "../server/solo/characterBuild.js";

test("dndData primitive helpers", () => {
  assert.equal(abilityModifier(16), 3);
  assert.equal(abilityModifier(8), -1);
  assert.equal(abilityModifier(10), 0);
  assert.equal(proficiencyBonusForLevel(1), 2);
  assert.equal(proficiencyBonusForLevel(5), 3);
  assert.equal(pointBuyCost(15), 9);
  assert.equal(pointBuyCost(16), null);
  assert.deepEqual(STANDARD_ARRAY, [15, 14, 13, 12, 10, 8]);
});

test("dndData lookups are case-insensitive and complete", () => {
  assert.equal(getRace("dwarf").speed, 25);
  assert.deepEqual(getRace("Dwarf").abilityBonuses, { constitution: 2 });
  assert.equal(getClass("Wizard").hitDie, "d6");
  assert.deepEqual(getClass("Fighter").savingThrows, ["strength", "constitution"]);
  assert.ok(getBackground("Sailor").skillProficiencies.includes("Perception"));
  assert.equal(getRace("nope"), null);
});

test("rollAbilityScores returns six in-range scores (deterministic with injected rng)", () => {
  const scores = rollAbilityScores(() => 0.99); // always max die
  assert.equal(scores.length, 6);
  for (const s of scores) {
    assert.ok(s >= 3 && s <= 18, `score ${s} out of range`);
  }
  // sorted descending
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("buildCharacter resolves a full level-1 sheet (Dwarf Fighter Soldier)", () => {
  const c = buildCharacter({
    name: "Brunn",
    race: "Dwarf",
    characterClass: "Fighter",
    background: "Soldier",
    baseAbilityScores: { strength: 15, dexterity: 13, constitution: 14, intelligence: 10, wisdom: 12, charisma: 8 }
  });

  assert.equal(c.race, "Dwarf");
  assert.equal(c.class, "Fighter");
  assert.equal(c.background, "Soldier");
  assert.equal(c.level, 1);
  assert.equal(c.proficiencyBonus, 2);

  // racial bonus applied
  assert.equal(c.abilityScores.base.constitution, 14);
  assert.equal(c.abilityScores.racialBonuses.constitution, 2);
  assert.equal(c.abilityScores.final.constitution, 16);
  assert.equal(c.abilityModifiers.constitution, 3);

  // derived stats
  assert.equal(c.derivedStats.maxHp, 13); // d10(10) + CON(+3)
  assert.equal(c.derivedStats.armorClass, 11); // 10 + DEX(+1)
  assert.equal(c.derivedStats.speed, 25); // Dwarf
  assert.equal(c.derivedStats.initiative, 1);
  assert.equal(c.derivedStats.passivePerception, 11); // 10 + WIS(+1), not proficient

  // saving throws (Fighter: STR, CON)
  const strSave = c.savingThrows.find((s) => s.ability === "strength");
  assert.equal(strSave.proficient, true);
  assert.equal(strSave.modifier, 4); // +2 + prof 2
  assert.equal(c.savingThrows.find((s) => s.ability === "dexterity").proficient, false);

  // skills (Soldier: Athletics, Intimidation)
  const athletics = c.skills.find((s) => s.name === "Athletics");
  assert.equal(athletics.proficient, true);
  assert.equal(athletics.modifier, 4); // STR +2 + prof 2
  assert.equal(c.skills.find((s) => s.name === "Acrobatics").proficient, false);

  assert.ok(c.classFeatures.includes("Second Wind"));
  assert.ok(c.racialTraits.includes("Darkvision"));
  assert.ok(c.startingEquipment.includes("Chain mail"));
  assert.ok(c.startingEquipment.includes("Insignia of rank"));
});

test("buildCharacter degrades gracefully with no choices", () => {
  const c = buildCharacter({});
  assert.equal(c.race, null);
  assert.equal(c.class, null);
  assert.equal(c.level, 1);
  assert.equal(c.derivedStats.maxHp, 8); // default d8 + CON 0
  assert.equal(c.derivedStats.armorClass, 10);
  assert.equal(c.derivedStats.speed, 30);
  assert.deepEqual(c.classFeatures, []);
});
