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

// ---------------------------------------------------------------------------
// Tone-aware generation. Each setting archetype carries its own name word banks
// (so a cyberpunk world gets "Neo-Kowloon", not "The Riven Hollows") and prose
// phrases (so the opening doesn't frame a sci-fi world with medieval "frayed
// edge of the known world"). Presets map the TONE_PRESETS exactly; `keywords`
// catch free-text custom tones (e.g. "Futuristic/Cyberpunk" -> cyberpunk).
// Unknown tones fall back to dark_fantasy — never a crash.
//   worldFormats placeholders: {adj} {noun} {num}
//   places: second-location (hub) suffixes;  far: far-location (climax) nouns
// ---------------------------------------------------------------------------
const TONE_ARCHETYPES = {
  dark_fantasy: {
    presets: ["dark fantasy", "grimdark"],
    keywords: ["dark", "grim", "gothic", "blight", "cursed", "ashen", "bleak"],
    worldAdj: ["Shattered", "Ashen", "Hollow", "Sunken", "Riven", "Forgotten", "Bleak", "Gilded", "Thorned", "Ember", "Drowned", "Pale"],
    worldNoun: ["Realm", "Reaches", "Dominion", "Marches", "Expanse", "Wastes", "Kingdoms", "Frontier", "Vale", "Hollows"],
    worldFormats: ["The {adj} {noun}"],
    locAdj: ["Ashen", "Grey", "Salt", "Black", "Iron", "Mist", "Pale", "Old", "Crooked"],
    locNoun: ["Crossroad", "Hollow", "Gate", "Harbor", "Hold", "Watch", "Rest", "Reach", "Landing"],
    places: ["Market", "Ruins", "Crossing", "Watch"],
    far: ["Depths", "Reach", "Verge", "Hollow", "Expanse", "Threshold", "Descent", "Brink"],
    edge: "on the frayed edge of the known world",
    wilds: "an old forest",
    descriptor: "weathered",
    refuge: "one of the last places that still offers shelter",
    flavor: "where old powers have fallen and the roads are no longer safe",
    secondDescribe: (world, place) =>
      `${place} is what ${world} clings to — guttering lamps, traded rumors, and watchful eyes under every awning.`,
    farDescribe: (world, tone) =>
      `The road gives out here, at the far edge of ${world}, where the ${tone} of this land settles thickest. Few come this far, and fewer leave unchanged.`
  },
  cosmic_horror: {
    presets: ["cosmic horror"],
    keywords: ["cosmic", "eldritch", "lovecraft", "void", "dread", "horror", "occult", "abyss", "unspeakable"],
    worldAdj: ["Drowned", "Sunless", "Whispering", "Unspoken", "Weeping", "Hollow", "Y'lethi", "Sunken", "Veiled"],
    worldNoun: ["Depths", "Maw", "Threshold", "Veil", "Abyss", "Hollows", "Expanse", "Reaches"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Drowned", "Sunless", "Whispering", "Pale", "Salt", "Weeping", "Grey"],
    locNoun: ["Wharf", "Harbor", "Threshold", "Vigil", "Hollow", "Landing", "Mooring"],
    places: ["Wharf", "Harbor", "Threshold"],
    far: ["Depths", "Maw", "Veil", "Threshold", "Abyss", "Descent", "Drowning"],
    edge: "at a thin place where the world wears through",
    wilds: "a fog-bound wood",
    descriptor: "fog-bound",
    refuge: "a threshold the dread has not yet crossed",
    flavor: "where the world is thinner than anyone admits, and something on the far side is patient",
    secondDescribe: (world, place) =>
      `${place} sits where ${world} meets dark water. The tide carries in more than ships, and the locals do not meet your eyes.`,
    farDescribe: (world, tone) =>
      `Here the edges of ${world} stop agreeing on what is real. The ${tone} runs deepest at this drowned threshold, and something on the far side is aware of you.`
  },
  post_apocalyptic: {
    presets: ["post-apocalyptic", "post apocalyptic"],
    keywords: ["apocalyp", "wasteland", "fallout", "survival", "nuclear", "ruin", "collapse", "scaveng"],
    worldAdj: ["Rust", "Ash", "Broken", "Last", "Scorched", "Bleached", "Dust", "Salvaged"],
    worldNoun: ["Wastes", "Sprawl", "Refuge", "Scrap", "Haven", "Remnants", "Reach", "Ruin"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Rust", "Ash", "Broken", "Scrap", "Dust", "Last", "Bleached"],
    locNoun: ["Haven", "Refuge", "Sprawl", "Camp", "Yard", "Outpost", "Hold"],
    places: ["Bazaar", "Scrapyard", "Market"],
    far: ["Wastes", "Sprawl", "Ruin", "Verge", "Reach", "Crater", "Remnant"],
    edge: "amid the rust and ruin of the old world",
    wilds: "the overgrown wastes",
    descriptor: "rust-eaten",
    refuge: "a rare pocket of safety in the wastes",
    flavor: "where the old world is bones and the new one is scavenged from them",
    secondDescribe: (world, place) =>
      `${place} is where what's left of ${world} comes to trade — scavenged parts, clean water, and information, all of it cheaper than trust.`,
    farDescribe: (world, tone) =>
      `The wastes of ${world} run out here, where the ${tone} that broke the world hit first and hardest. Whatever you came to find, this is where it ends.`
  },
  steampunk: {
    presets: ["steampunk"],
    keywords: ["steam", "clockwork", "victorian", "industrial", "cog", "brass", "airship"],
    worldAdj: ["Brass", "Cog", "Gilded", "Steam", "Iron", "Soot", "Clockwork", "Coal"],
    worldNoun: ["Spires", "Foundry", "Works", "District", "Reach", "Sprawl", "Heights", "Combine"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Brass", "Cog", "Soot", "Iron", "Steam", "Gilded", "Coal"],
    locNoun: ["Works", "Foundry", "District", "Yard", "Terminal", "Exchange", "Quarter"],
    places: ["Works", "Foundry", "District"],
    far: ["Works", "Foundry", "Heights", "Spire", "Combine", "Reach"],
    edge: "in the soot and clamor of the great works",
    wilds: "an overgrown industrial wood",
    descriptor: "soot-stained",
    refuge: "a warm berth amid the grinding machinery",
    flavor: "where smoke and ambition have outgrown the people who started them",
    secondDescribe: (world, place) =>
      `${place} is where ${world} keeps its gears turning — hissing valves, hawkers, and the constant tar-smell of the foundries.`,
    farDescribe: (world, tone) =>
      `Past the last rail line, ${world} thins to smoke and silence. The ${tone} that drives this land was forged out here, in works long since gone cold.`
  },
  sword_sorcery: {
    presets: ["sword and sorcery", "sword & sorcery"],
    keywords: ["sword", "sorcery", "barbarian", "pulp", "conan"],
    worldAdj: ["Shattered", "Crimson", "Serpent", "Brazen", "Savage", "Jeweled", "Forsaken", "Wild"],
    worldNoun: ["Marches", "Kingdoms", "Frontier", "Expanse", "Reaches", "Dominion", "Wilds", "Coast"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Crimson", "Serpent", "Brazen", "Iron", "Savage", "Old", "Wild"],
    locNoun: ["Crossroad", "Gate", "Bazaar", "Hold", "Landing", "Camp"],
    places: ["Crossroads", "Bazaar", "Market"],
    far: ["Reaches", "Wilds", "Frontier", "Expanse", "Verge", "Coast", "Descent"],
    edge: "on the wild marches beyond any law",
    wilds: "untamed forest",
    descriptor: "rough-hewn",
    refuge: "a rare place to rest a blade and a back",
    flavor: "where steel settles most arguments and sorcery the rest",
    secondDescribe: (world, place) =>
      `${place} is where every road in ${world} tangles together — sell-swords, opportunists, and trouble all pass through, coin in hand.`,
    farDescribe: (world, tone) =>
      `Beyond here ${world} turns to untamed wild. The ${tone} of this land runs hot and old this far out, where only the bold or the doomed go.`
  },
  high_fantasy: {
    presets: ["high fantasy"],
    keywords: ["high fantasy", "epic", "noble", "elven", "heroic"],
    worldAdj: ["Silver", "Bright", "High", "Golden", "Radiant", "Sunlit", "Argent", "Eternal"],
    worldNoun: ["Realm", "Spire", "Vale", "Sanctum", "Reaches", "Kingdoms", "Dominion", "Crowns"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Silver", "Bright", "High", "Golden", "Argent", "White", "Sunlit"],
    locNoun: ["Vale", "Spire", "Gate", "Sanctum", "Court", "Crossing", "Hold"],
    places: ["Market", "Quarter", "Court"],
    far: ["Spire", "Vale", "Sanctum", "Reaches", "Crown", "Summit", "Verge"],
    edge: "beneath the high banners of the realm",
    wilds: "old-growth forest",
    descriptor: "gleaming",
    refuge: "a bright and welcome haven for travelers",
    flavor: "where banners still fly and old promises still bind",
    secondDescribe: (world, place) =>
      `${place} is the proud heart of trade in ${world} — silk awnings, ringing coin, and heralds calling the day's news beneath the spires.`,
    farDescribe: (world, tone) =>
      `At the realm's edge, ${world} rises into high and lonely country. The ${tone} of the age gathers here, where legends are said to begin and end.`
  },
  mythic: {
    presets: ["mythic"],
    keywords: ["myth", "divine", "god", "legend", "ancient", "celestial", "pantheon"],
    worldAdj: ["Eternal", "Sacred", "Elder", "Divine", "Hallowed", "Ancient", "Sky", "Dawn"],
    worldNoun: ["Throne", "Temple", "Pantheon", "Sanctum", "Reaches", "Expanse", "Realm", "Heavens"],
    worldFormats: ["The {adj} {noun}", "{adj} {noun}"],
    locAdj: ["Sacred", "Elder", "Divine", "Hallowed", "Ancient", "Sky", "Dawn"],
    locNoun: ["Temple", "Throne", "Sanctum", "Altar", "Gate", "Spring", "Grove"],
    places: ["Temple", "Sanctum", "Pantheon"],
    far: ["Throne", "Temple", "Pantheon", "Heavens", "Summit", "Threshold"],
    edge: "where the old gods are still remembered",
    wilds: "a sacred wood",
    descriptor: "ancient",
    refuge: "a sanctuary blessed against the dark",
    flavor: "where gods still walk and their quarrels still shape the land",
    secondDescribe: (world, place) =>
      `${place} stands where the people of ${world} still bring offerings — incense, hymns, and the quiet certainty that something listens.`,
    farDescribe: (world, tone) =>
      `Here ${world} touches the threshold of the divine. The ${tone} of creation is closest at this place, where mortal roads were never meant to lead.`
  },
  cyberpunk: {
    presets: [],
    keywords: ["cyber", "punk", "neon", "tech", "future", "futurist", "sci-fi", "scifi", "science fiction", "space", "chrome", "android", "dystop", "corporate", "hacker", "matrix", "synth"],
    worldAdj: ["Chrome", "Neon", "Razor", "Synth", "Static", "Cobalt", "Halcyon", "Mirror"],
    worldNoun: ["Kowloon", "Sprawl", "Bay", "Heights", "Zone", "Grid", "Reach", "Spire", "Helix", "Verge"],
    worldFormats: ["Neo-{noun}", "District {num}", "Sector {num}", "{adj} {noun}", "The {noun}"],
    locAdj: ["Neon", "Chrome", "Razor", "Static", "Lower", "Synth"],
    locNoun: ["District", "Sector", "Strip", "Terminal", "Block", "Arcology", "Market"],
    places: ["Bazaar", "Market", "Strip"],
    far: ["Sprawl", "Sector", "Undercity", "Grid", "Verge", "Deepnet", "Zero"],
    edge: "deep in the neon-drowned sprawl",
    wilds: "a green-choked dead zone",
    descriptor: "neon-lit",
    refuge: "a rare pocket of cover off the corporate grid",
    flavor: "where the corps own the sky and everything below it is for sale",
    secondDescribe: (world, place) =>
      `${place} is ${world}'s black market — counterfeit chrome, leaked data, and street docs working under flickering neon, no questions logged.`,
    farDescribe: (world, tone) =>
      `Past the last lit sector, ${world} drops into the dark undercity. The ${tone} of this place runs rawest down here, where the grid forgets you exist.`
  }
};

const DEFAULT_TONE_KEY = "dark_fantasy";

// Maps any tone string to an archetype key. Exact preset match first, then a
// substring scan for free-text custom tones, then the safe default.
export function resolveToneKey(tone) {
  const t = String(tone || "").trim().toLowerCase();
  if (t) {
    for (const [key, arch] of Object.entries(TONE_ARCHETYPES)) {
      if (arch.presets.some((preset) => preset === t)) {
        return key;
      }
    }
    for (const [key, arch] of Object.entries(TONE_ARCHETYPES)) {
      if (arch.keywords.some((kw) => t.includes(kw))) {
        return key;
      }
    }
  }
  return DEFAULT_TONE_KEY;
}

function toneArchetype(tone) {
  return TONE_ARCHETYPES[resolveToneKey(tone)] || TONE_ARCHETYPES[DEFAULT_TONE_KEY];
}

function formatName(template, { adj, noun, num }) {
  return String(template)
    .replace(/\{adj\}/g, adj)
    .replace(/\{noun\}/g, noun)
    .replace(/\{num\}/g, String(num));
}

// Deterministic, tone-appropriate world name (e.g. dark fantasy -> "The Riven
// Hollows"; cyberpunk -> "Neo-Kowloon" / "District 7" / "Chrome Bay").
export function pickWorldName(tone, seed) {
  const arch = toneArchetype(tone);
  const format = pick(arch.worldFormats, seed, 5);
  const num = (Math.abs(Math.trunc(Number(seed) || 0)) % 90) + 7; // 7..96
  return formatName(format, {
    adj: pick(arch.worldAdj, seed, 0),
    noun: pick(arch.worldNoun, seed, 1),
    num
  });
}

// Deterministic, tone-appropriate starting-location name (adj + noun).
function pickStartLocationName(tone, seed) {
  const arch = toneArchetype(tone);
  return `${pick(arch.locAdj, seed, 2)} ${pick(arch.locNoun, seed, 3)}`;
}

// Start-location types that read as a place a player could ADOPT and develop:
// an abandoned/defensible structure or wild spot, not a busy public venue. The
// opening offers base-building only for these (see onboarding).
const BASEABLE_START_TYPES = new Set(["ruins", "camp", "wilderness", "dungeon"]);

export function isBaseableStartType(type) {
  return BASEABLE_START_TYPES.has(String(type || "").toLowerCase());
}

// The DEFAULT starting location when neither the player nor the AI specified one:
// ancient ruins set within wilderness (a forest, for fantasy tones). Grounded,
// not a vague "crossroads on the edge of the world" — and explicitly framed as a
// foothold the player can shelter in and build up into a base of their own. Kept
// genre-flexible via the archetype's `wilds` word (forest / fog-bound wood /
// overgrown wastes / green-choked dead zone …); a ruined structure in the
// wilderness is the archetype across settings.
function buildDefaultRuinStart(tone, seed) {
  const arch = toneArchetype(tone);
  const adj = pick(arch.locAdj, seed, 2);
  const wilds = isStr(arch.wilds) ? arch.wilds : "forest";
  return {
    type: "ruins",
    name: `The ${adj} Ruins`,
    description:
      `Ancient ruins stand half-swallowed by ${wilds} — fallen walls, a roofless hall, and old ` +
      `stone that has outlasted whoever raised it. The place is quiet, defensible, and unclaimed: ` +
      `a foothold you could shelter in now and, in time, rebuild into a base of your own.`
  };
}

// Second location (the stage-1 hub): "<World> <Suffix>" + a tone-matched blurb.
// Used by onboarding to replace the old hardcoded "Ashenmoor Market Square".
export function buildSecondLocation(tone, seed, worldName) {
  const arch = toneArchetype(tone);
  const suffix = pick(arch.places, seed, 7);
  const name = `${worldName} ${suffix}`;
  return { name, suffix, description: arch.secondDescribe(worldName, name) };
}

// Far location (the climax destination at the edge of the graph): tone-matched
// name + description. Replaces the old fantasy-only far-noun list.
export function buildFarLocation(tone, seed, worldName) {
  const arch = toneArchetype(tone);
  const core = String(worldName || "the world").replace(/^the\s+/i, "").trim().split(/\s+/)[0] || "Far";
  const noun = pick(arch.far, seed, 9);
  return { name: `The ${capitalize(core)} ${noun}`, description: arch.farDescribe(worldName, tone) };
}

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
  // Math.abs so negative seeds (e.g. onboarding's signed contentSeed) still
  // index in range; for positive uint32 seeds this is identical to before.
  return list[Math.abs(Math.trunc(Number(seed) || 0) + offset) % list.length];
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
  const startGiven = isStr(def.startingLocationType) || isStr(def.startingLocationName);
  return [
    "You are designing the setting for a solo tabletop RPG world.",
    known.length ? `The player has defined: ${known.join("; ")}.` : "The player left all fields blank.",
    "Fill in any missing pieces, staying consistent with the defined ones. Return ONLY compact JSON with these keys:",
    '{"name": string, "tone": string, "flavor": string, "description": string, "startingLocationName": string, "startingLocationType": string, "startingLocationDescription": string}',
    "- description: 2-3 atmospheric sentences about the world.",
    "- startingLocationDescription: 1-2 sentences describing where the player begins.",
    // Default-start directive: when the player didn't pick a starting place, put
    // them in abandoned ruins set within wilderness (a forest, for fantasy) that
    // they can adopt as a base — NOT a crossroads/edge-of-the-world non-place.
    startGiven
      ? "- Keep the starting location consistent with what the player specified."
      : '- The player did not choose a starting location. Default to ABANDONED RUINS set within wilderness (a forest, for fantasy tones): set startingLocationType to "ruins" and make startingLocationDescription ground the player in the wilderness ruins AND note they could shelter there and build it up into a base of their own.'
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
      return pickWorldName(def.tone, seed);
    case "tone":
      return "dark fantasy";
    case "startingLocationName":
      return pickStartLocationName(def.tone, seed);
    case "startingLocationType":
      return pick(LOCATION_TYPE_PRESETS, seed, 4);
    case "flavor":
      return `A ${def.tone || "dark fantasy"} world ${toneArchetype(def.tone).flavor}.`;
    default:
      return "";
  }
}

// Offline fallback prose. Several seed-selected variants per field so the
// per-field "⟳" regenerate buttons actually change the text even with no AI
// provider — without variants, the template was byte-identical every call and
// the buttons looked dead. Flavor stays its own sentence to avoid grammar gaps.
// m.refugePhrase / m.edgePhrase / m.descriptor are tone-derived (see synthesize),
// so a cyberpunk world reads "deep in the neon-drowned sprawl", not a medieval
// "frayed edge of the known world". refugePhrase is a noun phrase usable after
// "as", "endures as", "remains", "is".
const DESCRIPTION_TEMPLATES = [
  (m) => `${capitalize(m.tone)} hangs over ${m.name}. ${m.flavor} Folk speak of ${m.startingLocationName} as ${m.refugePhrase}.`,
  (m) => `${m.name} is a ${m.tone} world. ${m.flavor} ${capitalize(m.startingLocationName)} endures as ${m.refugePhrase}.`,
  (m) => `Across ${m.name}, a ${m.tone} mood settles deep. ${m.flavor} Many drift toward ${m.startingLocationName}, ${m.refugePhrase}.`,
  (m) => `In ${m.name}, the ${m.tone} years have left their mark. ${m.flavor} ${capitalize(m.startingLocationName)} remains ${m.refugePhrase}.`,
  (m) => `${capitalize(m.tone)} runs through every corner of ${m.name}. ${m.flavor} Travelers whisper that ${m.startingLocationName} is ${m.refugePhrase}.`
];

const LOCATION_TEMPLATES = [
  (m) => `You begin at ${m.startingLocationName}, a ${m.startingLocationType} ${m.edgePhrase}.`,
  (m) => `Your story opens in ${m.startingLocationName}, a ${m.startingLocationType} where few questions are asked.`,
  (m) => `${capitalize(m.startingLocationName)} — a ${m.descriptor} ${m.startingLocationType} — is where you start.`,
  (m) => `You arrive at ${m.startingLocationName}, a ${m.descriptor} ${m.startingLocationType} ${m.edgePhrase}.`,
  (m) => `It starts at ${m.startingLocationName}, a ${m.startingLocationType} ${m.edgePhrase}.`
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
  // Did the player or the AI actually name a starting location? When NEITHER
  // did, we apply the cohesive forest-ruins DEFAULT below instead of a random
  // location type (which produced the ambiguous "crossroads" start).
  const startTypeGiven = isStr(def.startingLocationType) || isStr(parsed?.startingLocationType);
  const startNameGiven = isStr(def.startingLocationName) || isStr(parsed?.startingLocationName);
  const startDescGiven = isStr(parsed?.startingLocationDescription);
  const startUnspecified = !startTypeGiven && !startNameGiven;
  for (const field of CORE_FIELDS) {
    merged[field] = isStr(def[field])
      ? def[field].trim()
      : isStr(parsed?.[field])
        ? parsed[field].trim()
        : fallbackField(def, field, seed);
  }
  // Default start = forest ruins usable as a base. Applied only when the start
  // was left fully open (player + AI both silent); any explicit type/name wins.
  const defaultStart = buildDefaultRuinStart(merged.tone, seed);
  if (!startTypeGiven) {
    merged.startingLocationType = defaultStart.type;
  }
  if (!startNameGiven) {
    merged.startingLocationName = defaultStart.name;
  }
  merged.artStyle = ART_STYLES.includes(def.artStyle) ? def.artStyle : "illustrated";
  // Tone-derived prose phrases for the fallback templates (keyed off the
  // resolved tone, so they fit the setting even for free-text custom tones).
  const arch = toneArchetype(merged.tone);
  merged.edgePhrase = arch.edge;
  merged.descriptor = arch.descriptor;
  merged.refugePhrase = arch.refuge;
  merged.description = isStr(parsed?.description)
    ? parsed.description.trim()
    : fallbackDescription(merged, seed);
  const locationDescription = startDescGiven
    ? parsed.startingLocationDescription.trim()
    : startUnspecified
      ? defaultStart.description
      : fallbackLocationDescription(merged, seed);
  merged.startingLocation = { name: merged.startingLocationName, description: locationDescription };
  // Whether the resolved start reads as an adoptable base (ruins/abandoned in
  // the wilds). The opening offers base-building only when this is true.
  merged.startIsBaseable = isBaseableStartType(merged.startingLocationType);
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
