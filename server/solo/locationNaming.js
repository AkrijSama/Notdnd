// KNOWLEDGE-HONEST LOCATION NAMES (knowledge-honesty law). A location's PROPER NAME
// is player-facing knowledge: it may be surfaced ONLY once the player has been TOLD
// it — by standing in the place (entering), by a sign, or by an NPC / VOICE / map
// that names it. Until then the surface shows a DESCRIPTOR ("a worn dirt track"),
// never the proper name.
//
// This DECOUPLES two things the engine used to conflate:
//   • GEOGRAPHIC discovery (location.state.discovered) — "you know a path leads
//     there." The babel opening marks several POIs discovered/told-of (so the exit
//     rail can name a route) WITHOUT the VOICE ever speaking their names.
//   • NAME knowledge — "you have been told what the place is CALLED."
// The scene was leaking told-of names (e.g. "The Waking Mile") as if the player
// already knew them. The name gate below rides ONLY on real name-grants, so a
// discovered-but-unnamed place renders its descriptor until a grant fires.
//
// Pure helpers: displayLocationName / isLocationNameKnown read run state and mutate
// nothing; grantLocationName performs a single additive commit on the run.

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function isStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Descriptor by committed layout template (the primary signal, authored per POI).
const TEMPLATE_DESCRIPTORS = {
  clearing: "a quiet clearing",
  road: "a worn dirt track",
  "town-approach": "the road up to a settlement",
  forest: "a stretch of close forest",
  interior: "the inside of an unfamiliar building",
  cave: "a dark opening in the rock",
  ruin: "a scatter of old ruins"
};

// Secondary signal: coarse tag/name buckets, when no template descriptor applies.
const TAG_DESCRIPTOR_RULES = [
  [/ruin|crypt|tomb|temple|dungeon|barrow/, "a scatter of old ruins"],
  [/ford|crossing|river|water|creek|marsh|coast|dock/, "a crossing at the water's edge"],
  [/forest|wood|grove|thicket|jungle|glade/, "a stretch of close forest"],
  [/town|village|city|settlement|market|frontier|hub|camp|refuge/, "the edge of a settlement"],
  [/shrine|sacred|chapel|altar|sanctuary/, "a quiet, sacred place"],
  [/road|trail|track|path|highway|bridge/, "a worn dirt track"],
  [/zone|wild|wilderness|fringe|static/, "open, unmarked wild ground"]
];

// A stable, honest stand-in label for a location whose name the player has not been
// told. Prefers an authored `descriptor` field, then the layout template, then a
// tag/name bucket, then a generic fallback. Never returns the proper name.
export function locationDescriptor(location) {
  if (!isPlainObject(location)) {
    return "an unfamiliar place";
  }
  if (isStr(location.descriptor)) {
    return location.descriptor.trim();
  }
  const template = isStr(location.layoutTemplate) ? location.layoutTemplate.trim() : "";
  if (template && TEMPLATE_DESCRIPTORS[template]) {
    return TEMPLATE_DESCRIPTORS[template];
  }
  const hay = [
    ...(Array.isArray(location.tags) ? location.tags : []),
    ...(Array.isArray(location.contentTags) ? location.contentTags : []),
    isStr(location.name) ? location.name : ""
  ]
    .join(" ")
    .toLowerCase();
  for (const [re, descriptor] of TAG_DESCRIPTOR_RULES) {
    if (re.test(hay)) {
      return descriptor;
    }
  }
  return "an unfamiliar place";
}

// True when the player has been TOLD this location's name. Two grant sources:
//   1) EXPLICIT — the locationId is recorded in run.knownLocationNames (a sign, an
//      NPC / VOICE naming it, a map read). Committed via grantLocationName.
//   2) ENTERING — the player has physically been here (location.state.visited).
//      Standing in a place IS being told where you are; movement commits visited on
//      arrival, so the entering-grant needs no extra plumbing.
// GEOGRAPHIC discovery (state.discovered) is deliberately NOT a name grant: a place
// you have merely been told EXISTS is not a place you have been told the NAME of.
export function isLocationNameKnown(run, location) {
  if (!isPlainObject(location)) {
    return false;
  }
  const id = isStr(location.locationId) ? location.locationId : null;
  const known = Array.isArray(run?.knownLocationNames) ? run.knownLocationNames : [];
  if (id && known.includes(id)) {
    return true;
  }
  return location.state?.visited === true;
}

// The name to SHOW for a location: the committed proper name once the player has
// been told it, else the descriptor. Always a non-empty string.
export function displayLocationName(run, location) {
  if (!isPlainObject(location)) {
    return "an unfamiliar place";
  }
  const proper = isStr(location.name) ? location.name.trim() : "";
  if (isLocationNameKnown(run, location)) {
    return proper || locationDescriptor(location);
  }
  return locationDescriptor(location) || proper || "an unfamiliar place";
}

// Commit a name-grant: record that the player has been told a location's name (a
// sign, an NPC / VOICE naming it, a map). Idempotent; returns true only when newly
// granted so a caller can log/narrate the first reveal. Mutates run.knownLocationNames.
export function grantLocationName(run, locationId) {
  if (!isPlainObject(run) || !isStr(locationId)) {
    return false;
  }
  if (!Array.isArray(run.knownLocationNames)) {
    run.knownLocationNames = [];
  }
  if (run.knownLocationNames.includes(locationId)) {
    return false;
  }
  run.knownLocationNames.push(locationId);
  return true;
}
