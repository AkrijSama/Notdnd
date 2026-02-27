export const PLACEHOLDER_CONFIG = {
  ai: {
    gmProviderName: "AI_GM_PROVIDER_NAME",
    gmModelValue: "AI_GM_MODEL_VALUE",
    imageProviderName: "IMAGE_PROVIDER_NAME",
    imageModelValue: "IMAGE_MODEL_VALUE",
    voiceProviderName: "VOICE_PROVIDER_NAME",
    voiceModelValue: "VOICE_MODEL_VALUE"
  },
  media: {
    defaultCampaignImage: "CAMPAIGN_COVER_PLACEHOLDER_URL",
    defaultTokenImage: "TOKEN_PLACEHOLDER_URL"
  }
};

export const OFFICIAL_BOOKS = [
  {
    id: "book_core_5e",
    title: "Core Rules SRD",
    type: "Official",
    tags: ["rules", "spells", "monsters"],
    chapters: ["Character Creation", "Combat", "Magic", "Monsters"]
  },
  {
    id: "book_dm_guide",
    title: "Dungeon Master Guide",
    type: "Official",
    tags: ["loot", "encounters", "worldbuilding"],
    chapters: ["Campaign Arcs", "NPC Design", "Treasure Tables"]
  }
];

export const STARTER_CHARACTERS = [
  {
    id: "char_001",
    name: "Asha Emberforge",
    className: "Artificer",
    level: 3,
    ac: 15,
    hp: 24,
    speed: 30,
    stats: { str: 10, dex: 14, con: 14, int: 17, wis: 12, cha: 11 },
    proficiencies: ["Arcana", "Investigation", "Thieves' Tools"],
    spells: ["Cure Wounds", "Faerie Fire", "Grease"],
    inventory: ["Repeating Shot Crossbow", "Tinker's Tools", "Alchemist's Fire"]
  },
  {
    id: "char_002",
    name: "Thorn Valewind",
    className: "Ranger",
    level: 3,
    ac: 14,
    hp: 28,
    speed: 35,
    stats: { str: 12, dex: 17, con: 13, int: 10, wis: 15, cha: 9 },
    proficiencies: ["Stealth", "Survival", "Perception"],
    spells: ["Hunter's Mark", "Goodberry"],
    inventory: ["Longbow", "Twin Shortswords", "Herbalism Kit"]
  }
];

export const STARTER_MAP = {
  id: "map_001",
  name: "Ashfall Outpost",
  width: 10,
  height: 10,
  fogEnabled: true,
  dynamicLighting: true
};

export const STARTER_TOKENS = [
  { id: "tok_party_asha", label: "A", color: "#116466", x: 1, y: 1, faction: "party" },
  { id: "tok_party_thorn", label: "T", color: "#2e5aac", x: 2, y: 1, faction: "party" },
  { id: "tok_enemy_warden", label: "W", color: "#d95d39", x: 7, y: 6, faction: "enemy" }
];

export const STARTER_ENCOUNTERS = [
  {
    id: "enc_001",
    name: "Gatehouse Ambush",
    difficulty: "Medium",
    monsters: ["2x Ash Goblin", "1x Ember Hound"],
    xpBudget: 450
  }
];

export const STARTER_CAMPAIGNS = [
  {
    id: "cmp_001",
    name: "The Cinder March",
    setting: "Post-dragon frontier",
    status: "In Progress",
    readiness: 72,
    sessionCount: 6,
    players: ["Asha", "Thorn", "Mira"],
    activeMapId: "map_001",
    activeEncounterId: "enc_001"
  }
];

export const AI_SYSTEM_PROMPT_TEMPLATE =
  "You are {{GM_NAME}} using style={{GM_STYLE}} and safety={{SAFETY_PROFILE}}. Reference campaign={{CAMPAIGN_NAME}} and rulebook={{PRIMARY_RULEBOOK}}.";
