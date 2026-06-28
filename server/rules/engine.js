import { rollDice } from "./dice.js";

// Expression-driven GM combat resolver. The low-level dice parsing/rolling now
// lives in ./dice.js (shared with the solo character-sheet resolver). The roller
// is re-exported under its historical name so existing consumers
// (db/repository.js, gm/prompting.js, gm/triggerParser.js) keep importing
// `rollDiceExpression` from here unchanged.
export const rollDiceExpression = rollDice;

export function resolveSkillCheck({ expression = "1d20", dc = 10, label = "Check" } = {}, { rng = Math.random } = {}) {
  const roll = rollDice(expression, { rng });
  return {
    type: "skill_check",
    label,
    dc: Number(dc || 10),
    roll,
    success: roll.total >= Number(dc || 10)
  };
}

export function resolveAttack(
  {
    attacker = "Attacker",
    target = "Target",
    attackExpression = "1d20+5",
    targetAc = 12,
    damageExpression = "1d8+3",
    damageType = "slashing"
  } = {},
  { rng = Math.random } = {}
) {
  const toHit = rollDice(attackExpression, { rng });
  const hit = toHit.total >= Number(targetAc || 12);
  const damage = hit ? rollDice(damageExpression, { rng }) : null;

  return {
    type: "attack",
    attacker,
    target,
    targetAc: Number(targetAc || 12),
    toHit,
    hit,
    damage,
    damageType
  };
}

export function formatRollSummary(roll) {
  return `${roll.expression} = ${roll.total}`;
}
