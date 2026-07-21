// WORLD-BOOK SCHEMA — the form the Babel interview discovered, formalized.
//
// A *world-book* is the USER-FACING creation artifact. Its ONE hard requirement is a
// name; every other field has a mint-capable default. `{name, vibe}` is a complete,
// playable world-book — the engine's mints fill every gap. This is the schema behind
// the "Custom World" flow (docs/design/world-book-schema.md).
//
// The world-book is DELIBERATELY more permissive than the scenario schema
// (server/campaign/scenarioSchema.js), which is the strict gate the authored loader
// runs. `validateScenario` REQUIRES fully-formed fronts (≥2 grounded beats each),
// a non-empty secrets pool, and an opening — a bar a half-answered interview cannot
// clear. So the two live at different layers:
//
//   world-book  (permissive, name-only floor)  --compileWorldBook-->  scenario  (strict)
//                       ↑ validateWorldBook                                ↑ validateScenario
//
// `compileWorldBook()` LOWERS a world-book into a scenario object that passes
// `validateScenario`, MINTING a valid default front + secret + opening + a universal
// kept-ground start area for anything the user left blank. A compiled user world then
// loads through the SAME `loadScenarioIntoRun` pipeline as an authored scenario — a
// young world is thin, never broken.
//
// REGRESSION (owner law): babel.json validates as a world-book UNCHANGED, and loads
// via the authored path untouched. babel is simply a world-book with every field
// already filled; nothing here rewrites it.
//
// Pure module — no I/O, no provider, no randomness. `idFactory`/`seed` are injected so
// compilation is deterministic and testable.

import { validateScenario, SCENARIO_SUBSTRATE_VERSION } from "./scenarioSchema.js";
import { mintChaosling, listBaseAnimals } from "./bestiary.js";

export const WORLD_BOOK_SCHEMA_VERSION = 1;

// ── DEFAULT TABLES (every field mint-capable) ────────────────────────────────

// Romance orientation mix — the default population table (romance-legacy-law.md
// §orientation, 90/6/4). A world-book may override; absent → this table.
export const DEFAULT_ORIENTATION_MIX = Object.freeze({ hetero: 90, bi: 6, homo: 4 });

// Death law default (owner ruling): a free death ends the run with an authored
// epilogue; a premium continuation is offered but never forced. Universal unless a
// world-book overrides.
export const DEFAULT_DEATH_LAW = Object.freeze({
  kind: "free-death-epilogue",
  premiumContinuation: true,
  note: "A death ends the run with an authored epilogue. Continuation past death is a premium (Ink-priced) service, never forced."
});

// The generic threat ladder (4-6 rungs). Worlds re-skin the NAMES via the interview /
// nameBanks; the base-animal + chaos-tree machinery (server/campaign/bestiary.js) does
// the mechanical work in v1. Real per-world bestiary authoring is v2 (ledgered).
export const DEFAULT_THREAT_LADDER = Object.freeze({
  wildlife: "common",
  scavenger: "common",
  raider: "uncommon (human-tier, social-capable)",
  beast: "uncommon",
  anomaly: "rare",
  apex: "very-rare"
});

// A tone-neutral fallback name bank. A drafted world overwrites these with
// world-flavored names; a thin {name,vibe} world borrows this so name mints never
// starve. Kept small on purpose — it is a floor, not content.
export const DEFAULT_NAME_BANKS = Object.freeze({
  settlements: ["Wayrest", "Fallow Ford", "Kettle Hollow", "Ashmarket", "Lowbridge", "Tern's Landing"],
  wilds: ["The Long Grass", "Blackwater Fen", "The Scarp", "Whistling Cut", "The Old Burn", "Greywood"],
  people: ["Mara", "Corin", "Odile", "Bram", "Ines", "Tobias", "Wren", "Cael"]
});

// SCALAR DEFAULTS (steel/furniture split, owner 2026-07-21). These were inline literals
// scattered through compileWorldBook — a world author could not discover them, and the
// creator flow could drift from the compiler. They are now declared HERE, once, and the
// compiler reads them, so WORLD_BOOK_SLOTS below can state every slot's default truthfully.
export const DEFAULT_ART_STYLE = "illustrated";
export const DEFAULT_TONE = "grounded";
export const DEFAULT_GENRE = "adventure";
// `services` is declared vocabulary but had NO default anywhere (a default-less slot —
// the {name,vibe}-plays law's one hole). A world with no service economy is valid: the
// floor is "no services offered", stated explicitly rather than left undefined.
export const DEFAULT_SERVICES = Object.freeze([]);

// The canonical world-book concept fields, for docs + iteration. (Not enforced as a
// closed set — extra fields pass through; this is the vocabulary, not a whitelist.)
export const WORLD_BOOK_FIELDS = Object.freeze([
  "identity", "cosmology", "poiTable", "factions", "threatLadder",
  "bestiary", "nameBanks", "orientationMix", "deathLaw", "services",
  "startArea", "fronts", "secrets"
]);

// ── small pure helpers ───────────────────────────────────────────────────────

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function push(errors, path, message) { errors.push({ path, message }); }

