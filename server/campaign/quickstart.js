import { uid } from "../utils/ids.js";

const DEFAULT_CLASSES = ["Fighter", "Wizard", "Rogue", "Cleric", "Ranger"];
const DEFAULT_MONSTERS = ["Bandit Scout", "Ruin Wolf", "Ash Cultist"];
const DEFAULT_SPELLS = ["Magic Missile", "Healing Word", "Shield", "Guiding Bolt"];

function normalizeName(value, fallback) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function initials(name) {
  const parts = normalizeName(name, "P").split(" ").filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || "P"}${parts[1][0] || "P"}`.toUpperCase();
}

function scoreFromName(name, min, max) {
  const input = normalizeName(name, "unit");
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  const range = max - min + 1;
  return min + (hash % range);
}

function statsForClass(className) {
  const name = String(className || "").toLowerCase();
  if (name.includes("wizard") || name.includes("sorcer") || name.includes("warlock")) {
    return { str: 8, dex: 14, con: 12, int: 16, wis: 11, cha: 14 };
  }
  if (name.includes("rogue") || name.includes("ranger") || name.includes("bard")) {
    return { str: 10, dex: 16, con: 13, int: 12, wis: 14, cha: 12 };
  }
  if (name.includes("cleric") || name.includes("paladin") || name.includes("druid")) {
    return { str: 13, dex: 10, con: 14, int: 10, wis: 16, cha: 12 };
  }
  return { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 };
}

function classVitals(className) {
  const name = String(className || "").toLowerCase();
  if (name.includes("wizard") || name.includes("sorcer") || name.includes("warlock")) {
    return { ac: 12, hp: 10 };
  }
  if (name.includes("rogue") || name.includes("ranger") || name.includes("bard")) {
    return { ac: 14, hp: 12 };
  }
  if (name.includes("cleric") || name.includes("paladin") || name.includes("druid")) {
    return { ac: 15, hp: 13 };
  }
  return { ac: 16, hp: 14 };
}

export function buildQuickstartBlueprint({
  campaignName,
  setting,
  players,
  parsed,
  preferredRulebook
}) {
  const safeParsed = {
    books: Array.isArray(parsed?.books) ? parsed.books : [],
    entities: {
      classes: Array.isArray(parsed?.entities?.classes) ? parsed.entities.classes : [],
      monsters: Array.isArray(parsed?.entities?.monsters) ? parsed.entities.monsters : [],
      spells: Array.isArray(parsed?.entities?.spells) ? parsed.entities.spells : [],
      npcs: Array.isArray(parsed?.entities?.npcs) ? parsed.entities.npcs : [],
      locations: Array.isArray(parsed?.entities?.locations) ? parsed.entities.locations : []
    },
    summary: parsed?.summary || {
      documents: 0,
      books: 0,
      classes: 0,
      monsters: 0,
      spells: 0,
      npcs: 0,
      locations: 0
    }
  };

  const campaignId = uid("cmp");
  const mapId = uid("map");
  const encounterId = uid("enc");

  const playerNames = (players || []).map((name) => normalizeName(name, "")).filter(Boolean);
  if (playerNames.length === 0) {
    playerNames.push("Arin", "Bex", "Cato");
  }

  const classPool = safeParsed.entities.classes.length > 0 ? safeParsed.entities.classes : DEFAULT_CLASSES;
  const spellPool = safeParsed.entities.spells.length > 0 ? safeParsed.entities.spells : DEFAULT_SPELLS;
  const monsterPool = safeParsed.entities.monsters.length > 0 ? safeParsed.entities.monsters : DEFAULT_MONSTERS;
  const npcPool = safeParsed.entities.npcs.length > 0 ? safeParsed.entities.npcs : ["Warden Elra", "Keeper Nox"];
  const locationPool = safeParsed.entities.locations.length > 0 ? safeParsed.entities.locations : ["The Ember Gate"];

  const characters = playerNames.map((name, idx) => {
    const className = classPool[idx % classPool.length];
    const vitals = classVitals(className);
    const spells = spellPool.slice(idx, idx + 2);

    return {
      id: uid("char"),
      campaignId,
      name,
      className,
      level: 1,
      ac: vitals.ac,
      hp: vitals.hp,
      speed: 30,
      stats: statsForClass(className),
      proficiencies: ["Perception", "Athletics"],
      spells: spells.length > 0 ? spells : spellPool.slice(0, 2),
      inventory: ["Adventurer Pack", "Rations", "Potion of Healing"]
    };
  });

  const enemyNames = monsterPool.slice(0, Math.max(2, Math.min(4, monsterPool.length || 2)));
  const encounterMonsters = enemyNames.map((name) => `1x ${name}`);

  const map = {
    id: mapId,
    campaignId,
    name: `${locationPool[0]} - Starter Grid`,
    width: 12,
    height: 8,
    fogEnabled: true,
    dynamicLighting: true
  };

  const partyTokenStarts = [
    [1, 1],
    [2, 1],
    [3, 1],
    [1, 2],
    [2, 2]
  ];

  const enemyTokenStarts = [
    [9, 5],
    [10, 5],
    [9, 6],
    [10, 6]
  ];

  const partyTokens = characters.map((character, idx) => ({
    id: uid("tok_party"),
    label: initials(character.name),
    color: "#116466",
    x: partyTokenStarts[idx % partyTokenStarts.length][0],
    y: partyTokenStarts[idx % partyTokenStarts.length][1],
    faction: "party"
  }));

  const enemyTokens = enemyNames.map((enemyName, idx) => ({
    id: uid("tok_enemy"),
    label: initials(enemyName),
    color: "#d95d39",
    x: enemyTokenStarts[idx % enemyTokenStarts.length][0],
    y: enemyTokenStarts[idx % enemyTokenStarts.length][1],
    faction: "enemy"
  }));

  const initiative = [
    ...characters.map((character) => ({
      id: uid("init"),
      campaignId,
      name: character.name,
      value: scoreFromName(character.name, 11, 20)
    })),
    ...enemyNames.map((enemyName) => ({
      id: uid("init"),
      campaignId,
      name: enemyName,
      value: scoreFromName(enemyName, 8, 16)
    }))
  ];

  const campaign = {
    id: campaignId,
    name: normalizeName(campaignName, "Rapid Homebrew Campaign"),
    setting: normalizeName(setting, "Homebrew Frontier"),
    status: "Ready",
    readiness: 95,
    sessionCount: 0,
    players: playerNames,
    sourceBooks: [],
    activeMapId: mapId,
    activeEncounterId: encounterId
  };

  const encounter = {
    id: encounterId,
    campaignId,
    name: `Opening Clash at ${locationPool[0]}`,
    difficulty: "Medium",
    monsters: encounterMonsters,
    xpBudget: 350 + enemyNames.length * 50
  };

  const gmSettings = {
    gmName: "Narrator Prime",
    gmStyle: "Cinematic Tactical",
    safetyProfile: "Table-Friendly",
    primaryRulebook: preferredRulebook || safeParsed.books[0]?.title || "Core Rules SRD"
  };

  const chatLines = [
    {
      speaker: "System",
      text: `Quickstart ready: ${campaign.name}. Parsed ${safeParsed.summary.documents} file(s) with ${safeParsed.summary.monsters} monster hooks.`
    },
    {
      speaker: "AI GM",
      text: `Scene opens at ${locationPool[0]}. ${npcPool[0]} asks the party to secure the gate before reinforcements arrive.`
    }
  ];

  return {
    campaign,
    books: safeParsed.books,
    characters,
    encounter,
    map,
    tokens: [...partyTokens, ...enemyTokens],
    initiative,
    gmSettings,
    chatLines,
    parsedSummary: safeParsed.summary
  };
}
