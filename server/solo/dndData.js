// ---------------------------------------------------------------------------
// D&D 5e SRD content as DATA (never markup). Consumed by the character builder
// (characterBuild.js), the creation UI, and the character-sheet renderer. Keep
// this file pure data + tiny pure helpers so every surface renders from one
// source of truth.
// ---------------------------------------------------------------------------

export const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
export const ABILITY_LABELS = {
  strength: "STR",
  dexterity: "DEX",
  constitution: "CON",
  intelligence: "INT",
  wisdom: "WIS",
  charisma: "CHA"
};

export const ABILITY_SCORE_METHODS = ["standard_array", "point_buy", "roll"];
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_BUDGET = 27;
const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

// Skill -> governing ability.
export const SKILLS = {
  Acrobatics: "dexterity",
  "Animal Handling": "wisdom",
  Arcana: "intelligence",
  Athletics: "strength",
  Deception: "charisma",
  History: "intelligence",
  Insight: "wisdom",
  Intimidation: "charisma",
  Investigation: "intelligence",
  Medicine: "wisdom",
  Nature: "intelligence",
  Perception: "wisdom",
  Performance: "charisma",
  Persuasion: "charisma",
  Religion: "intelligence",
  "Sleight of Hand": "dexterity",
  Stealth: "dexterity",
  Survival: "wisdom"
};

export const RACES = [
  { name: "Human", abilityBonuses: { strength: 1, dexterity: 1, constitution: 1, intelligence: 1, wisdom: 1, charisma: 1 }, speed: 30, size: "Medium", traits: ["Versatile (+1 to all abilities)", "Extra language"] },
  { name: "Elf", abilityBonuses: { dexterity: 2 }, speed: 30, size: "Medium", traits: ["Darkvision", "Keen Senses", "Fey Ancestry", "Trance"] },
  { name: "Dwarf", abilityBonuses: { constitution: 2 }, speed: 25, size: "Medium", traits: ["Darkvision", "Dwarven Resilience", "Dwarven Combat Training", "Stonecunning"] },
  { name: "Halfling", abilityBonuses: { dexterity: 2 }, speed: 25, size: "Small", traits: ["Lucky", "Brave", "Halfling Nimbleness"] },
  { name: "Gnome", abilityBonuses: { intelligence: 2 }, speed: 25, size: "Small", traits: ["Darkvision", "Gnome Cunning"] },
  { name: "Half-Orc", abilityBonuses: { strength: 2, constitution: 1 }, speed: 30, size: "Medium", traits: ["Darkvision", "Menacing", "Relentless Endurance", "Savage Attacks"] },
  { name: "Tiefling", abilityBonuses: { charisma: 2, intelligence: 1 }, speed: 30, size: "Medium", traits: ["Darkvision", "Hellish Resistance", "Infernal Legacy"] },
  { name: "Dragonborn", abilityBonuses: { strength: 2, charisma: 1 }, speed: 30, size: "Medium", traits: ["Draconic Ancestry", "Breath Weapon", "Damage Resistance"] },
  { name: "Half-Elf", abilityBonuses: { charisma: 2 }, speed: 30, size: "Medium", traits: ["Darkvision", "Fey Ancestry", "Skill Versatility", "+1 to two other abilities"] },
  { name: "Aasimar", abilityBonuses: { charisma: 2 }, speed: 30, size: "Medium", traits: ["Darkvision", "Celestial Resistance", "Healing Hands", "Light Bearer"] }
];

const ALL_SKILL_NAMES = Object.keys(SKILLS);

