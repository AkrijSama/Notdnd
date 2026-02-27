import { uid } from "../utils/ids.js";

const DEFAULT_CLASSES = ["Fighter", "Wizard", "Rogue", "Cleric", "Ranger"];
const DEFAULT_MONSTERS = ["Bandit Scout", "Ruin Wolf", "Ash Cultist"];
const DEFAULT_SPELLS = ["Magic Missile", "Healing Word", "Shield", "Guiding Bolt"];
const DEFAULT_ITEMS = ["Potion of Healing", "Rope", "Signal Flare"];

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

function fallbackSummary() {
  return {
    documents: 0,
    books: 0,
    classes: 0,
    monsters: 0,
    spells: 0,
    npcs: 0,
    locations: 0,
    chapters: 0,
    scenes: 0,
    encounters: 0,
    items: 0,
    rules: 0,
    starterOptions: 0
  };
}

function safeIndexes(parsed) {
  return {
    chapters: Array.isArray(parsed?.indexes?.chapters) ? parsed.indexes.chapters : [],
    scenes: Array.isArray(parsed?.indexes?.scenes) ? parsed.indexes.scenes : [],
    encounters: Array.isArray(parsed?.indexes?.encounters) ? parsed.indexes.encounters : [],
    npcs: Array.isArray(parsed?.indexes?.npcs) ? parsed.indexes.npcs : [],
    items: Array.isArray(parsed?.indexes?.items) ? parsed.indexes.items : [],
    rules: Array.isArray(parsed?.indexes?.rules) ? parsed.indexes.rules : [],
    starterOptions: Array.isArray(parsed?.indexes?.starterOptions) ? parsed.indexes.starterOptions : []
  };
}

function buildSceneMaps({ campaignId, sceneBlueprints, partyTokens, enemyNames, fallbackLocation }) {
  const tokensByMap = {};
  const maps = sceneBlueprints.map((scene, idx) => {
    const mapId = uid("map");
    const map = {
      id: mapId,
      campaignId,
      name: `${scene.locationName || fallbackLocation} - ${scene.name}`,
      width: 12 + (idx % 2) * 2,
      height: 8 + (idx % 2),
      fogEnabled: true,
      dynamicLighting: true,
      imageUrl: `ASSET_MAP_PLACEHOLDER_${idx + 1}`
    };

    const partyStarts = [
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [2, 2]
    ];
    const enemyStarts = [
      [9, 5],
      [10, 5],
      [9, 6],
      [10, 6]
    ];

    tokensByMap[mapId] = [
      ...partyTokens.map((token, tokenIdx) => ({
        ...token,
        id: uid("tok_party"),
        x: partyStarts[tokenIdx % partyStarts.length][0],
        y: partyStarts[tokenIdx % partyStarts.length][1]
      })),
      ...enemyNames.slice(0, 4).map((enemyName, enemyIdx) => ({
        id: uid("tok_enemy"),
        label: initials(enemyName),
        color: "#d95d39",
        x: enemyStarts[enemyIdx % enemyStarts.length][0],
        y: enemyStarts[enemyIdx % enemyStarts.length][1],
        faction: "enemy"
      }))
    ];

    return map;
  });

  return { maps, tokensByMap };
}

