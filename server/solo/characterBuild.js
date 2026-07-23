import {
  ABILITIES,
  SKILLS,
  abilityModifier,
  getBackground,
  getClass,
  getRace,
  hitDieMax,
  proficiencyBonusForLevel
} from "./dndData.js";

// ---------------------------------------------------------------------------
// Pure resolver: turns creation choices into a full level-1 5e character record
// (the enrichment stored on run.player). Renders the review sheet and the
// in-game character tab. No state, no I/O.
// ---------------------------------------------------------------------------

// Declared gender from declared pronouns (identity-as-state). Local to keep the
// module self-contained (mirrors schema.deriveGenderFromPronouns).
function deriveGenderFromPronouns(pronouns) {
  const s = String(pronouns || "").toLowerCase();
  if (/\b(she|her|hers)\b/.test(s)) return "female";
  if (/\b(they|them|their)\b/.test(s)) return "nonbinary";
  if (/\b(he|him|his)\b/.test(s)) return "male";
  return null;
}

function normalizedScores(baseAbilityScores = {}) {
  const base = {};
  for (const ability of ABILITIES) {
    const value = Number(baseAbilityScores[ability]);
    base[ability] = Number.isFinite(value) ? value : 10;
  }
  return base;
}

// Resolves a creation choice by name: custom content (SRD-shaped) wins over SRD
// so authored content is available alongside — and applies through — the same
// code path. `customList` entries must already be normalized to the SRD shape
// (see homebrew/customContent.normalizeContentForBuild).
function resolveByName(name, customList, srdGetter) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  const custom = (Array.isArray(customList) ? customList : []).find(
    (entry) => entry && String(entry.name || "").trim().toLowerCase() === key
  );
  return custom || srdGetter(name);
}

