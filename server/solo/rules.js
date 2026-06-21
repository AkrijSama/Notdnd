export const RULESET_IDS = ["notdnd_basic", "5e_srd", "custom"];
export const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
export const SKILLS = ["investigation", "perception", "stealth", "persuasion", "insight"];

const RULESET_VALUES = new Set(RULESET_IDS);
const ABILITY_VALUES = new Set(ABILITIES);
const SKILL_VALUES = new Set(SKILLS);

function result(errors) {
  return {
    ok: errors.length === 0,
    errors
  };
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRulesetId(value) {
  return RULESET_VALUES.has(value) ? value : "notdnd_basic";
}

function safeNumber(value, fallback = 0) {
  return isNumber(value) ? value : fallback;
}

export function resolveAbilityModifier(score) {
  return Math.floor((Number(score) - 10) / 2);
}

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

export function validateAbilityCheck(check) {
  const errors = [];
  if (!isPlainObject(check)) {
    push(errors, "check", "Expected object");
    return result(errors);
  }

  if (check.checkId !== undefined && check.checkId !== null && !isString(check.checkId)) {
    push(errors, "checkId", "Expected non-empty string");
  }

  if (check.rulesetId !== undefined && check.rulesetId !== null && !RULESET_VALUES.has(check.rulesetId)) {
    push(errors, "rulesetId", `Expected one of: ${RULESET_IDS.join(", ")}`);
  }

  if (!ABILITY_VALUES.has(check.ability)) {
    push(errors, "ability", `Expected one of: ${ABILITIES.join(", ")}`);
  }

  if (check.skill !== undefined && check.skill !== null && !SKILL_VALUES.has(check.skill)) {
    push(errors, "skill", `Expected one of: ${SKILLS.join(", ")}`);
  }

  if (!isNumber(check.dc)) {
    push(errors, "dc", "Expected number");
  }

  if (check.advantage !== undefined && typeof check.advantage !== "boolean") {
    push(errors, "advantage", "Expected boolean");
  }

  if (check.disadvantage !== undefined && typeof check.disadvantage !== "boolean") {
    push(errors, "disadvantage", "Expected boolean");
  }

  return result(errors);
}

export function resolveAbilityCheck(run, check, options = {}) {
  const validation = validateAbilityCheck(check);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const rulesetId = normalizeRulesetId(check.rulesetId || run?.rulesetId || run?.player?.rulesetId);
  const hasAdvantage = check.advantage === true && check.disadvantage !== true;
  const hasDisadvantage = check.disadvantage === true && check.advantage !== true;
  const rolls = hasAdvantage || hasDisadvantage
    ? [rollD20(options), rollD20(options)]
    : [rollD20(options)];
  const keptRoll = hasAdvantage ? Math.max(...rolls) : hasDisadvantage ? Math.min(...rolls) : rolls[0];
  const abilityScore = safeNumber(run?.player?.abilities?.[check.ability], 10);
  const abilityModifier = resolveAbilityModifier(abilityScore);
  const skillModifier = check.skill ? safeNumber(run?.player?.skills?.[check.skill], 0) : 0;
  const total = keptRoll + abilityModifier + skillModifier;

  return {
    ok: true,
    checkId: check.checkId || null,
    rolls,
    keptRoll,
    abilityModifier,
    skillModifier,
    total,
    dc: check.dc,
    success: total >= check.dc,
    rulesetId,
    ability: check.ability,
    skill: check.skill ?? null
  };
}
