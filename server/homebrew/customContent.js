// Manually-authored custom homebrew content (no source PDF). Validates +
// sanitizes user-supplied race/class/background/subclass/feat definitions, then
// normalizes the storable shapes into the exact 5e-SRD shapes buildCharacter
// consumes — so a custom race's +2 STR applies identically to an SRD race's.
//
// All free text passes through sanitizePlayerText (the same prompt-injection /
// structure-stripping layer used for player input), so authored content can
// never smuggle GM-directed instructions into prompts.

import { ABILITIES } from "../solo/dndData.js";
import { sanitizePlayerText } from "../solo/safety.js";

export const CUSTOM_CONTENT_TYPES = ["race", "class", "background", "subclass", "feat"];

const ABILITY_SET = new Set(ABILITIES);
const HIT_DICE = new Set(["d4", "d6", "d8", "d10", "d12"]);

const NAME_MAX = 80;
const DESC_MAX = 600;
const ITEM_MAX = 80;
const LIST_MAX = 24;
const NAMED_MAX = 16;

function clean(text, max = DESC_MAX) {
  return sanitizePlayerText(text, { maxLength: max });
}

function cleanName(text) {
  return clean(text, NAME_MAX);
}

function stringList(value, max = LIST_MAX, itemMax = ITEM_MAX) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const item = clean(entry, itemMax);
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    out.push(item);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function clampInt(value, { min, max, fallback = 0 }) {
  let n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) {
    n = fallback;
  }
  if (Number.isFinite(min)) {
    n = Math.max(min, n);
  }
  if (Number.isFinite(max)) {
    n = Math.min(max, n);
  }
  return n;
}

function abilityKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return ABILITY_SET.has(key) ? key : null;
}

function abilityList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(abilityKey).filter(Boolean))].slice(0, ABILITIES.length);
}

// { ability: int } — drops unknown keys and zero values; clamps to a sane range.
function abilityBonuses(value) {
  const out = {};
  if (value && typeof value === "object") {
    for (const [rawKey, rawVal] of Object.entries(value)) {
      const key = abilityKey(rawKey);
      if (!key) {
        continue;
      }
      const n = clampInt(rawVal, { min: -5, max: 10, fallback: 0 });
      if (n !== 0) {
        out[key] = n;
      }
    }
  }
  return out;
}

// [{ name, description }] — sanitized, named entries only.
function namedList(value, max = NAMED_MAX) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const name = cleanName(entry.name);
    if (!name) {
      continue;
    }
    out.push({ name, description: clean(entry.description || "", DESC_MAX) });
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function normalizeHitDie(value) {
  const raw = String(value || "").trim().toLowerCase();
  const withPrefix = /^\d/.test(raw) ? `d${raw}` : raw;
  return HIT_DICE.has(withPrefix) ? withPrefix : "";
}

/**
 * Validates + sanitizes one custom-content definition.
 * @param {object} raw user-supplied definition (must include `type` + `name`)
 * @returns {{ ok: boolean, errors: string[], item: object|null }} item is the
 *   sanitized, storable record (without id/createdAt — the repository adds those).
 */
