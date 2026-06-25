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

function normalizedScores(baseAbilityScores = {}) {
  const base = {};
  for (const ability of ABILITIES) {
    const value = Number(baseAbilityScores[ability]);
    base[ability] = Number.isFinite(value) ? value : 10;
  }
  return base;
}

/**
 * @param {{ name?: string, pronouns?: string, race?: string, characterClass?: string,
 *   background?: string, baseAbilityScores?: Record<string, number>, chosenSkills?: string[],
 *   level?: number }} [choices]
 * @returns {object} full character record
 */
export function buildCharacter(choices = {}) {
  const level = Math.max(1, Number(choices.level) || 1);
  const raceData = getRace(choices.race);
  const classData = getClass(choices.characterClass);
  const backgroundData = getBackground(choices.background);
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
    name: choices.name ? String(choices.name) : null,
    pronouns: choices.pronouns ? String(choices.pronouns) : null,
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
  player.level = character?.level || player.level || 1;
  player.proficiencyBonus = character?.proficiencyBonus || 2;
  player.abilities = { ...(player.abilities || {}), ...(character?.abilityScores?.final || {}) };

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
