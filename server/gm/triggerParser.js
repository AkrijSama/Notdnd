const ABILITY_MAP = {
  strength: "Strength",
  str: "Strength",
  dexterity: "Dexterity",
  dex: "Dexterity",
  constitution: "Constitution",
  con: "Constitution",
  intelligence: "Intelligence",
  int: "Intelligence",
  wisdom: "Wisdom",
  wis: "Wisdom",
  charisma: "Charisma",
  cha: "Charisma"
};

const ENTITY_TYPES = new Set(["npc", "location", "faction", "event", "item", "lore", "quest", "relationship"]);
const TRIGGERISH_PATTERN = /\b(check|skill\s*check|ability\s*check|save|saving\s*throw|initiative|combat|damage|attack|loot|treasure|reward|new_entity|update_entity)\b/i;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function normalizeWhitespace(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseKeyValues(source = "") {
  const values = {};
  const pattern = /([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s+[a-z_]+\s*=|$)/gi;
  for (const match of String(source || "").matchAll(pattern)) {
    const key = String(match[1] || "").trim().toLowerCase();
    const value = String(match[2] ?? match[3] ?? match[4] ?? "")
      .trim()
      .replace(/,$/, "");
    if (key && value) {
      values[key] = value;
    }
  }
  return values;
}

function normalizeAbility(rawAbility = "") {
  const key = String(rawAbility || "").trim().toLowerCase();
  return ABILITY_MAP[key] || "";
}

function parseCheckTrigger(content = "", header = "") {
  const payload = String(content || "").replace(/^(?:SKILL\s*CHECK|ABILITY\s*CHECK|CHECK|SAVE|SAVING\s*THROW)\s*:?\s*/i, "");
  const abilityMatch = payload.match(/\b(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)\b/i);
  const dcMatch = payload.match(/\bdc\s*[: ]?\s*(-?\d+)/i);
  if (!abilityMatch || !dcMatch) {
    return null;
  }

  const ability = normalizeAbility(abilityMatch[1]);
  if (!ability) {
    return null;
  }

  const subtype = /\bsave|saving throw\b/i.test(header) ? "save" : "check";
  return {
    type: "CHECK",
    parsed: {
      ability,
      dc: clamp(dcMatch[1], 1, 30),
      subtype
    }
  };
}

function parseInitiativeTrigger(content = "") {
  const normalized = String(content || "").trim();
  if (/^(?:ROLL\s+INITIATIVE|INITIATIVE(?:\s+ORDER)?|COMBAT\s+START)\s*:?\s*$/i.test(normalized)) {
    return { type: "INITIATIVE", parsed: {} };
  }
  return null;
}

function parseDamageTrigger(content = "") {
  const headerMatch = String(content || "").match(/^(?:DAMAGE|ATTACK)\s*:?\s*(.*)$/i);
  if (!headerMatch) {
    return null;
  }

  const payload = String(headerMatch[1] || "").trim();
  const diceMatch = payload.match(/([+-]?\d+d\d+(?:kh1|kl1)?(?:[+-]\d+)?)/i);
  if (!diceMatch) {
    return null;
  }

  const dice = String(diceMatch[1] || "").trim();
  const remainder = payload.replace(diceMatch[0], "").trim();
  const damageType = remainder ? remainder.replace(/^[,:-]\s*/, "").trim() || null : null;
  return {
    type: "DAMAGE",
    parsed: {
      dice,
      damageType
    }
  };
}

function parseLootTier(payload = "") {
  const lower = String(payload || "").toLowerCase();
  if (/\blegendary|artifact|mythic\b/.test(lower)) {
    return "legendary";
  }
  if (/\brare|epic\b/.test(lower)) {
    return "rare";
  }
  if (/\bmundane|common|basic\b/.test(lower)) {
    return "mundane";
  }
  return "standard";
}

function parseLootTrigger(content = "") {
  const match = String(content || "").match(/^(?:LOOT|TREASURE|REWARD)\s*:?\s*(.*)$/i);
  if (!match) {
    return null;
  }
  return {
    type: "LOOT",
    parsed: {
      tier: parseLootTier(match[1] || "")
    }
  };
}

function parseNewEntityTrigger(content = "") {
  const match = String(content || "").match(/^NEW_ENTITY\s*:?\s*(.*)$/i);
  if (!match) {
    return null;
  }

  const values = parseKeyValues(match[1] || "");
  const name = String(values.name || "").trim();
  const entityType = String(values.type || "").trim().toLowerCase();
  if (!name || !ENTITY_TYPES.has(entityType)) {
    return null;
  }

  return {
    type: "NEW_ENTITY",
    parsed: {
      name,
      entityType
    }
  };
}

function parseUpdateEntityTrigger(content = "") {
  const match = String(content || "").match(/^UPDATE_ENTITY\s*:?\s*(.*)$/i);
  if (!match) {
    return null;
  }

  const values = parseKeyValues(match[1] || "");
  const name = String(values.name || "").trim();
  const facts = String(values.facts || values.fact || values.body || "").trim();
  if (!name || !facts) {
    return null;
  }

  return {
    type: "UPDATE_ENTITY",
    parsed: {
      name,
      facts
    }
  };
}

function parseTriggerFromRaw(raw = "") {
  const trimmedRaw = String(raw || "").trim();
  const content = trimmedRaw.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!content) {
    return { keepInNarrative: true };
  }

  const normalizedHeader = content.split(":")[0] || content;

  const parsed =
    parseCheckTrigger(content, normalizedHeader) ||
    parseInitiativeTrigger(content) ||
    parseDamageTrigger(content) ||
    parseLootTrigger(content) ||
    parseNewEntityTrigger(content) ||
    parseUpdateEntityTrigger(content);

  if (parsed) {
    return {
      keepInNarrative: false,
      trigger: {
        type: parsed.type,
        raw: trimmedRaw,
        parsed: parsed.parsed
      }
    };
  }

  if (TRIGGERISH_PATTERN.test(content)) {
    return {
      keepInNarrative: false,
      trigger: {
        type: "UNKNOWN",
        raw: trimmedRaw,
        parsed: {}
      }
    };
  }

  return { keepInNarrative: true };
}

/**
 * Parses model output and extracts mechanical triggers in appearance order.
 * @param {string} responseText
 * @returns {{ narrative: string, triggers: Array<{type: string, raw: string, parsed: object}> }}
 */
export function parseTriggers(responseText) {
  const source = String(responseText || "");
  const bracketPattern = /\[[^\]]+\]/g;
  const triggers = [];
  const narrativeParts = [];
  let cursor = 0;

  for (const match of source.matchAll(bracketPattern)) {
    const raw = String(match[0] || "");
    const start = Number(match.index ?? 0);
    narrativeParts.push(source.slice(cursor, start));
    cursor = start + raw.length;

    const parsed = parseTriggerFromRaw(raw);
    if (parsed.keepInNarrative) {
      narrativeParts.push(raw);
      continue;
    }

    if (parsed.trigger) {
      triggers.push(parsed.trigger);
    }
  }

  narrativeParts.push(source.slice(cursor));

  return {
    narrative: normalizeWhitespace(narrativeParts.join("")),
    triggers
  };
}

