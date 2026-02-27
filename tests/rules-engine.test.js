import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttack, resolveSkillCheck, rollDiceExpression } from "../server/rules/engine.js";

function fixedRngFactory(values) {
  let idx = 0;
  return () => {
    const value = values[idx % values.length];
    idx += 1;
    return value;
  };
}

test("rollDiceExpression handles keep-high and modifiers", () => {
  const rng = fixedRngFactory([0.1, 0.95]);
  const roll = rollDiceExpression("2d20kh1+3", { rng });

  assert.equal(roll.total, 23);
  assert.equal(roll.terms.length, 2);
  assert.equal(roll.terms[0].kept[0], 20);
});

test("resolveSkillCheck computes success against dc", () => {
  const rng = fixedRngFactory([0.5]);
  const check = resolveSkillCheck({ expression: "1d20+2", dc: 10, label: "Perception" }, { rng });

  assert.equal(check.roll.total, 13);
  assert.equal(check.success, true);
});

test("resolveAttack handles hit and damage", () => {
  const rng = fixedRngFactory([0.95, 0.7]);
  const attack = resolveAttack(
    {
      attacker: "Asha",
      target: "Goblin",
      attackExpression: "1d20+4",
      targetAc: 15,
      damageExpression: "1d8+2"
    },
    { rng }
  );

  assert.equal(attack.hit, true);
  assert.equal(attack.toHit.total, 24);
  assert.equal(attack.damage.total, 8);
});