function buildMarkdownMemoryDocs({ campaign, packageData, characters, encounters, maps, gmSettings }) {
  const sceneLines = packageData.scenes.map((scene, idx) => `## Scene ${idx + 1}: ${scene.name}\n- Goal: ${scene.objective}\n- Summary: ${scene.summary}\n- Keywords: ${(scene.keywords || []).join(", ")}`).join("\n\n");
  const npcLines = packageData.npcs.map((npc) => `- ${npc.name}: ${npc.role} | ${npc.summary}`).join("\n");
  const encounterLines = encounters.map((encounter) => `- ${encounter.name}: ${encounter.monsters.join(", ")} (${encounter.difficulty})`).join("\n");
  const characterLines = characters.map((character) => `- ${character.name}: ${character.className} | AC ${character.ac} | HP ${character.hp}`).join("\n");
  const mapLines = maps.map((map) => `- ${map.name}: ${map.width}x${map.height} fog=${map.fogEnabled ? "on" : "off"}`).join("\n");

  return {
    human: `# ${campaign.name} Human GM Guide\n\n## Runbook\n- Mode: Human GM\n- Style: ${gmSettings.gmStyle}\n- Rulebook: ${gmSettings.primaryRulebook}\n- Safety: ${gmSettings.safetyProfile}\n\n## Party\n${characterLines}\n\n## Maps\n${mapLines}\n\n## Encounters\n${encounterLines}\n\n## Scene Beats\n${sceneLines}\n\n## NPC Levers\n${npcLines || "- Add NPC levers here."}\n`,
    agent: `# ${campaign.name} Agent GM Guide\n\n## Directive\n- Run the campaign with concise responses.
- Use memory keywords first, then only the top matching sections.
- Preserve continuity and surface one clear decision point per turn.
\n## Active Plot Devices\n${packageData.chapters.map((chapter) => `- ${chapter.title}: ${chapter.summary}`).join("\n")}\n\n## Prepared Scenes\n${sceneLines}\n\n## Rules To Surface\n${packageData.rules.map((rule) => `- ${rule.name}: ${rule.summary}`).join("\n") || "- No custom rules indexed yet."}\n`,
    timeline: `# ${campaign.name} Shared Timeline\n\n## Current State\n- Campaign status: ${campaign.status}\n- Ready maps: ${maps.length}\n- Ready encounters: ${encounters.length}\n\n## Important Developments\n- Opening hook: ${packageData.scenes[0]?.objective || "Escort the party into the first conflict."}\n- Lead NPC: ${packageData.npcs[0]?.name || "Warden Elra"}\n- Pressure point: ${encounters[0]?.name || "Opening Clash"}\n\n## Update Log\n- Session 0 package generated for ${campaign.name}.\n`
  };
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
    indexes: safeIndexes(parsed),
    summary: parsed?.summary || fallbackSummary()
  };

  const campaignId = uid("cmp");
  const playerNames = (players || []).map((name) => normalizeName(name, "")).filter(Boolean);
  if (playerNames.length === 0) {
    playerNames.push("Arin", "Bex", "Cato");
  }

  const classPool = safeParsed.entities.classes.length > 0 ? safeParsed.entities.classes : DEFAULT_CLASSES;
  const spellPool = safeParsed.entities.spells.length > 0 ? safeParsed.entities.spells : DEFAULT_SPELLS;
  const monsterPool = safeParsed.entities.monsters.length > 0 ? safeParsed.entities.monsters : DEFAULT_MONSTERS;
  const npcPool = safeParsed.indexes.npcs.length > 0 ? safeParsed.indexes.npcs : (safeParsed.entities.npcs.length > 0 ? safeParsed.entities.npcs.map((name) => ({ name, role: "ally", summary: `${name} can steer the party.` })) : [{ name: "Warden Elra", role: "guide", summary: "Quest giver and field contact." }]);
  const locationPool = safeParsed.entities.locations.length > 0 ? safeParsed.entities.locations : ["The Ember Gate", "Stormglass Quay", "Ashfall Watch"];
  const itemPool = safeParsed.indexes.items.length > 0 ? safeParsed.indexes.items : DEFAULT_ITEMS.map((name) => ({ name, kind: "item", summary: `${name} is ready to seed into loot.` }));
  const rulePool = safeParsed.indexes.rules.length > 0 ? safeParsed.indexes.rules : [{ name: "Weather Pressure", summary: "Storm conditions increase urgency and visibility risk." }];
  const chapterPool = safeParsed.indexes.chapters.length > 0
    ? safeParsed.indexes.chapters
    : [{ id: uid("chapter"), title: "Opening Situation", summary: "Bring the party into motion.", keywords: ["opening", "hook"] }];
  const scenePool = safeParsed.indexes.scenes.length > 0
    ? safeParsed.indexes.scenes
    : chapterPool.slice(0, 3).map((chapter, idx) => ({
        id: uid("scene"),
        name: `${chapter.title} at ${locationPool[idx % locationPool.length]}`,
        chapterTitle: chapter.title,
        locationName: locationPool[idx % locationPool.length],
        summary: chapter.summary,
        objective: `Resolve the pressure point in ${locationPool[idx % locationPool.length]}.`,
        keywords: chapter.keywords || [chapter.title]
      }));
  const encounterSeeds = safeParsed.indexes.encounters.length > 0
    ? safeParsed.indexes.encounters
    : scenePool.map((scene, idx) => ({
        id: uid("enc_seed"),
        name: `${scene.locationName} Skirmish`,
        difficulty: ["Easy", "Medium", "Hard"][idx % 3],
        monsters: monsterPool.slice(idx, idx + 2),
        summary: `Opening encounter for ${scene.locationName}.`,
        keywords: scene.keywords || [scene.locationName]
      }));
  const starterOptions = safeParsed.indexes.starterOptions.length > 0
    ? safeParsed.indexes.starterOptions
    : classPool.slice(0, 4).map((className, idx) => ({
        id: uid("starter"),
        className,
        hook: `Tie ${className} into ${scenePool[idx % scenePool.length]?.locationName || "the first scene"}.`,
        spell: spellPool[idx % spellPool.length] || null,
        keywords: [className]
      }));

  const characters = playerNames.map((name, idx) => {
    const suggested = starterOptions[idx % starterOptions.length];
    const className = suggested?.className || classPool[idx % classPool.length];
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
      inventory: ["Adventurer Pack", ...(itemPool[idx % itemPool.length]?.name ? [itemPool[idx % itemPool.length].name] : []), "Potion of Healing"]
    };
  });

  const partyTokens = characters.map((character) => ({
    label: initials(character.name),
    color: "#116466",
    faction: "party"
  }));

  const sceneBlueprints = scenePool.slice(0, Math.max(2, Math.min(4, scenePool.length || 2))).map((scene, idx) => ({
    ...scene,
    chapterTitle: scene.chapterTitle || chapterPool[idx % chapterPool.length]?.title || `Chapter ${idx + 1}`,
    locationName: scene.locationName || locationPool[idx % locationPool.length] || "Adventure Site",
    objective: scene.objective || `Secure ${scene.locationName || locationPool[idx % locationPool.length] || "the site"}.`
  }));
  while (sceneBlueprints.length < 2) {
    const idx = sceneBlueprints.length;
    sceneBlueprints.push({
      id: uid("scene"),
      name: `${chapterPool[idx % chapterPool.length]?.title || `Chapter ${idx + 1}`} at ${locationPool[idx % locationPool.length] || "Adventure Site"}`,
      chapterTitle: chapterPool[idx % chapterPool.length]?.title || `Chapter ${idx + 1}`,
      locationName: locationPool[idx % locationPool.length] || "Adventure Site",
      summary: chapterPool[idx % chapterPool.length]?.summary || "Synthetic scene generated to keep the session launch playable.",
      objective: `Stabilize the situation in ${locationPool[idx % locationPool.length] || "Adventure Site"}.`,
      keywords: chapterPool[idx % chapterPool.length]?.keywords || ["synthetic", "scene"]
    });
  }

  const enemyNames = monsterPool.slice(0, Math.max(2, Math.min(4, monsterPool.length || 2)));
  const { maps, tokensByMap } = buildSceneMaps({
    campaignId,
    sceneBlueprints,
    partyTokens,
    enemyNames,
    fallbackLocation: locationPool[0]
  });

  const encounters = sceneBlueprints.map((scene, idx) => {
    const seed = encounterSeeds[idx % encounterSeeds.length] || {};
    return {
      id: uid("enc"),
      campaignId,
      name: seed.name || `${scene.locationName} Clash`,
      difficulty: seed.difficulty || ["Easy", "Medium", "Hard"][idx % 3],
      monsters: (seed.monsters && seed.monsters.length > 0 ? seed.monsters : enemyNames).slice(0, 3).map((name) => `1x ${name}`),
      xpBudget: 250 + idx * 100 + enemyNames.length * 50,
      mapId: maps[idx]?.id || maps[0]?.id || null,
      sceneId: scene.id
    };
  });

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
    activeMapId: maps[0]?.id || null,
    activeEncounterId: encounters[0]?.id || null
  };

  const campaignPackage = {
    campaignId,
    chapters: chapterPool.slice(0, 6).map((chapter) => ({
      id: chapter.id || uid("chapter"),
      title: chapter.title,
      summary: chapter.summary,
      keywords: chapter.keywords || []
    })),
    scenes: sceneBlueprints.map((scene, idx) => ({
      id: scene.id,
      name: scene.name,
      chapterTitle: scene.chapterTitle,
      locationName: scene.locationName,
      objective: scene.objective,
      summary: scene.summary,
      mapId: maps[idx]?.id || null,
      encounterId: encounters[idx]?.id || null,
      keywords: scene.keywords || []
    })),
    npcs: npcPool.slice(0, 8).map((npc) => ({
      id: npc.id || uid("npc"),
      name: npc.name || npc,
      role: npc.role || "ally",
      summary: npc.summary || `${npc.name || npc} matters to the party.`,
      keywords: npc.keywords || [npc.name || npc]
    })),
    items: itemPool.slice(0, 10).map((item) => ({
      id: item.id || uid("item"),
      name: item.name || item,
      kind: item.kind || "item",
      summary: item.summary || `${item.name || item} is ready to drop into play.`,
      keywords: item.keywords || [item.name || item]
    })),
    spells: spellPool.slice(0, 12).map((name) => ({
      id: uid("spell"),
      name,
      summary: `${name} is referenced in the quickstart package.`
    })),
    rules: rulePool.slice(0, 8).map((rule) => ({
      id: rule.id || uid("rule"),
      name: rule.name || rule,
      summary: rule.summary || `${rule.name || rule} should be surfaced at adjudication time.`,
      keywords: rule.keywords || [rule.name || rule]
    })),
    starterOptions: starterOptions.slice(0, 6).map((option) => ({
      id: option.id || uid("starter"),
      className: option.className,
      hook: option.hook,
      spell: option.spell || null,
      keywords: option.keywords || [option.className]
    }))
  };

  const journals = [
    {
      id: uid("jrnl"),
      campaignId,
      title: "Session Zero Brief",
      body: `${campaign.name} launches in ${sceneBlueprints[0]?.locationName || locationPool[0]}. Objective: ${sceneBlueprints[0]?.objective || "Hold the line."}`,
      tags: ["prep", "session-zero", "brief"],
      visibility: "gm"
    },
    {
      id: uid("jrnl"),
      campaignId,
      title: "NPC Roster",
      body: campaignPackage.npcs.map((npc) => `- ${npc.name}: ${npc.role} | ${npc.summary}`).join("\n"),
      tags: ["npcs", "reference"],
      visibility: "party"
    },
    {
      id: uid("jrnl"),
      campaignId,
      title: "Rules Callouts",
      body: campaignPackage.rules.map((rule) => `- ${rule.name}: ${rule.summary}`).join("\n"),
      tags: ["rules", "quick-reference"],
      visibility: "gm"
    }
  ];

  const gmSettings = {
    gmName: "Narrator Prime",
    gmStyle: "Cinematic Tactical",
    safetyProfile: "Table-Friendly",
    primaryRulebook: preferredRulebook || safeParsed.books[0]?.title || "Core Rules SRD",
    gmMode: "human",
    agentProvider: "local",
    agentModel: "local-gm-v1"
  };

  const chatLines = [
    {
      speaker: "System",
      text: `Quickstart ready: ${campaign.name}. Parsed ${safeParsed.summary.documents} file(s), ${safeParsed.summary.scenes || 0} scenes, and ${safeParsed.summary.monsters} monster hooks.`
    },
    {
      speaker: "AI GM",
      text: `Scene opens at ${sceneBlueprints[0]?.locationName || locationPool[0]}. ${campaignPackage.npcs[0]?.name || "Warden Elra"} asks the party to secure the perimeter before reinforcements fail.`
    }
  ];

  const memoryDocs = buildMarkdownMemoryDocs({
    campaign,
    packageData: campaignPackage,
    characters,
    encounters,
    maps,
    gmSettings
  });

  return {
    campaign,
    books: safeParsed.books,
    characters,
    encounters,
    maps,
    tokensByMap,
    initiative,
    gmSettings,
    journals,
    campaignPackage,
    memoryDocs,
    chatLines,
    parsedSummary: safeParsed.summary
  };
}