export function slugify(value, fallback = "world") {
  const s = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length ? s.slice(0, 40) : fallback;
}

// The name is the ONE required identity fact. Accept the creator's clean shape
// (identity.name / top-level name) AND babel's native shape (title / world.name) so
// babel validates unchanged.
export function worldBookName(wb) {
  if (!isPlainObject(wb)) return "";
  return (
    (isPlainObject(wb.identity) && isNonEmptyString(wb.identity.name) && wb.identity.name) ||
    (isNonEmptyString(wb.name) && wb.name) ||
    (isNonEmptyString(wb.title) && wb.title) ||
    (isPlainObject(wb.world) && isNonEmptyString(wb.world.name) && wb.world.name) ||
    ""
  ).toString().trim();
}

// The spark/vibe/tagline — the one free-text seed. Accept every place it can live.
export function worldBookVibe(wb) {
  if (!isPlainObject(wb)) return "";
  return (
    (isNonEmptyString(wb.vibe) && wb.vibe) ||
    (isNonEmptyString(wb.spark) && wb.spark) ||
    (isPlainObject(wb.identity) && isNonEmptyString(wb.identity.tagline) && wb.identity.tagline) ||
    (isNonEmptyString(wb.stakes) && wb.stakes) ||
    (isPlainObject(wb.world) && isNonEmptyString(wb.world.flavor) && wb.world.flavor) ||
    (isNonEmptyString(wb.cosmology) && wb.cosmology) ||
    ""
  ).toString().trim();
}

// ── VALIDATOR (permissive; name-only floor) ──────────────────────────────────

/**
 * Validate a world-book. Pure; never throws. Returns { ok, errors } (house shape).
 * The ONLY hard requirement is a name. Every other field is checked for TYPE only if
 * present — a half-built interview state is a valid world-book. babel.json passes
 * unchanged; `{name:"x", vibe:"y"}` passes.
 */
