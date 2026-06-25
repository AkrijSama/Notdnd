import crypto from "node:crypto";
import { generateWithProvider } from "../ai/providers.js";

// ---------------------------------------------------------------------------
// World generator. The player defines the world; the AI fills only what they
// leave blank. Goes through the provider abstraction (text) with a deterministic
// offline fallback so a coherent world is always produced — even with no key
// and in tests. Player-provided fields are authoritative and never overwritten.
// ---------------------------------------------------------------------------

export const TONE_PRESETS = [
  "dark fantasy",
  "high fantasy",
  "grimdark",
  "sword and sorcery",
  "post-apocalyptic",
  "cosmic horror",
  "steampunk",
  "mythic"
];
export const LOCATION_TYPE_PRESETS = [
  "tavern",
  "city gate",
  "wilderness",
  "dungeon",
  "port",
  "market",
  "temple",
  "ruins",
  "camp",
  "crossroads"
];
export const ART_STYLES = ["illustrated", "anime", "cinematic"];

const CORE_FIELDS = ["name", "tone", "startingLocationName", "startingLocationType", "flavor"];
const NAME_ADJ = ["Shattered", "Ashen", "Hollow", "Sunken", "Riven", "Forgotten", "Bleak", "Gilded", "Thorned", "Ember", "Drowned", "Pale"];
const NAME_NOUN = ["Realm", "Reaches", "Dominion", "Marches", "Expanse", "Wastes", "Kingdoms", "Frontier", "Vale", "Hollows"];
const LOC_ADJ = ["Ashen", "Grey", "Salt", "Black", "Iron", "Mist", "Pale", "Old", "Crooked"];
const LOC_NOUN = ["Crossroad", "Hollow", "Gate", "Harbor", "Hold", "Market", "Rest", "Reach", "Watch", "Landing"];

function isStr(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function capitalize(value) {
  const s = String(value || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function seedFrom(...parts) {
  const hash = crypto.createHash("sha256").update(parts.join("|")).digest();
  return hash.readUInt32BE(0);
}

function pick(list, seed, offset = 0) {
  return list[(seed + offset) % list.length];
}

function resolveTextProvider(explicit) {
  if (isStr(explicit)) {
    return explicit;
  }
  return String(process.env.NOTDND_WORLD_PROVIDER || process.env.NOTDND_TEXT_PROVIDER || "").trim() || "placeholder";
}

function hasBlanks(def) {
  return !CORE_FIELDS.every((field) => isStr(def[field]));
}

function buildWorldPrompt(def) {
  const known = [];
  if (isStr(def.name)) known.push(`World name: ${def.name}`);
  if (isStr(def.tone)) known.push(`Tone/setting: ${def.tone}`);
  if (isStr(def.startingLocationName)) known.push(`Starting location name: ${def.startingLocationName}`);
  if (isStr(def.startingLocationType)) known.push(`Starting location type: ${def.startingLocationType}`);
  if (isStr(def.flavor)) known.push(`World flavor: ${def.flavor}`);
  return [
    "You are designing the setting for a solo tabletop RPG world.",
    known.length ? `The player has defined: ${known.join("; ")}.` : "The player left all fields blank.",
    "Fill in any missing pieces, staying consistent with the defined ones. Return ONLY compact JSON with these keys:",
    '{"name": string, "tone": string, "flavor": string, "description": string, "startingLocationName": string, "startingLocationType": string, "startingLocationDescription": string}',
    "- description: 2-3 atmospheric sentences about the world.",
    "- startingLocationDescription: 1-2 sentences describing where the player begins."
  ].join("\n");
}

function parseWorld(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function fallbackField(def, field, seed) {
  switch (field) {
    case "name":
      return `The ${pick(NAME_ADJ, seed)} ${pick(NAME_NOUN, seed, 1)}`;
    case "tone":
      return "dark fantasy";
    case "startingLocationName":
      return `${pick(LOC_ADJ, seed, 2)} ${pick(LOC_NOUN, seed, 3)}`;
    case "startingLocationType":
      return pick(LOCATION_TYPE_PRESETS, seed, 4);
    case "flavor":
      return `A ${def.tone || "dark fantasy"} world where old powers have fallen and the roads are no longer safe.`;
    default:
      return "";
  }
}

function synthesize(def, parsed, seed) {
  const merged = {};
  for (const field of CORE_FIELDS) {
    merged[field] = isStr(def[field])
      ? def[field].trim()
      : isStr(parsed?.[field])
        ? parsed[field].trim()
        : fallbackField(def, field, seed);
  }
  merged.artStyle = ART_STYLES.includes(def.artStyle) ? def.artStyle : "illustrated";
  merged.description = isStr(parsed?.description)
    ? parsed.description.trim()
    : `${capitalize(merged.tone)} hangs over ${merged.name}. ${merged.flavor} Folk speak of ${merged.startingLocationName} as one of the last places that still offers shelter.`;
  const locationDescription = isStr(parsed?.startingLocationDescription)
    ? parsed.startingLocationDescription.trim()
    : `You begin at ${merged.startingLocationName}, a ${merged.startingLocationType} on the frayed edge of the known world.`;
  merged.startingLocation = { name: merged.startingLocationName, description: locationDescription };
  return merged;
}

/**
 * Resolves a complete world from a partial definition. Player-provided fields
 * win; blanks are filled by the AI, then by a deterministic fallback.
 * @param {object} [definition]
 * @param {{ provider?: string, fetchImpl?: typeof fetch, salt?: string, force?: boolean }} [options]
 * @returns {Promise<object>} resolved world (name, tone, flavor, description,
 *   startingLocation{name,description}, startingLocationName/Type, artStyle)
 */
export async function generateWorld(definition = {}, options = {}) {
  const def = definition && typeof definition === "object" ? definition : {};
  const seed = seedFrom(def.name || "", def.tone || "", def.flavor || "", String(options.salt || ""));
  let raw = "";
  if (hasBlanks(def) || options.force === true) {
    try {
      const result = await generateWithProvider({
        provider: resolveTextProvider(options.provider),
        type: "gm",
        prompt: buildWorldPrompt(def),
        fetchImpl: options.fetchImpl
      });
      raw = String(result?.text || "");
    } catch {
      raw = "";
    }
  }
  return synthesize(def, parseWorld(raw), seed);
}

/**
 * Regenerates a single world field while keeping all others. Used by the
 * per-field "⟳" regenerate buttons. Returns the new value for that field.
 * @param {object} definition
 * @param {string} field
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function regenerateWorldField(definition = {}, field, options = {}) {
  const def = { ...(definition || {}) };
  if (field && field !== "description" && field !== "startingLocationDescription") {
    delete def[field];
  }
  const world = await generateWorld(def, { ...options, force: true });
  if (field === "startingLocationDescription") {
    return world.startingLocation.description;
  }
  return world[field];
}