// UI-15: title-case a character name at CREATION so the STORED value (run.player.name,
// read by narration/prompts everywhere) is capitalized, not just the display. Every word's
// first letter is uppercased; the rest of the word is left as typed (so "McCoy"/"O'Ryan"
// survive). Connecting words (of/the/and/a/an/to/in/on/at/by/for + the nobiliary particles
// von/van/de/la/del/di) stay LOWERCASE unless they lead — standard English title case, so
// "aldric of the waking mile" → "Aldric of the Waking Mile", not "...Of The...".
const NAME_CONNECTORS = new Set([
  "of", "the", "and", "a", "an", "to", "in", "on", "at", "by", "for",
  "von", "van", "de", "la", "del", "di", "der", "den"
]);
export function titleCaseName(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  return s
    .split(" ")
    .map((w, i) => {
      if (i > 0 && NAME_CONNECTORS.has(w.toLowerCase())) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * @param {{ name?: string, pronouns?: string, race?: string, characterClass?: string,
 *   background?: string, baseAbilityScores?: Record<string, number>, chosenSkills?: string[],
 *   level?: number }} [choices]
 * @param {{ customContent?: { races?: object[], classes?: object[], backgrounds?: object[] } }} [options]
 *   Optional SRD-shaped custom content (races/classes/backgrounds) that augments
 *   the SRD catalog. Custom mechanics apply identically to SRD ones.
 * @returns {object} full character record
 */
export function buildCharacter(choices = {}, options = {}) {
  const custom = options.customContent || {};
  const level = Math.max(1, Number(choices.level) || 1);
  const raceData = resolveByName(choices.race, custom.races, getRace);
  const classData = resolveByName(choices.characterClass, custom.classes, getClass);
  const backgroundData = resolveByName(choices.background, custom.backgrounds, getBackground);
  const proficiencyBonus = proficiencyBonusForLevel(level);

  const base = normalizedScores(choices.baseAbilityScores);
  const racialBonuses = {};
  const final = {};
  const modifiers = {};
  for (const ability of ABILITIES) {
    racialBonuses[ability] = Number(raceData?.abilityBonuses?.[ability]) || 0;
    final[ability] = base[ability] + racialBonuses[ability];
    modifiers[ability] = abilityModifier(final[ability]);
  }

  const saveProficiencies = new Set(classData?.savingThrows || []);
  const savingThrows = ABILITIES.map((ability) => ({
    ability,
    proficient: saveProficiencies.has(ability),
    modifier: modifiers[ability] + (saveProficiencies.has(ability) ? proficiencyBonus : 0)
  }));

  const skillProficiencies = new Set([
    ...(backgroundData?.skillProficiencies || []),
    ...(Array.isArray(choices.chosenSkills) ? choices.chosenSkills : [])
  ]);
  const skills = Object.entries(SKILLS).map(([skill, ability]) => ({
    name: skill,
    ability,
    proficient: skillProficiencies.has(skill),
    modifier: modifiers[ability] + (skillProficiencies.has(skill) ? proficiencyBonus : 0)
  }));

  const maxHp = Math.max(1, hitDieMax(classData?.hitDie) + modifiers.constitution);
  const derivedStats = {
    maxHp,
    armorClass: 10 + modifiers.dexterity,
    speed: raceData?.speed ?? 30,
    initiative: modifiers.dexterity,
    passivePerception: 10 + modifiers.wisdom + (skillProficiencies.has("Perception") ? proficiencyBonus : 0)
  };

  const startingEquipment = [
    ...(classData?.startingEquipment || []),
    ...(backgroundData?.equipment || [])
  ];

  return {
    name: choices.name ? titleCaseName(String(choices.name)) : null,
    pronouns: choices.pronouns ? String(choices.pronouns) : null,
    bodyType: choices.bodyType ? String(choices.bodyType) : null,
    race: raceData?.name || (choices.race ? String(choices.race) : null),
    class: classData?.name || (choices.characterClass ? String(choices.characterClass) : null),
    background: backgroundData?.name || (choices.background ? String(choices.background) : null),
    level,
    proficiencyBonus,
    abilityScores: { base, racialBonuses, final },
    abilityModifiers: modifiers,
    derivedStats,
    savingThrows,
    skills,
    startingEquipment,
    classFeatures: classData?.features || [],
    racialTraits: raceData?.traits || []
  };
}

/**
 * Projects a built character onto a run.player object, preserving the required
 * run.player structure (stats, skills, resources) and overlaying the 5e data:
 * final ability scores onto `abilities` (same keys), HP from derived maxHp, and
 * the full character record under `player.character` for the sheet. Pure.
 * @param {object} character output of buildCharacter()
 * @param {object} [basePlayer] existing run.player to merge onto
 * @returns {object} new run.player
 */
export function toRunPlayer(character, basePlayer = {}) {
  const player = { ...basePlayer };
  if (character?.name) {
    player.displayName = character.name;
  }
  player.className = character?.class || player.className || null;
  player.characterClass = character?.class || null;
  player.race = character?.race || null;
  player.background = character?.background || null;
  player.pronouns = character?.pronouns || null;
  // Declared gender (identity-as-state): explicit field wins, else derived from
  // the declared pronouns (he→male, she→female, they→nonbinary). Committed truth
  // for the portrait gender token + the pronoun audit.
  player.gender = (typeof character?.gender === "string" && character.gender.trim())
    ? character.gender.trim()
    : deriveGenderFromPronouns(character?.pronouns);
  // Declared build (identity-as-state): explicit choice wins; else keep whatever the
  // base run carried (createDefaultSoloRun's Average default), no pronoun derivation.
  player.bodyType = (typeof character?.bodyType === "string" && character.bodyType.trim())
    ? character.bodyType.trim()
    : (player.bodyType || null);
  player.level = character?.level || player.level || 1;
  // Milestone truth (Ch7 delta Phase 1): creation levels ARE milestones under
  // the identity mapping; clamp to the chassis cap (vault input max is 20).
  player.milestone = Math.min(20, Math.max(1, Math.round(Number(player.level) || 1)));
  player.proficiencyBonus = character?.proficiencyBonus || 2;
  player.abilities = { ...(player.abilities || {}), ...(character?.abilityScores?.final || {}) };

  // Project the skill table onto player.skills so trained skills actually reach
  // the live resolver (resolveAbilityCheck in rules.js). That resolver computes
  // total = roll + abilityModifier(score) + skillModifier, adding the ability
  // modifier from the score itself — so player.skills must carry ONLY the
  // proficiency component (proficiencyBonus when proficient, else 0); folding the
  // ability mod in here would double-count it. Keyed by the skill name lowercased
  // to match the resolver/dndData vocabulary. Net effect: a Rogue with DEX 16
  // (+3) proficient in Stealth rolls at +5 (3 ability + 2 proficiency), while an
  // untrained character rolls at +3.
  const proficiencyBonus = Number(character?.proficiencyBonus) || 0;
  player.skills = { ...(player.skills || {}) };
  for (const skill of Array.isArray(character?.skills) ? character.skills : []) {
    if (!skill?.name) {
      continue;
    }
    player.skills[String(skill.name).toLowerCase()] = skill.proficient ? proficiencyBonus : 0;
  }

  const maxHp = character?.derivedStats?.maxHp;
  if (Number.isFinite(maxHp)) {
    player.health = maxHp;
    player.maxHealth = maxHp;
    player.resources = {
      ...(player.resources || {}),
      hitPoints: { current: maxHp, max: maxHp }
    };
  }

  player.character = character || null; // full 5e record for the sheet tab
  return player;
}
