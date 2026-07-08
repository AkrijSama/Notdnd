import { SKILLS as SRD_SKILL_ABILITIES } from "./dndData.js";
import { abilityModifier, rollD20 } from "../rules/dice.js";

export const RULESET_IDS = ["notdnd_basic", "5e_srd", "custom"];
export const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];

// Live skill vocabulary, derived from the SRD skill table (dndData.SKILLS) so the
// resolver recognizes all 18 skills from one source of truth instead of a hand-
// maintained subset of 5. Keys are the skill name lowercased ("animal handling",
// "sleight of hand"); values are the governing ability. A check's `skill` field
// and player.skills are keyed by these same ids.
export const SKILL_ABILITY = Object.freeze(
  Object.fromEntries(
    Object.entries(SRD_SKILL_ABILITIES).map(([name, ability]) => [name.toLowerCase(), ability])
  )
);
export const SKILLS = Object.freeze(Object.keys(SKILL_ABILITY));

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

// Re-exported from the shared dice primitive (../rules/dice.js) under their
// historical names so existing importers (tests, attempt.js) are unaffected.
// resolveAbilityModifier is the solo-side name for the shared abilityModifier.
export { rollD20 };
export const resolveAbilityModifier = abilityModifier;

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

  // Edge/Burden are the Ch3 canonical terms (roll 2d20 keep high/low). The legacy
  // advantage/disadvantage fields are accepted as wire aliases with identical
  // mechanics — the resolver folds either name into the same behavior.
  if (check.advantage !== undefined && typeof check.advantage !== "boolean") {
    push(errors, "advantage", "Expected boolean");
  }

  if (check.disadvantage !== undefined && typeof check.disadvantage !== "boolean") {
    push(errors, "disadvantage", "Expected boolean");
  }

  if (check.edge !== undefined && typeof check.edge !== "boolean") {
    push(errors, "edge", "Expected boolean");
  }

  if (check.burden !== undefined && typeof check.burden !== "boolean") {
    push(errors, "burden", "Expected boolean");
  }

  return result(errors);
}

// Ch3 Law 2 — three bands. The resolver owns the band; nothing downstream
// authors it. The middle band is a locked flat 20% of the d20 (miss by 1–4).
export const RESOLUTION_BANDS = Object.freeze({
  SUCCESS: "success",
  SUCCESS_AT_COST: "success_at_cost",
  FAILURE: "failure"
});

// Map a signed margin (total − DC) to its band. Meet/beat = success; miss by
// 1–4 = success at a cost; miss by 5+ = failure with consequence.
export function bandFromMargin(margin) {
  if (margin >= 0) return RESOLUTION_BANDS.SUCCESS;
  if (margin >= -4) return RESOLUTION_BANDS.SUCCESS_AT_COST;
  return RESOLUTION_BANDS.FAILURE;
}

// Player-facing outcome label for a resolution band — the THREE distinct states
// the outcome card must show. THE MOAT FIX (#28): a sub-DC roll must never read
// as a bare "Success". The middle band is its own honest label ("Success at a
// cost"), paired with a roll under the DC and a committed cost — so the card, the
// roll math, and the GM narration all key off the SAME band and cannot disagree.
// A no-roll ("automatic") action has no pass/fail label (returns null).
export function outcomeLabelForBand(band) {
  switch (band) {
    case RESOLUTION_BANDS.SUCCESS:
      return "Success";
    case RESOLUTION_BANDS.SUCCESS_AT_COST:
      return "Success at a cost";
    case RESOLUTION_BANDS.FAILURE:
      return "Failure";
    default:
      return null;
  }
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
  // Edge/Burden (Ch3) fold in the legacy advantage/disadvantage aliases; they
  // don't stack, and holding both cancels to a straight roll.
  const wantsEdge = check.edge === true || check.advantage === true;
  const wantsBurden = check.burden === true || check.disadvantage === true;
  const hasEdge = wantsEdge && !wantsBurden;
  const hasBurden = wantsBurden && !wantsEdge;
  const rolls = hasEdge || hasBurden
    ? [rollD20(options), rollD20(options)]
    : [rollD20(options)];
  const keptRoll = hasEdge ? Math.max(...rolls) : hasBurden ? Math.min(...rolls) : rolls[0];
  const abilityScore = safeNumber(run?.player?.abilities?.[check.ability], 10);
  const abilityModifier = resolveAbilityModifier(abilityScore);
  const skillModifier = check.skill ? safeNumber(run?.player?.skills?.[check.skill], 0) : 0;
  const total = keptRoll + abilityModifier + skillModifier;
  const margin = total - check.dc;
  const band = bandFromMargin(margin);

  return {
    ok: true,
    checkId: check.checkId || null,
    rolls,
    keptRoll,
    abilityModifier,
    skillModifier,
    total,
    dc: check.dc,
    // `success` = met/beat the DC (the SUCCESS band only). Downstream that must
    // treat "success at a cost" as intent-achieved reads `band`, not `success`.
    success: total >= check.dc,
    margin,
    band,
    // Canonical Ch3 circumstance terms echoed on the outcome payload.
    edge: hasEdge,
    burden: hasBurden,
    rulesetId,
    ability: check.ability,
    skill: check.skill ?? null
  };
}
