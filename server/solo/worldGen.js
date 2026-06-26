import crypto from "node:crypto";
import { generateWithProvider } from "../ai/providers.js";
import { sanitizePlayerText } from "./safety.js";

// Player-supplied world fields that flow into the AI prompt (and into stored
// world state). Sanitized at generateWorld's entry so injection-shaped text
// never reaches the model; clean names/tone/flavor pass through unchanged.
const PLAYER_WORLD_FIELDS = ["name", "tone", "flavor", "startingLocationName", "startingLocationType"];

function sanitizeWorldDef(definition) {
  const src = definition && typeof definition === "object" ? definition : {};
  const out = { ...src };
  for (const field of PLAYER_WORLD_FIELDS) {
    if (typeof src[field] === "string") {
      out[field] = sanitizePlayerText(src[field], { maxLength: 200 });
    }
  }
  return out;
}

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

// Offline fallback prose. Several seed-selected variants per field so the
// per-field "⟳" regenerate buttons actually change the text even with no AI
// provider — without variants, the template was byte-identical every call and
// the buttons looked dead. Flavor stays its own sentence to avoid grammar gaps.
const DESCRIPTION_TEMPLATES = [
  (m) => `${capitalize(m.tone)} hangs over ${m.name}. ${m.flavor} Folk speak of ${m.startingLocationName} as one of the last places that still offers shelter.`,
  (m) => `${m.name} is a ${m.tone} world. ${m.flavor} ${capitalize(m.startingLocationName)} endures as one of the few refuges left.`,
  (m) => `Across ${m.name}, a ${m.tone} mood settles deep. ${m.flavor} Many drift toward ${m.startingLocationName}, where shelter can still be found.`,
  (m) => `In ${m.name}, the ${m.tone} years have left their mark. ${m.flavor} ${capitalize(m.startingLocationName)} remains a place the desperate still seek out.`,
  (m) => `${capitalize(m.tone)} runs through every corner of ${m.name}. ${m.flavor} Travelers whisper that ${m.startingLocationName} is where the weary still find an open door.`
];

const LOCATION_TEMPLATES = [
  (m) => `You begin at ${m.startingLocationName}, a ${m.startingLocationType} on the frayed edge of the known world.`,
  (m) => `Your story opens in ${m.startingLocationName}, a ${m.startingLocationType} where few questions are asked.`,
  (m) => `${capitalize(m.startingLocationName)} — a ${m.startingLocationType} clinging to the margins — is where you start.`,
  (m) => `You arrive at ${m.startingLocationName}, a weathered ${m.startingLocationType} that has seen better days.`,
  (m) => `It starts at ${m.startingLocationName}, a ${m.startingLocationType} half-forgotten by the wider world.`
];

function fallbackDescription(merged, seed) {
  return pick(DESCRIPTION_TEMPLATES, seed, 0)(merged);
}

function fallbackLocationDescription(merged, seed) {
  // Offset so location prose doesn't always move in lockstep with description.
  return pick(LOCATION_TEMPLATES, seed, 3)(merged);
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
    : fallbackDescription(merged, seed);
  const locationDescription = isStr(parsed?.startingLocationDescription)
    ? parsed.startingLocationDescription.trim()
    : fallbackLocationDescription(merged, seed);
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
  const def = sanitizeWorldDef(definition);
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