export function validateCustomItem(raw = {}) {
  const errors = [];
  const type = String(raw?.type || "").trim().toLowerCase();
  if (!CUSTOM_CONTENT_TYPES.includes(type)) {
    return { ok: false, errors: [`type must be one of: ${CUSTOM_CONTENT_TYPES.join(", ")}.`], item: null };
  }

  const name = cleanName(raw.name);
  if (!name) {
    errors.push("name is required.");
  }

  const item = { type, name, source: "custom" };

  if (type === "race") {
    item.abilityBonuses = abilityBonuses(raw.abilityBonuses);
    item.size = clean(raw.size, 24) || "Medium";
    item.speed = clampInt(raw.speed, { min: 0, max: 120, fallback: 30 });
    item.traits = namedList(raw.traits);
    item.languages = stringList(raw.languages);
    if (Object.keys(item.abilityBonuses).length === 0) {
      errors.push("a race needs at least one ability score increase.");
    }
  } else if (type === "class") {
    item.hitDie = normalizeHitDie(raw.hitDie);
    if (!item.hitDie) {
      errors.push("hit die must be one of d4, d6, d8, d10, d12.");
    }
    item.primaryAbility = abilityKey(raw.primaryAbility) || "strength";
    item.savingThrows = abilityList(raw.savingThrows);
    item.armorProficiencies = stringList(raw.armorProficiencies);
    item.weaponProficiencies = stringList(raw.weaponProficiencies);
    item.skillCount = clampInt(raw.skillCount, { min: 0, max: 6, fallback: 2 });
    item.skillList = stringList(raw.skillList);
    item.startingEquipment = stringList(raw.startingEquipment);
    item.features = namedList(raw.features);
  } else if (type === "background") {
    item.skillProficiencies = stringList(raw.skillProficiencies);
    item.toolProficiencies = stringList(raw.toolProficiencies);
    item.languages = stringList(raw.languages);
    item.equipment = stringList(raw.startingEquipment ?? raw.equipment);
    item.feature = {
      name: cleanName(raw.feature?.name),
      description: clean(raw.feature?.description || "", DESC_MAX)
    };
    if (!item.feature.name) {
      errors.push("a background needs a named feature.");
    }
  } else if (type === "subclass") {
    item.parentClass = cleanName(raw.parentClass);
    item.features = namedList(raw.features);
    if (!item.parentClass) {
      errors.push("a subclass needs a parent class.");
    }
    if (item.features.length === 0) {
      errors.push("a subclass needs at least one feature.");
    }
  } else if (type === "feat") {
    item.prerequisite = clean(raw.prerequisite || "", ITEM_MAX);
    item.description = clean(raw.description || "", DESC_MAX);
    item.effect = clean(raw.effect ?? raw.mechanicalEffect ?? "", DESC_MAX);
    if (!item.description) {
      errors.push("a feat needs a description.");
    }
  }

  return { ok: errors.length === 0, errors, item: errors.length === 0 ? item : null };
}

// Trait/feature objects -> single readable strings (the SRD shape stores these as
// plain strings, e.g. racialTraits/classFeatures on the built character).
function namedToStrings(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => (entry?.description ? `${entry.name}: ${entry.description}` : entry?.name))
    .filter(Boolean);
}

/**
 * Projects stored custom items into the exact SRD-shaped catalogs buildCharacter
 * resolves against — so custom content applies through the identical code path.
 * @param {object[]} items stored custom items
 * @returns {{ races: object[], classes: object[], backgrounds: object[] }}
 */
export function normalizeContentForBuild(items = []) {
  const races = [];
  const classes = [];
  const backgrounds = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "race") {
      races.push({
        name: item.name,
        abilityBonuses: item.abilityBonuses || {},
        speed: Number.isFinite(item.speed) ? item.speed : 30,
        size: item.size || "Medium",
        traits: namedToStrings(item.traits),
        source: "custom"
      });
    } else if (item.type === "class") {
      classes.push({
        name: item.name,
        hitDie: item.hitDie || "d8",
        primaryAbility: item.primaryAbility || "strength",
        savingThrows: Array.isArray(item.savingThrows) ? item.savingThrows : [],
        skillCount: Number.isFinite(item.skillCount) ? item.skillCount : 2,
        skillList: Array.isArray(item.skillList) ? item.skillList : [],
        features: namedToStrings(item.features),
        startingEquipment: Array.isArray(item.startingEquipment) ? item.startingEquipment : [],
        description: "",
        source: "custom"
      });
    } else if (item.type === "background") {
      backgrounds.push({
        name: item.name,
        skillProficiencies: Array.isArray(item.skillProficiencies) ? item.skillProficiencies : [],
        toolProficiencies: Array.isArray(item.toolProficiencies) ? item.toolProficiencies : [],
        equipment: Array.isArray(item.equipment) ? item.equipment : [],
        feature: item.feature || { name: "", description: "" },
        source: "custom"
      });
    }
  }
  return { races, classes, backgrounds };
}