export const CLASSES = [
  { name: "Barbarian", hitDie: "d12", primaryAbility: "strength", savingThrows: ["strength", "constitution"], skillCount: 2, skillList: ["Animal Handling", "Athletics", "Intimidation", "Nature", "Perception", "Survival"], features: ["Rage", "Unarmored Defense"], startingEquipment: ["Greataxe", "Two handaxes", "Explorer's pack", "Four javelins"], description: "A fierce warrior who channels primal rage in battle." },
  { name: "Bard", hitDie: "d8", primaryAbility: "charisma", savingThrows: ["dexterity", "charisma"], skillCount: 3, skillList: ALL_SKILL_NAMES, features: ["Spellcasting", "Bardic Inspiration"], startingEquipment: ["Rapier", "Diplomat's pack", "Lute", "Leather armor", "Dagger"], description: "An inspiring magician whose power echoes the music of creation." },
  { name: "Cleric", hitDie: "d8", primaryAbility: "wisdom", savingThrows: ["wisdom", "charisma"], skillCount: 2, skillList: ["History", "Insight", "Medicine", "Persuasion", "Religion"], features: ["Spellcasting", "Divine Domain"], startingEquipment: ["Mace", "Scale mail", "Shield", "Priest's pack", "Holy symbol"], description: "A priestly champion who wields divine magic in service of a higher power." },
  { name: "Druid", hitDie: "d8", primaryAbility: "wisdom", savingThrows: ["intelligence", "wisdom"], skillCount: 2, skillList: ["Arcana", "Animal Handling", "Insight", "Medicine", "Nature", "Perception", "Religion", "Survival"], features: ["Druidic", "Spellcasting"], startingEquipment: ["Wooden shield", "Scimitar", "Leather armor", "Explorer's pack", "Druidic focus"], description: "A priest of the Old Faith, wielding the powers of nature." },
  { name: "Fighter", hitDie: "d10", primaryAbility: "strength", savingThrows: ["strength", "constitution"], skillCount: 2, skillList: ["Acrobatics", "Animal Handling", "Athletics", "History", "Insight", "Intimidation", "Perception", "Survival"], features: ["Fighting Style", "Second Wind"], startingEquipment: ["Chain mail", "Martial weapon and shield", "Light crossbow and 20 bolts", "Dungeoneer's pack"], description: "A master of martial combat, skilled with a wide array of weapons and armor." },
  { name: "Monk", hitDie: "d8", primaryAbility: "dexterity", savingThrows: ["strength", "dexterity"], skillCount: 2, skillList: ["Acrobatics", "Athletics", "History", "Insight", "Religion", "Stealth"], features: ["Unarmored Defense", "Martial Arts"], startingEquipment: ["Shortsword", "Dungeoneer's pack", "Ten darts"], description: "A martial artist who harnesses the power of body and ki." },
  { name: "Paladin", hitDie: "d10", primaryAbility: "strength", savingThrows: ["wisdom", "charisma"], skillCount: 2, skillList: ["Athletics", "Insight", "Intimidation", "Medicine", "Persuasion", "Religion"], features: ["Divine Sense", "Lay on Hands"], startingEquipment: ["Chain mail", "Martial weapon and shield", "Five javelins", "Priest's pack", "Holy symbol"], description: "A holy warrior bound to a sacred oath." },
  { name: "Ranger", hitDie: "d10", primaryAbility: "dexterity", savingThrows: ["strength", "dexterity"], skillCount: 3, skillList: ["Animal Handling", "Athletics", "Insight", "Investigation", "Nature", "Perception", "Stealth", "Survival"], features: ["Favored Enemy", "Natural Explorer"], startingEquipment: ["Scale mail", "Two shortswords", "Dungeoneer's pack", "Longbow and quiver of 20 arrows"], description: "A warrior of the wilderness, a hunter of monsters." },
  { name: "Rogue", hitDie: "d8", primaryAbility: "dexterity", savingThrows: ["dexterity", "intelligence"], skillCount: 4, skillList: ["Acrobatics", "Athletics", "Deception", "Insight", "Intimidation", "Investigation", "Perception", "Performance", "Persuasion", "Sleight of Hand", "Stealth"], features: ["Expertise", "Sneak Attack", "Thieves' Cant"], startingEquipment: ["Rapier", "Shortbow and quiver of 20 arrows", "Burglar's pack", "Leather armor", "Two daggers", "Thieves' tools"], description: "A scoundrel who uses stealth and guile to overcome obstacles." },
  { name: "Sorcerer", hitDie: "d6", primaryAbility: "charisma", savingThrows: ["constitution", "charisma"], skillCount: 2, skillList: ["Arcana", "Deception", "Insight", "Intimidation", "Persuasion", "Religion"], features: ["Spellcasting", "Sorcerous Origin"], startingEquipment: ["Light crossbow and 20 bolts", "Arcane focus", "Dungeoneer's pack", "Two daggers"], description: "A spellcaster who draws on inherent, innate magic." },
  { name: "Warlock", hitDie: "d8", primaryAbility: "charisma", savingThrows: ["wisdom", "charisma"], skillCount: 2, skillList: ["Arcana", "Deception", "History", "Intimidation", "Investigation", "Nature", "Religion"], features: ["Otherworldly Patron", "Pact Magic"], startingEquipment: ["Light crossbow and 20 bolts", "Arcane focus", "Scholar's pack", "Leather armor", "Simple weapon", "Two daggers"], description: "A wielder of magic derived from a pact with an otherworldly being." },
  { name: "Wizard", hitDie: "d6", primaryAbility: "intelligence", savingThrows: ["intelligence", "wisdom"], skillCount: 2, skillList: ["Arcana", "History", "Insight", "Investigation", "Medicine", "Religion"], features: ["Spellcasting", "Arcane Recovery"], startingEquipment: ["Quarterstaff", "Component pouch", "Scholar's pack", "Spellbook"], description: "A scholarly magic-user capable of manipulating arcane structures of reality." }
];