function abilityKey(ability = "") {
  return String(ability || "").slice(0, 3).toLowerCase();
}

function abilityModifier(score = 10) {
  return Math.floor((Number(score || 10) - 10) / 2);
}

function findPlayerCharacter(campaignState = {}, campaignId, playerName = "") {
  const characters = Array.isArray(campaignState.characters) ? campaignState.characters : [];
  const normalizedName = String(playerName || "").trim().toLowerCase();
  const inCampaign = characters.filter((entry) => String(entry?.campaignId || "") === String(campaignId || ""));
  if (normalizedName) {
    const direct = inCampaign.find((entry) => String(entry?.name || "").trim().toLowerCase() === normalizedName);
    if (direct) {
      return direct;
    }
  }
  return inCampaign[0] || null;
}

function lootTableForTier(tier) {
  const tables = {
    mundane: ["Waterskin", "Hemp Rope", "Lantern Oil", "Iron Rations"],
    standard: ["Potion of Healing", "Silvered Dagger", "Traveler's Charm", "Spell Ink Vial"],
    rare: ["Moonsteel Buckle", "Runed Cloak Pin", "Shard of Emberglass", "Relic Compass"],
    legendary: ["Crown of Ash", "Nightglass Blade", "Starbound Sigil", "Heartforge Core"]
  };
  return tables[tier] || tables.standard;
}

/**
 * Executes parsed triggers against injected repository/rules/memory adapters.
 * @param {Array<{type: string, raw: string, parsed: object}>} triggers
 * @param {string} campaignId
 * @param {string} playerName
 * @param {object} repository
 * @param {object} rulesEngine
 * @param {object} memoryStore
 * @returns {Promise<{results: Array<object>, mechanical: {rolls: Array<object>, stateChanges: Array<object>}, memoryUpdates: string[]}>}
 */
