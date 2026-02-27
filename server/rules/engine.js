function randomInt(min, max, rng = Math.random) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(rng() * (high - low + 1)) + low;
}

function parseTerm(term) {
  const normalized = String(term || "").trim();
  if (!normalized) {
    return null;
  }

  const diceMatch = normalized.match(/^([+-]?)(\d*)d(\d+)(kh1|kl1)?$/i);
  if (diceMatch) {
    const sign = diceMatch[1] === "-" ? -1 : 1;
    const count = Number(diceMatch[2] || 1);
    const sides = Number(diceMatch[3] || 20);
    const keep = String(diceMatch[4] || "").toLowerCase() || null;
    if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
      throw new Error("Dice term out of supported range.");
    }
    return {
      type: "dice",
      sign,
      count,
      sides,
      keep
    };
  }

  const flatMatch = normalized.match(/^([+-]?)(\d+)$/);
  if (flatMatch) {
    const sign = flatMatch[1] === "-" ? -1 : 1;
    const value = Number(flatMatch[2]);
    return {
      type: "flat",
      sign,
      value
    };
  }

  throw new Error(`Invalid dice term: ${normalized}`);
}

function splitTerms(expression) {
  const sanitized = String(expression || "")
    .toLowerCase()
    .replace(/\s+/g, "");

  if (!sanitized) {
    throw new Error("Dice expression is required.");
  }

  const parts = sanitized.match(/[+-]?[^+-]+/g);
  if (!parts || parts.length === 0) {
    throw new Error("Failed to parse dice expression.");
  }

  return parts.map((part) => parseTerm(part));
}

function evalDiceTerm(term, rng) {
  const rolls = [];
  for (let i = 0; i < term.count; i += 1) {
    rolls.push(randomInt(1, term.sides, rng));
  }

  let kept = [...rolls];
  if (term.keep === "kh1") {
    kept = [Math.max(...rolls)];
  }
  if (term.keep === "kl1") {
    kept = [Math.min(...rolls)];
  }

  const subtotal = kept.reduce((sum, value) => sum + value, 0) * term.sign;
  return {
    ...term,
    rolls,
    kept,
    subtotal
  };
}

function evalFlatTerm(term) {
  return {
    ...term,
    subtotal: term.sign * term.value
  };
}

function modifierFromScore(score) {
  return Math.floor((Number(score || 10) - 10) / 2);
}

export function rollDiceExpression(expression, { rng = Math.random } = {}) {
  const terms = splitTerms(expression);
  const detail = terms.map((term) => (term.type === "dice" ? evalDiceTerm(term, rng) : evalFlatTerm(term)));
  const total = detail.reduce((sum, term) => sum + term.subtotal, 0);

  return {
    expression,
    terms: detail,
    total
  };
}

export function resolveSkillCheck({ expression = "1d20", dc = 10, label = "Check" } = {}, { rng = Math.random } = {}) {
  const roll = rollDiceExpression(expression, { rng });
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
  const toHit = rollDiceExpression(attackExpression, { rng });
  const hit = toHit.total >= Number(targetAc || 12);
  const damage = hit ? rollDiceExpression(damageExpression, { rng }) : null;

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