export const BACKGROUNDS = [
  { name: "Acolyte", skillProficiencies: ["Insight", "Religion"], toolProficiencies: [], equipment: ["Holy symbol", "Prayer book", "Vestments", "Common clothes", "15 gp"], feature: { name: "Shelter of the Faithful", description: "You and your companions can receive free healing and care at temples of your faith." } },
  { name: "Criminal", skillProficiencies: ["Deception", "Stealth"], toolProficiencies: ["One gaming set", "Thieves' tools"], equipment: ["Crowbar", "Dark hooded clothes", "15 gp"], feature: { name: "Criminal Contact", description: "You have a reliable contact in the criminal underworld who relays messages for you." } },
  { name: "Folk Hero", skillProficiencies: ["Animal Handling", "Survival"], toolProficiencies: ["One artisan's tools", "Vehicles (land)"], equipment: ["Artisan's tools", "Shovel", "Iron pot", "Common clothes", "10 gp"], feature: { name: "Rustic Hospitality", description: "Common folk will shelter and hide you from the law or those who hunt you." } },
  { name: "Noble", skillProficiencies: ["History", "Persuasion"], toolProficiencies: ["One gaming set"], equipment: ["Fine clothes", "Signet ring", "Scroll of pedigree", "25 gp"], feature: { name: "Position of Privilege", description: "People are inclined to think the best of you; you are welcome in high society." } },
  { name: "Outlander", skillProficiencies: ["Athletics", "Survival"], toolProficiencies: ["One musical instrument"], equipment: ["Staff", "Hunting trap", "Trophy from a slain animal", "Traveler's clothes", "10 gp"], feature: { name: "Wanderer", description: "You have an excellent memory for maps and geography and can always find food and water in the wild." } },
  { name: "Sage", skillProficiencies: ["Arcana", "History"], toolProficiencies: [], equipment: ["Bottle of ink", "Quill", "Small knife", "Letter from a dead colleague", "Common clothes", "10 gp"], feature: { name: "Researcher", description: "When you don't know something, you often know where and from whom you can learn it." } },
  { name: "Soldier", skillProficiencies: ["Athletics", "Intimidation"], toolProficiencies: ["One gaming set", "Vehicles (land)"], equipment: ["Insignia of rank", "Trophy from a fallen enemy", "Deck of cards", "Common clothes", "10 gp"], feature: { name: "Military Rank", description: "Soldiers loyal to your former organization still recognize your authority." } },
  { name: "Charlatan", skillProficiencies: ["Deception", "Sleight of Hand"], toolProficiencies: ["Disguise kit", "Forgery kit"], equipment: ["Fine clothes", "Disguise kit", "Tools of the con", "15 gp"], feature: { name: "False Identity", description: "You have a second identity with documentation and established acquaintances." } },
  { name: "Entertainer", skillProficiencies: ["Acrobatics", "Performance"], toolProficiencies: ["Disguise kit", "One musical instrument"], equipment: ["Musical instrument", "Favor of an admirer", "Costume", "15 gp"], feature: { name: "By Popular Demand", description: "You can always find a place to perform in exchange for lodging and food." } },
  { name: "Guild Artisan", skillProficiencies: ["Insight", "Persuasion"], toolProficiencies: ["One artisan's tools"], equipment: ["Artisan's tools", "Letter of introduction from your guild", "Traveler's clothes", "15 gp"], feature: { name: "Guild Membership", description: "Your guild provides lodging, support, and political connections." } },
  { name: "Hermit", skillProficiencies: ["Medicine", "Religion"], toolProficiencies: ["Herbalism kit"], equipment: ["Scroll case of notes", "Winter blanket", "Herbalism kit", "Common clothes", "5 gp"], feature: { name: "Discovery", description: "Your seclusion gave you access to a unique and powerful discovery." } },
  { name: "Sailor", skillProficiencies: ["Athletics", "Perception"], toolProficiencies: ["Navigator's tools", "Vehicles (water)"], equipment: ["Belaying pin (club)", "50 feet of silk rope", "Lucky charm", "Common clothes", "10 gp"], feature: { name: "Ship's Passage", description: "You can secure free passage on a sailing ship for yourself and your companions." } },
  { name: "Urchin", skillProficiencies: ["Sleight of Hand", "Stealth"], toolProficiencies: ["Disguise kit", "Thieves' tools"], equipment: ["Small knife", "Map of your home city", "Pet mouse", "Token of your parents", "Common clothes", "10 gp"], feature: { name: "City Secrets", description: "You know the secret patterns of cities and can find passages others would miss." } }
];