export async function executeTriggers(triggers, campaignId, playerName, repository, rulesEngine, memoryStore) {
  const ordered = Array.isArray(triggers) ? triggers : [];
  const results = [];
  const mechanical = { rolls: [], stateChanges: [] };
  const memoryUpdates = [];

  const campaignState = repository?.getState ? repository.getState({}) : { characters: [] };
  const playerCharacter = findPlayerCharacter(campaignState, campaignId, playerName);
  const stats = playerCharacter?.stats || {};

  for (const trigger of ordered) {
    if (!trigger || typeof trigger !== "object") {
      continue;
    }

    if (trigger.type === "CHECK") {
      const ability = String(trigger.parsed?.ability || "Strength");
      const dc = clamp(trigger.parsed?.dc ?? 10, 1, 30);
      const key = abilityKey(ability);
      const modifier = abilityModifier(stats[key] ?? 10);
      const expression = `1d20${modifier >= 0 ? `+${modifier}` : modifier}`;
      const check = rulesEngine?.resolveSkillCheck
        ? rulesEngine.resolveSkillCheck({ expression, dc, label: `${ability} ${trigger.parsed?.subtype || "check"}` })
        : null;

      const entry = {
        type: "CHECK",
        ability,
        dc,
        modifier,
        roll: check?.roll || null,
        total: Number(check?.roll?.total ?? 0),
        success: Boolean(check?.success)
      };
      results.push(entry);
      mechanical.rolls.push({ ...entry, type: "check" });
      continue;
    }

    if (trigger.type === "INITIATIVE") {
      const characters = (campaignState.characters || []).filter((entry) => String(entry?.campaignId || "") === String(campaignId || ""));
      const participants = (characters.length > 0 ? characters : [{ name: playerName || "Player", stats: {} }])
        .map((entry) => {
          const dexMod = abilityModifier(entry?.stats?.dex ?? 10);
          const roll = rulesEngine?.rollDiceExpression ? rulesEngine.rollDiceExpression(`1d20${dexMod >= 0 ? `+${dexMod}` : dexMod}`) : { total: 0 };
          return {
            name: String(entry?.name || "Unknown"),
            initiative: Number(roll?.total || 0)
          };
        })
        .sort((left, right) => right.initiative - left.initiative);

      if (repository?.setCampaignRuntimeState) {
        repository.setCampaignRuntimeState(
          campaignId,
          {
            mode: "combat",
            initiativeOrder: participants,
            turnPointer: 0
          },
          { internal: true }
        );
      }

      const entry = { type: "INITIATIVE", initiativeOrder: participants };
      results.push(entry);
      mechanical.stateChanges.push({ type: "initiative_started", initiativeOrder: participants });
      continue;
    }

    if (trigger.type === "DAMAGE") {
      const dice = String(trigger.parsed?.dice || "1d4");
      let roll = null;
      let error = null;
      try {
        roll = rulesEngine?.rollDiceExpression ? rulesEngine.rollDiceExpression(dice) : { total: 0, terms: [] };
      } catch (reason) {
        error = String(reason?.message || reason);
      }

      const entry = {
        type: "DAMAGE",
        dice,
        roll,
        damageType: trigger.parsed?.damageType || null,
        total: Number(roll?.total || 0),
        error
      };
      results.push(entry);
      mechanical.rolls.push({ ...entry, type: "damage" });
      if (!error) {
        mechanical.stateChanges.push({
          type: "damage_applied",
          amount: Number(roll?.total || 0),
          damageType: trigger.parsed?.damageType || "generic"
        });
      }
      continue;
    }

    if (trigger.type === "LOOT") {
      const tier = String(trigger.parsed?.tier || "standard").toLowerCase();
      const table = lootTableForTier(tier);
      const item = table[Math.floor(Math.random() * table.length)] || table[0];
      const entry = { type: "LOOT", tier, item };
      results.push(entry);
      mechanical.stateChanges.push({ type: "loot", tier, item });
      continue;
    }

    if (trigger.type === "NEW_ENTITY") {
      const name = String(trigger.parsed?.name || "").trim();
      const entityType = String(trigger.parsed?.entityType || "lore").trim().toLowerCase();
      if (name && ENTITY_TYPES.has(entityType) && memoryStore?.upsertEntity) {
        const stored = await memoryStore.upsertEntity(campaignId, {
          name,
          type: entityType,
          tags: ["trigger-created"],
          body: `- Entity created by trigger during live play.`
        });
        if (stored?.name) {
          memoryUpdates.push(stored.name);
        }
      }
      results.push({ type: "NEW_ENTITY", name, entityType });
      continue;
    }

    if (trigger.type === "UPDATE_ENTITY") {
      const name = String(trigger.parsed?.name || "").trim();
      const facts = String(trigger.parsed?.facts || "").trim();
      if (name && facts && memoryStore?.upsertEntity) {
        const existing = memoryStore?.getEntity ? await memoryStore.getEntity(campaignId, name) : null;
        const mergedBody = [String(existing?.body || "").trim(), `- ${facts}`].filter(Boolean).join("\n\n");
        const stored = await memoryStore.upsertEntity(campaignId, {
          name,
          type: existing?.type || "lore",
          tags: existing?.tags || [],
          relations: existing?.relations || [],
          body: mergedBody
        });
        if (stored?.name) {
          memoryUpdates.push(stored.name);
        }
      }
      results.push({ type: "UPDATE_ENTITY", name, facts });
      continue;
    }

    results.push({
      type: "UNKNOWN",
      raw: trigger.raw
    });
  }

  return {
    results,
    mechanical,
    memoryUpdates: [...new Set(memoryUpdates)]
  };
}