export function validateWorldBook(wb) {
  const errors = [];
  if (!isPlainObject(wb)) {
    return { ok: false, errors: [{ path: "worldBook", message: "world-book must be an object" }] };
  }
  if (!isNonEmptyString(worldBookName(wb))) {
    push(errors, "name", "a world-book requires a name (identity.name / name / title / world.name)");
  }

  // Type-only checks on optional fields (present ⇒ well-typed). Never required.
  const arrayFields = [
    ["tones", wb.tones], ["factions", wb.factions], ["fronts", wb.fronts],
    ["secrets", wb.secrets], ["cast", wb.cast],
    ["poiTable", wb.poiTable], ["pois", wb.pois]
  ];
  for (const [name, val] of arrayFields) {
    if (val !== undefined && !Array.isArray(val)) push(errors, name, `${name}, if present, must be an array`);
  }
  // fronts cap awareness (the anti-noise cap — surfaced early, enforced hard at compile).
  if (Array.isArray(wb.fronts) && wb.fronts.length > 3) {
    push(errors, "fronts", `at most 3 fronts (the anti-noise cap); got ${wb.fronts.length}`);
  }
  // locations / poiTable may be an object MAP (babel) or an array (creator drafts).
  if (wb.locations !== undefined && !isPlainObject(wb.locations) && !Array.isArray(wb.locations)) {
    push(errors, "locations", "locations, if present, must be an object map or an array");
  }
  const objectFields = [
    ["world", wb.world], ["identity", wb.identity], ["bestiary", wb.bestiary],
    ["threatLadder", wb.threatLadder], ["orientationMix", wb.orientationMix],
    ["startArea", wb.startArea], ["opening", wb.opening], ["nameBanks", wb.nameBanks],
    ["questOffers", wb.questOffers], ["quests", wb.quests]
  ];
  for (const [name, val] of objectFields) {
    if (val !== undefined && !isPlainObject(val)) push(errors, name, `${name}, if present, must be an object`);
  }
  if (wb.nameBanks !== undefined && isPlainObject(wb.nameBanks)) {
    for (const bank of ["settlements", "wilds", "people"]) {
      if (wb.nameBanks[bank] !== undefined && !Array.isArray(wb.nameBanks[bank])) {
        push(errors, `nameBanks.${bank}`, "each name bank must be an array of strings");
      }
    }
  }
  // orientationMix, if present, must be non-negative numbers.
  if (isPlainObject(wb.orientationMix)) {
    for (const [k, v] of Object.entries(wb.orientationMix)) {
      if (typeof v !== "number" || v < 0) push(errors, `orientationMix.${k}`, "orientation weights must be non-negative numbers");
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── normalization: fill mint-capable defaults ────────────────────────────────

/**
 * Return a fully-defaulted VIEW of a world-book — never mutates the input. Fills the
 * default tables (orientationMix, deathLaw, threatLadder, nameBanks, startArea) so a
 * thin `{name, vibe}` becomes a complete world-book. Idempotent on a full book (babel).
 */
export function normalizeWorldBook(wb = {}) {
  const name = worldBookName(wb) || "An Unnamed World";
  const vibe = worldBookVibe(wb);
  const identity = isPlainObject(wb.identity) ? wb.identity : {};
  const world = isPlainObject(wb.world) ? wb.world : {};
  const nameBanks = isPlainObject(wb.nameBanks) ? wb.nameBanks
    : isPlainObject(world.nameBanks) ? world.nameBanks
    : { ...DEFAULT_NAME_BANKS };
  return {
    schemaVersion: WORLD_BOOK_SCHEMA_VERSION,
    name,
    vibe,
    identity: {
      name,
      tagline: identity.tagline || vibe || "",
      era: identity.era || world.era || "",
      tone: identity.tone || world.tone || (Array.isArray(wb.tones) ? wb.tones[0] : "") || "",
      genre: identity.genre || wb.genre || ""
    },
    cosmology: isNonEmptyString(wb.cosmology) ? wb.cosmology : (world.flavor || vibe || ""),
    orientationMix: isPlainObject(wb.orientationMix) ? { ...DEFAULT_ORIENTATION_MIX, ...wb.orientationMix } : { ...DEFAULT_ORIENTATION_MIX },
    deathLaw: isPlainObject(wb.deathLaw) ? { ...DEFAULT_DEATH_LAW, ...wb.deathLaw } : { ...DEFAULT_DEATH_LAW },
    threatLadder: isPlainObject(wb.threatLadder) ? wb.threatLadder
      : isPlainObject(wb.bestiary?.threatLadder) ? wb.bestiary.threatLadder
      : { ...DEFAULT_THREAT_LADDER },
    nameBanks: {
      settlements: Array.isArray(nameBanks.settlements) && nameBanks.settlements.length ? nameBanks.settlements : [...DEFAULT_NAME_BANKS.settlements],
      wilds: Array.isArray(nameBanks.wilds) && nameBanks.wilds.length ? nameBanks.wilds : [...DEFAULT_NAME_BANKS.wilds],
      people: Array.isArray(nameBanks.people) && nameBanks.people.length ? nameBanks.people : [...DEFAULT_NAME_BANKS.people]
    },
    startArea: isPlainObject(wb.startArea) ? wb.startArea : null,
    pois: normalizePois(wb),
    factions: Array.isArray(wb.factions) ? wb.factions : [],
    fronts: Array.isArray(wb.fronts) ? wb.fronts : [],
    secrets: Array.isArray(wb.secrets) ? wb.secrets : [],
    // `services` was declared vocabulary with no default anywhere — the one hole in the
    // {name,vibe}-plays law. A world with no service economy is valid; the floor is an
    // explicit empty list, never `undefined`. Per-POI services still override locally.
    services: Array.isArray(wb.services) ? wb.services : [...DEFAULT_SERVICES]
  };
}

// POIs can arrive as babel's object map (locations), a creator `poiTable`/`pois`
// array, or nothing. Normalize to an array of {id?, name, description?, poiClass?,
// dangerLevel?, services?, connections?}.
function normalizePois(wb) {
  const raw = Array.isArray(wb.pois) ? wb.pois
    : Array.isArray(wb.poiTable) ? wb.poiTable
    : Array.isArray(wb.locations) ? wb.locations
    : isPlainObject(wb.locations) ? Object.entries(wb.locations).map(([id, l]) => ({ id, ...(isPlainObject(l) ? l : {}) }))
    : [];
  return raw.filter((p) => isPlainObject(p) && isNonEmptyString(p.name || p.id));
}

// ── kept-ground start (the UNIVERSAL anti-lost law) ──────────────────────────

// Every world gets a deliberately-clear starter zone. The description carries the
// kept-ground language the starter-zone auditor (server/solo/starterZone.js) trusts,
// and the location is tagged `poi:start-area` so the narrator's anti-lost directive
// fires for EVERY world, not just babel. This is the anti-lost law made universal.
export function keptGroundStart(book) {
  const name = book.name || "this place";
  const region = book.nameBanks?.settlements?.[0] || "a nearby settlement";
  const flavorSeed = book.identity?.tagline || book.vibe || "";
  const authored = isPlainObject(book.startArea) ? book.startArea : null;
  const description = (authored && isNonEmptyString(authored.description))
    ? authored.description
    : `The threshold of ${name}. The ground right here is quiet and kept: soft light, a clear path running plainly on toward ${region}, and everything easy to read. ${flavorSeed ? `(${flavorSeed}) ` : ""}Whatever is strange or dangerous in this world waits further in, here, on kept ground, the paths are honest and the way is plain.`;
  return {
    id: (authored && isNonEmptyString(authored.locationId)) ? authored.locationId : "start_location",
    name: (authored && isNonEmptyString(authored.name)) ? authored.name : `${name}, Threshold`,
    description,
    // poi:start-area is the contract the anti-lost auditor + directive key on.
    tags: Array.from(new Set([...(Array.isArray(authored?.tags) ? authored.tags : []), "poi:start-area", "start-area"])),
    dangerLevel: 0
  };
}

// ── COMPILE: world-book → scenario (passes validateScenario) ─────────────────

/**
 * Lower a world-book into a scenario object. The result passes `validateScenario`
 * and loads through `loadScenarioIntoRun` exactly like an authored scenario. Mints a
 * valid default front + secret + opening + kept-ground start for anything absent.
 *
 * @param {object} wb        the (raw) world-book
 * @param {object} [opts]
 * @param {() => string} [opts.idFactory]  deterministic id source (tests)
 * @param {string} [opts.scenarioId]       force the scenarioId (else derived from name)
 * @returns {{ scenario: object, validation: {ok, errors} }}
 */
// ── B1: PEOPLE + PURPOSE — every compiled world gets a cast, a quest spine, a ─────
// tier-1 starter encounter, and an essence hook, all minted DETERMINISTICALLY at
// compile time (the pure/no-provider law) from the interview-derived world-book
// fields, reusing the existing engines (mintChaosling / the cast+offer loader / the
// essence trail). This is what kills "barren" creator worlds.

// Deterministic non-negative index from a string seed (no Math.random — pure compile).
function seedIndex(str, mod) {
  let h = 0; const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return mod ? Math.abs(h) % mod : Math.abs(h);
}

// The world's tier-1 threat, minted through the chaosling compositional rule (a base-
// animal chassis + tier-1 bounded corruption) with world-flavored NAMING. The block is
// carried in scenario.bestiary.statBlocks (the loader registers it); a placement drops
// it at the first POI with an essence trail leading there — the bloodhound hook.
function mintStarterEncounter(book, start, poiIds) {
  const chassisList = listBaseAnimals();
  if (!chassisList.length) return null;
  const chassis = chassisList[seedIndex(`${book.name}|chassis`, chassisList.length)];
  const seed = slugify(book.name, "world");
  const block = mintChaosling(chassis, 1, seed);
  if (!block) return null;
  const baseDisplay = String(chassis).replace(/_/g, " ");
  // A place-flavored epithet from the wilds bank, minus any leading article so we don't
  // double it ("The The Long Grass elk" → "The Long-Grass elk").
  const wildRaw = isNonEmptyString(book.nameBanks?.wilds?.[0]) ? book.nameBanks.wilds[0].replace(/^the\s+/i, "").trim() : "";
  const creatureName = wildRaw ? `The ${wildRaw} ${baseDisplay}` : `The Corrupted ${baseDisplay}`;
  const statBlockId = `uw_${seed}_threat`;
  const statBlock = { ...block, statBlockId, name: creatureName };
  const encounterLoc = poiIds[0] || start.id;
  const placement = {
    statBlockId,
    locationRef: encounterLoc,
    reachableFrom: start.id,
    // the essence hook: a trail from the kept ground toward the encounter (only when
    // the encounter sits at a distinct, graph-connected POI — else no phantom edge).
    ...(encounterLoc !== start.id
      ? { essenceTrail: { kind: "trail", fromRef: start.id, towardRef: encounterLoc, band: "fresh", source: statBlockId } }
      : {})
  };
  return { statBlock, placement, creatureName, encounterLoc };
}

// The quest SPINE: 1 procedural MAIN (from the temptation — identity.tagline) + 2
// authored-shape SIDES (threat = the starter encounter; landmark = the first POI).
// Committed as questOffers that arrive DIEGETICALLY on acceptance (the babel pattern —
// no cold objective asserted at start); the main wires opening.questObjectiveFrom.
function mintQuestSpine(book, poiIds, locations, encounter) {
  const worldName = book.name;
  const temptation = isNonEmptyString(book.identity?.tagline) ? book.identity.tagline : (book.vibe || `what ${worldName} really is`);
  const threatName = encounter?.creatureName || "the thing that stalks the edge";
  const landmarkName = poiIds.length ? (locations[poiIds[0]]?.name || "the near landmark") : `the reach beyond ${worldName}`;
  const questOffers = {
    offer_main: { title: `The pull of ${worldName}`, summary: `Follow the pull deeper in, ${temptation}.`.slice(0, 200), kind: "delivery" },
    offer_side_threat: { title: "Cull the corruption at the edge", summary: `${threatName} has been seen near the kept ground. Put it down.`.slice(0, 200), kind: "task" },
    offer_side_landmark: { title: `Reach ${landmarkName}`, summary: `Make your way to ${landmarkName} and learn what it holds.`.slice(0, 200), kind: "task" }
  };
  return { questOffers, mainOfferId: "offer_main", offerIds: { main: "offer_main", side1: "offer_side_threat", side2: "offer_side_landmark" } };
}

// The starter CAST: 4-6 NPCs from the world's people-bank + faction dispositions, in
// keeper / trader / quest-giver / wanderer / elder roles. romanceable is stamped HERE
// (law R2: adult, not opted-out) and factionId carried — the loader honors both. The
// offer-bearing roles ride the quest spine so purpose arrives through people.
function mintStarterCast(book, start, poiIds, spine) {
  const people = Array.isArray(book.nameBanks?.people) ? book.nameBanks.people : [];
  const factions = Array.isArray(book.factions) ? book.factions : [];
  const roleCycle = [
    { role: "keeper", beat: "keeps the kept ground and reads its omens" },
    { role: "trader", beat: "trades what the threshold's travelers need" },
    { role: "quest-giver", beat: "carries word of work worth doing", offers: "main" },
    { role: "wanderer", beat: "drifted in from further out and knows a little of the danger", offers: "side1" },
    { role: "elder", beat: "remembers what this place was before", offers: "side2" }
  ];
  const count = Math.min(6, Math.max(4, people.length || 4));
  const cast = [];
  const usedIds = new Set();
  for (let i = 0; i < count; i += 1) {
    const name = isNonEmptyString(people[i]) ? people[i] : `Stranger of ${book.name} ${i + 1}`;
    let npcId = `npc_${slugify(name, `p${i}`)}`;
    while (usedIds.has(npcId)) npcId = `${npcId}x`;
    usedIds.add(npcId);
    const spec = roleCycle[i % roleCycle.length];
    const faction = factions.length ? factions[i % factions.length] : null;
    const at = i === 0 ? start.id : (poiIds[(i - 1) % Math.max(1, poiIds.length)] || start.id);
    const offerId = spec.offers && spine ? spine.offerIds[spec.offers] : null;
    cast.push({
      npcId,
      displayName: name,
      role: spec.role,
      at,
      ageClass: "adult",
      romanceable: true, // R2: adult + not opted-out, stamped at mint (loader honors it)
      ...(faction && isNonEmptyString(faction.factionId) ? { factionId: faction.factionId } : {}),
      ...(offerId ? { questOffer: offerId } : {}),
      dialogueBeats: [{ label: spec.role, text: `${name} ${spec.beat}.` }]
    });
  }
  return cast;
}

export function compileWorldBook(wb = {}, opts = {}) {
  const book = normalizeWorldBook(wb);
  let n = 0;
  const idFactory = typeof opts.idFactory === "function" ? opts.idFactory : () => `w${++n}`;
  const scenarioId = isNonEmptyString(opts.scenarioId) ? opts.scenarioId : `uw_${slugify(book.name)}`;

  // 1. Locations map — kept-ground start first, then user POIs.
  const start = keptGroundStart(book);
  const locations = {};
  locations[start.id] = {
    name: start.name, description: start.description, tags: start.tags, dangerLevel: 0
  };
  const poiIds = [];
  for (const poi of book.pois) {
    if (poi.id === start.id) { // author supplied their own start body, merge, keep the tag
      locations[start.id] = mergeStart(locations[start.id], poi);
      continue;
    }
    const id = isNonEmptyString(poi.id) ? poi.id : `loc_${slugify(poi.name, idFactory())}`;
    poiIds.push(id);
    locations[id] = compilePoi(poi, id);
  }
  // Wire the start to the first few POIs so a young world is reachable (loader
  // symmetrizes the reciprocal edges). Cap the fan-out to keep the map legible.
  if (poiIds.length) {
    locations[start.id].connectedLocationIds = Array.from(
      new Set([...(locations[start.id].connectedLocationIds || []), ...poiIds.slice(0, 4)])
    );
  }

  // 1.4. Ensure at least ONE "beyond" POI so a bare {name,vibe} world is more than a
  // threshold — the cast, the encounter, and the trail need ground past the kept zone
  // (the danger must never sit ON the kept ground — the anti-lost law).
  if (!poiIds.length) {
    const wild = isNonEmptyString(book.nameBanks?.wilds?.[0]) ? book.nameBanks.wilds[0] : `The Wilds of ${book.name}`;
    const beyondId = `loc_${slugify(wild, "beyond")}`;
    locations[beyondId] = {
      name: wild,
      description: `Past the kept ground, where ${book.name} stops being gentle. ${book.vibe || ""}`.trim(),
      tags: ["wilderness"],
      connectedLocationIds: [start.id],
      dangerLevel: 1
    };
    poiIds.push(beyondId);
    locations[start.id].connectedLocationIds = Array.from(new Set([...(locations[start.id].connectedLocationIds || []), beyondId]));
  }

  // 1.5. PEOPLE + PURPOSE (B1) — when the world-book didn't author its own cast/quests,
  // mint a starter encounter, a quest spine, and a cast that rides it. Authored content
  // always wins (never overwritten).
  const authoredCast = Array.isArray(wb.cast) && wb.cast.length > 0;
  const authoredQuests = isPlainObject(wb.questOffers) && Object.keys(wb.questOffers).length > 0;
  const encounter = authoredCast ? null : mintStarterEncounter(book, start, poiIds);
  const spine = authoredQuests ? null : mintQuestSpine(book, poiIds, locations, encounter);
  const mintedCast = authoredCast ? wb.cast : mintStarterCast(book, start, poiIds, spine);
  const mintedQuestOffers = authoredQuests ? wb.questOffers : (spine ? spine.questOffers : {});

  // 2. Fronts — honor authored fronts (cap 3); else mint one grounded default.
  const fronts = book.fronts.length
    ? book.fronts.slice(0, 3)
    : [mintDefaultFront(idFactory(), book)];
  const frontId = fronts[0]?.frontId || "front_default";

  // 3. Secrets — honor authored; else mint one tied to the (first) front.
  const secrets = book.secrets.length
    ? book.secrets
    : [mintDefaultSecret(idFactory(), frontId, book, start.id)];

  // 4. World block.
  const world = {
    name: book.name,
    tone: book.identity.tone || DEFAULT_TONE,
    variant: "user",
    flavor: book.cosmology || book.vibe || `The world of ${book.name}.`,
    artStyle: isNonEmptyString(wb.world?.artStyle) ? wb.world.artStyle : (isNonEmptyString(wb.artStyle) ? wb.artStyle : DEFAULT_ART_STYLE),
    era: book.identity.era || "",
    startingLocationName: start.name,
    startingLocationType: "",
    nameBanks: book.nameBanks
  };
  if (isPlainObject(wb.world?.artStyleOptions)) world.artStyleOptions = wb.world.artStyleOptions;

  // 5. Assemble the scenario. Concept metadata (orientationMix/deathLaw/cosmology)
  // rides `world.*` — loader-only, unvalidated-but-carried, exactly like babel's
  // nameBanks. The engine reads them; the strict scenario schema ignores them.
  world.orientationMix = book.orientationMix;
  world.deathLaw = book.deathLaw;

  const scenario = {
    substrate: SCENARIO_SUBSTRATE_VERSION,
    scenarioId,
    title: book.identity.name,
    genre: book.identity.genre || book.identity.tone || DEFAULT_GENRE,
    tones: normalizeTones(wb, book),
    stakes: book.identity.tagline || book.vibe || `Find your feet in ${book.name}.`,
    world,
    playerOrigin: isPlainObject(wb.playerOrigin) ? wb.playerOrigin : undefined,
    locations,
    opening: {
      startLocationRef: start.id,
      knownLocations: [start.id],
      situation: isNonEmptyString(wb.opening?.situation)
        ? wb.opening.situation
        : `You arrive at the threshold of ${book.name}. ${book.identity.tagline || book.vibe || ""}`.trim(),
      // The main quest arrives diegetically when the player reaches its offerer — no
      // cold objective (the babel pattern). Only wired when the spine minted one.
      ...(spine ? { questObjectiveFrom: spine.mainOfferId } : {})
    },
    cast: mintedCast,
    questOffers: mintedQuestOffers,
    quests: isPlainObject(wb.quests) ? wb.quests : {},
    factions: book.factions,
    fronts,
    secrets,
    bestiary: compileBestiary(wb, book, encounter)
  };
  if (scenario.playerOrigin === undefined) delete scenario.playerOrigin;

  return { scenario, validation: validateScenario(scenario) };
}

function normalizeTones(wb, book) {
  if (Array.isArray(wb.tones) && wb.tones.length) return wb.tones.filter(isNonEmptyString);
  const t = book.identity.tone;
  return isNonEmptyString(t) ? [t] : [DEFAULT_TONE];
}

function mergeStart(startNode, poi) {
  return {
    ...startNode,
    description: isNonEmptyString(poi.description) ? poi.description : startNode.description,
    tags: Array.from(new Set([...(startNode.tags || []), ...(Array.isArray(poi.tags) ? poi.tags : [])])),
    services: Array.isArray(poi.services) ? poi.services : startNode.services
  };
}

function compilePoi(poi, id) {
  const node = {
    name: poi.name || id,
    description: isNonEmptyString(poi.description) ? poi.description : `${poi.name || "A place"}, as yet unexplored.`,
    tags: Array.from(new Set([
      ...(Array.isArray(poi.tags) ? poi.tags : []),
      poi.poiClass ? `poi:${slugify(poi.poiClass)}` : "poi:place"
    ]))
  };
  if (Number.isFinite(poi.dangerLevel)) node.dangerLevel = Math.max(0, Math.min(4, Math.round(poi.dangerLevel)));
  if (Array.isArray(poi.services) && poi.services.length) node.services = poi.services;
  if (Array.isArray(poi.connectedLocationIds) && poi.connectedLocationIds.length) node.connectedLocationIds = poi.connectedLocationIds;
  else if (Array.isArray(poi.connections) && poi.connections.length) node.connectedLocationIds = poi.connections;
  return node;
}

// A minimal VALID opportunity front (opportunity is not a pressure kind, so it needs
// no descriptive-advancement guarantee). Two grounded beats, resolution beat_final.
export function mintDefaultFront(frontId, book) {
  const id = isNonEmptyString(frontId) ? frontId : "front_default";
  const pull = book.identity?.tagline || book.vibe || `the pull of ${book.name}`;
  return {
    frontId: id,
    kind: "opportunity",
    foreground: true,
    topology: "linear",
    title: `The First Pull`,
    agenda: `Draw the newcomer deeper into ${book.name}.`,
    revealState: "rumored",
    groundedIn: { locationRefs: ["start_location"] },
    beats: [
      {
        beatId: `${id}_b1`,
        label: "A rumor takes shape",
        telegraph: "Someone mentions there is more to this place than the quiet threshold suggests.",
        brief: `Word reaches you of ${pull}, a reason to go further in.`,
        decision: "Chase the rumor deeper in, or take your time on kept ground first.",
        trigger: { descriptive: { onCanon: { keywords: ["ask", "explore", "look", "listen", "rumor"] } } },
        payload: { fact: { text: `There is more to ${book.name} than its quiet threshold: ${pull}.`.slice(0, 280) } }
      },
      {
        beatId: `${id}_b2`,
        label: "The pull sharpens",
        telegraph: "The rumor hardens into something specific and close enough to act on.",
        brief: "What was a rumor now has a place and a shape, the world is inviting a first real choice.",
        decision: "Commit to the thread, or turn aside and let the world keep its secret a while.",
        trigger: { prescriptive: { requiresBeat: `${id}_b1`, minTurn: 8 } },
        payload: { fact: { text: `The pull of ${book.name} now has a shape you can act on.`.slice(0, 280) } }
      }
    ],
    resolution: [{ kind: "beat_final" }]
  };
}

export function mintDefaultSecret(secretId, frontRef, book, startId) {
  const id = isNonEmptyString(secretId) ? secretId : "secret_default";
  return {
    secretId: id,
    text: `${book.name} keeps its real shape just past the threshold, the quiet ground is a courtesy, not the whole truth.`.slice(0, 280),
    frontRef,
    reveal: { onLocation: startId || "start_location" }
  };
}

// ── THE SLOT REGISTRY (steel/furniture split, owner 2026-07-21) ──────────────
//
// ONE place that declares every FURNITURE slot: what it is, whether the author must
// supply it, HOW its default is produced, and WHICH engine system consumes it. This is
// the single source the creator flow, compileWorldBook, the bill-of-materials manifest
// (worldBookManifest.js), the schema test, and docs/design/steel-vs-furniture.md all read.
//
// THE LAW IT ENFORCES: no slot may be default-less. `{name, vibe}` must always compile to
// a playable world, so every slot below carries either a literal `default` or a `mint`
// strategy. `name` is the sole exception — it is the one required identity fact.
//
// `defaultKind`:
//   "required" — the author must supply it (name only)
//   "table"    — a frozen DEFAULT_* table above
//   "literal"  — a scalar constant above
//   "mint"     — synthesised at compile from the book (see `mintedBy`)
//   "empty"    — an explicit empty collection is the valid floor
export const WORLD_BOOK_SLOTS = Object.freeze([
  { path: "name", label: "World name", defaultKind: "required", default: null,
    consumer: "everything (scenario.title, world.name)", note: "the ONE hard requirement" },
  { path: "vibe", label: "Spark / tagline", defaultKind: "literal", default: "",
    consumer: "opening.situation, stakes, front/secret mint copy" },
  { path: "identity.era", label: "Era", defaultKind: "literal", default: "",
    consumer: "art pipeline wardrobe/era injection (server/ai/promptAssembly)" },
  { path: "identity.tone", label: "Tone", defaultKind: "literal", default: DEFAULT_TONE,
    consumer: "world.tone → narrator register; scenario.tones" },
  { path: "identity.genre", label: "Genre", defaultKind: "literal", default: DEFAULT_GENRE,
    consumer: "scenario.genre" },
  { path: "cosmology", label: "Cosmology / flavor", defaultKind: "mint", mintedBy: "normalizeWorldBook (falls back to vibe)",
    consumer: "world.flavor → narrator world brief" },
  { path: "poiTable", label: "Points of interest", defaultKind: "mint", mintedBy: "compileWorldBook §1.4 (mints one 'beyond' POI from nameBanks.wilds)",
    consumer: "locations map → map layout, travel, scene art" },
  { path: "startArea", label: "Start area", defaultKind: "mint", mintedBy: "keptGroundStart()",
    consumer: "opening.startLocationRef; starter-zone auditor (server/solo/starterZone.js) via the poi:start-area tag" },
  { path: "factions", label: "Factions", defaultKind: "empty", default: [],
    consumer: "reputation engine (server/solo/reputation.js); cast factionId" },
  { path: "threatLadder", label: "Threat ladder", defaultKind: "table", default: DEFAULT_THREAT_LADDER,
    consumer: "NONE — carried into scenario.bestiary.threatLadder and never read; encounter/spawn selection never consults it (DEAD SLOT, verified 2026-07-21)" },
  { path: "bestiary", label: "Bestiary", defaultKind: "mint", mintedBy: "compileBestiary() + mintStarterEncounter()",
    consumer: "combat stat blocks + placements (scenarioLoader.placeBestiaryEncounters)" },
  { path: "nameBanks", label: "Name banks", defaultKind: "table", default: DEFAULT_NAME_BANKS,
    consumer: "cast mint, POI mint, creature epithets" },
  { path: "orientationMix", label: "Orientation mix", defaultKind: "table", default: DEFAULT_ORIENTATION_MIX,
    consumer: "NONE — written to world.orientationMix; the romance path in reputation.js never consults it (DEAD SLOT, verified 2026-07-21)" },
  { path: "deathLaw", label: "Death law", defaultKind: "table", default: DEFAULT_DEATH_LAW,
    consumer: "NONE — the death epilogue is a hardcoded client table (soloSceneShell.js DEATH_LAW_EPILOGUE) keyed on scenarioId/variant, not this slot (DEAD SLOT, verified 2026-07-21)" },
  { path: "services", label: "Services", defaultKind: "empty", default: DEFAULT_SERVICES,
    consumer: "POI service affordances (per-POI `services` overrides this world floor)" },
  { path: "fronts", label: "Fronts", defaultKind: "mint", mintedBy: "mintDefaultFront()",
    consumer: "threads engine — scenarioLoader.js:527 lowers fronts → run.threads (cap 3)" },
  { path: "secrets", label: "Secrets", defaultKind: "mint", mintedBy: "mintDefaultSecret()",
    consumer: "NONE — validated by scenarioSchema.js:409-413 then discarded; scenarioLoader never reads it (DEAD SLOT, ledgered)" },
  { path: "cast", label: "Cast", defaultKind: "mint", mintedBy: "mintStarterCast()",
    consumer: "NPC roster, dialogue, romance, portraits" },
  { path: "questOffers", label: "Quest offers", defaultKind: "mint", mintedBy: "mintQuestSpine()",
    consumer: "quest engine; opening.questObjectiveFrom" },
  { path: "quests", label: "Authored quests", defaultKind: "empty", default: {},
    consumer: "quest engine (authored arcs)" },
  { path: "opening.situation", label: "Opening situation", defaultKind: "mint", mintedBy: "compileWorldBook §5 (threshold template)",
    consumer: "first narrated beat" },
  { path: "world.artStyle", label: "Art style", defaultKind: "literal", default: DEFAULT_ART_STYLE,
    consumer: "art pipeline lane selection (server/solo/artStyle.js)" },

  // ── PLANNED FURNITURE (declared by law, engine-unbuilt) ────────────────────
  // docs/ROADMAP-CANON.md §"Build sequence" LOCKS the "Law of Creating Worlds"
  // valid-world schema as: factions, figures, artifacts, power-systems, background —
  // plus per-world handbook chapters (races/classes/power-systems/bestiary/lore live in
  // the per-world book, the main manual being world-agnostic chassis only).
  // The engine consumes NONE of these yet. They are declared here so a world author
  // sees the real shape of the form (and so Babel's manifest reports its true gaps)
  // rather than discovering them by archaeology. Filling them is inert until built.
  { path: "figures", label: "Key figures", defaultKind: "planned",
    consumer: "NOT BUILT — hand-set major NPCs (romance-legacy-law.md: 'authored key figures have hand-set' attributes); today they are ordinary `cast` rows" },
  { path: "artifacts", label: "Artifacts", defaultKind: "planned",
    consumer: "NOT BUILT — notable items/relics (ROADMAP-CANON 'Law of Creating Worlds')" },
  { path: "powerSystems", label: "Power systems", defaultKind: "planned",
    consumer: "NOT BUILT — magic/tech systems; per-world book, not the chassis manual" },
  { path: "background", label: "Background / history", defaultKind: "planned",
    consumer: "NOT BUILT — deep history; `cosmology` currently absorbs the one-paragraph version" },
  { path: "handbook", label: "Handbook chapters", defaultKind: "planned",
    consumer: "NOT BUILT — per-world races/classes/bestiary/lore chapters (main manual = world-agnostic chassis only)" }
]);

// Every slot must be defaultable — the {name,vibe}-plays law in executable form.
// Returns the offending slots (empty array = law holds). The schema test asserts this.
export function defaultlessSlots() {
  return WORLD_BOOK_SLOTS.filter((s) => {
    if (s.defaultKind === "required") return false; // `name` is the declared exception
    // "planned" slots are declared-by-law but engine-unbuilt: nothing consumes them, so a
    // default would be theatre. They are exempt until their consumer ships.
    if (s.defaultKind === "planned") return false;
    if (s.defaultKind === "mint") return !isNonEmptyString(s.mintedBy);
    return s.default === undefined || s.default === null;
  });
}

// v1 bestiary: carry the threat ladder + engine ref; reuse the base-animal + chaos-tree
// machinery with world-flavored NAMING via nameBanks. Real per-world stat blocks = v2.
function compileBestiary(wb, book, encounter) {
  if (isPlainObject(wb.bestiary)) {
    return {
      version: 1,
      engine: "server/campaign/bestiary.js",
      threatLadder: isPlainObject(wb.bestiary.threatLadder) ? wb.bestiary.threatLadder : book.threatLadder,
      placements: Array.isArray(wb.bestiary.placements) ? wb.bestiary.placements : [],
      ...(isPlainObject(wb.bestiary.statBlocks) || Array.isArray(wb.bestiary.statBlocks) ? { statBlocks: wb.bestiary.statBlocks } : {}),
      ...(isNonEmptyString(wb.bestiary.doc) ? { doc: wb.bestiary.doc } : {})
    };
  }
  // v2: carry the minted tier-1 threat (statBlocks) + its placement. The loader
  // registers statBlocks into the runtime overlay so combat + placement resolve them.
  return {
    version: 1,
    engine: "server/campaign/bestiary.js",
    threatLadder: book.threatLadder,
    placements: encounter ? [encounter.placement] : [],
    ...(encounter ? { statBlocks: { [encounter.statBlock.statBlockId]: encounter.statBlock } } : {}),
    nameFlavor: book.nameBanks
  };
}