export function abilityModifier(score) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.floor((n - 10) / 2) : 0;
}

export function formatModifier(mod) {
  const n = Number(mod) || 0;
  return `${n >= 0 ? "+" : ""}${n}`;
}

export function proficiencyBonusForLevel(level = 1) {
  const lvl = Math.max(1, Number(level) || 1);
  return Math.floor((lvl - 1) / 4) + 2;
}

export function pointBuyCost(score) {
  return Object.prototype.hasOwnProperty.call(POINT_BUY_COST, score) ? POINT_BUY_COST[score] : null;
}

export function hitDieMax(hitDie) {
  const match = /d(\d+)/i.exec(String(hitDie || ""));
  return match ? Number(match[1]) : 8;
}

export function getRace(name) {
  const key = String(name || "").trim().toLowerCase();
  return RACES.find((race) => race.name.toLowerCase() === key) || null;
}

export function getClass(name) {
  const key = String(name || "").trim().toLowerCase();
  return CLASSES.find((entry) => entry.name.toLowerCase() === key) || null;
}

export function getBackground(name) {
  const key = String(name || "").trim().toLowerCase();
  return BACKGROUNDS.find((entry) => entry.name.toLowerCase() === key) || null;
}

/**
 * Rolls 4d6-drop-lowest six times. Accepts an injectable rng (() => 0..1) for
 * deterministic tests; defaults to Math.random.
 * @param {() => number} [rng]
 * @returns {number[]} six scores, descending
 */
export function rollAbilityScores(rng = Math.random) {
  const rollOne = () => {
    const dice = [0, 0, 0, 0].map(() => 1 + Math.floor(rng() * 6));
    dice.sort((a, b) => a - b);
    return dice[1] + dice[2] + dice[3];
  };
  return [rollOne(), rollOne(), rollOne(), rollOne(), rollOne(), rollOne()].sort((a, b) => b - a);
}
