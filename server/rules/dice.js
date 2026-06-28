// ---------------------------------------------------------------------------
// Shared low-level dice primitives used by both resolution paths:
//   - server/solo/rules.js   (character-sheet-driven solo ability checks)
//   - server/rules/engine.js (expression-driven GM combat)
// The two resolvers stay separate by design; only these primitives are shared,
// so rng / fixedRoll injection and the ability-modifier formula behave
// identically across both. Pure functions: no state, no I/O.
// ---------------------------------------------------------------------------

// 5e ability modifier: floor((score - 10) / 2). Non-numeric input coerces via
// Number() (so NaN scores yield NaN), preserving the historical solo behavior.
export function abilityModifier(score) {
  return Math.floor((Number(score) - 10) / 2);
}

// A single d20. Supports deterministic injection for tests: `fixedRoll` (a
// single value), `fixedRolls` (a queue, shifted per call so advantage/
// disadvantage consume two), or a custom `rng` (() => 0..1). Defaults to
// Math.random. Result is clamped to 1..20.
export function rollD20(options = {}) {
  if (Number.isInteger(options.fixedRoll)) {
    return Math.min(20, Math.max(1, options.fixedRoll));
  }
  if (Array.isArray(options.fixedRolls) && Number.isInteger(options.fixedRolls[0])) {
    return Math.min(20, Math.max(1, options.fixedRolls.shift()));
  }
  const rng = typeof options.rng === "function" ? options.rng : Math.random;
  return Math.floor(rng() * 20) + 1;
}

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

// Evaluates a dice expression like "2d6+3", "1d20+5", or "1d20kh1" (keep
// highest / "kl1" keep lowest). Returns { expression, terms, total } where
// `terms` carries the per-term roll detail. rng injectable for deterministic
// tests.
export function rollDice(expression, { rng = Math.random } = {}) {
  const terms = splitTerms(expression);
  const detail = terms.map((term) => (term.type === "dice" ? evalDiceTerm(term, rng) : evalFlatTerm(term)));
  const total = detail.reduce((sum, term) => sum + term.subtotal, 0);

  return {
    expression,
    terms: detail,
    total
  };
}
