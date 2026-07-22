// STARTER-ZONE ANTI-LOST LAW (owner ruling 2026-07-19). The Waking Mile and the
// Green Static Fringe are HER deliberately kept-clear ground: soft light, honest
// paths, orientation NEVER in doubt. The wrongness lives BEYOND the shimmer — the
// shimmer is a BOUNDARY MARKER, not a confusion field. Getting-lost / disorientation
// motifs are forbidden inside the starter zone. This module is the single source of
// truth for "is this the kept-clear zone?" (directive + auditor share it) and for the
// forbidden-vocabulary class the narration auditor flags.

// The kept-clear starter zone, by committed location id, plus the tag that marks it.
// Detection is id-OR-tag so a run that predates the tag (its location record was
// copied before the tag was authored) is still caught by id.
// STEEL/FURNITURE de-Babel (2026-07-21): `loc_waking_mile` — a Babel/Verdance POI —
// was hardcoded into this engine protection. Removed: babel.json's waking mile carries
// the `poi:start-area` tag (as does every authored start area), so the tag path now
// generalizes it. Only the generic positional id `start_location` stays as the
// pre-tag backward-compat fallback; no world-specific POI id belongs in engine steel.
export const STARTER_ZONE_TAG = "poi:start-area";
export const STARTER_ZONE_LOCATION_IDS = new Set(["start_location"]);

export function isStarterZoneLocation(location = {}) {
  if (!location || typeof location !== "object") return false;
  const id = location.locationId || location.id;
  if (id && STARTER_ZONE_LOCATION_IDS.has(id)) return true;
  const tags = Array.isArray(location.tags) ? location.tags : [];
  return tags.includes(STARTER_ZONE_TAG);
}

// The forbidden vocabulary class (owner): getting-lost / disorientation motifs.
// Phrase-level, not bare keywords, so benign daytime description does not trip it —
// and the BOUNDARY-MARKER language (shimmer, edge, threshold, honest paths, clear
// trail) is deliberately NOT matched. Calibrated so the live run_c50caf3c last turn
// ("the trees shift around you… your sense of direction unravels… the dirt track
// south is gone behind you") flags, while the Waking Mile boundary description and
// the corrected Fringe description do not.
// NOTE ON COMPLETENESS: a pattern list can never catch every disorientation phrasing
// a language model can invent — this is a fundamentally open set. Detection is therefore
// the ALARM, not the guarantee; the guarantee is the PROMPT-LEVEL directive
// (gmProvider.js — "STARTER ZONE (Her kept-clear ground): …") that prevents the motif at
// the source. The families below were added after the walk-3 slip "the path twists wrong"
// (embedded mid-sentence, so a post-hoc strip would MANGLE the prose — see the report;
// enforcement is preventive-at-prompt, not a mangling strip).
export const LOST_MOTIF_PATTERNS = [
  /\bdisorient(?:ed|ing|ation)?\b/i,
  /\bturned around\b/i,
  /\bgoing in circles\b/i,
  /\bwander(?:s|ed|ing)?\b/i,
  /\blost\b/i, // fires only inside the starter zone (the auditor gates on that)
  /sense of direction (?:unravel\w*|fail\w*|desert\w*|abandon\w*|slip\w*|dissolv\w*|leav\w*|gone)/i,
  /(?:can(?:'|no)?t|cannot|could ?n'?t) (?:tell|guess|find|keep) (?:which way|the way|where|north|your way|track of)/i,
  /(?:path|track|trail|way|road)s? (?:that )?(?:lead|leads|leading|led|go|goes|going) (?:to )?nowhere/i,
  /\bleads? (?:to )?nowhere\b/i,
  /(?:path|track|trail|way|road)s? (?:is|are|was|were) (?:now )?gone\b/i,
  /\bgone behind you\b/i,
  /(?:trail|track|path)s? (?:vanish\w*|disappear\w*|fad\w*|peter\w*|dissolv\w*)/i,
  /trees? (?:that )?(?:shift\w*|rearrang\w*|rewrit\w*|shuffl\w*|clos\w* in around|mov\w* around you)/i,
  /swallow\w* (?:by |up )?(?:the )?(?:woods|forest|trees|light|dark|whole|path|trail)/i,
  /sun (?:stays|hangs|sits|holds|remains) (?:fixed|still|put)\b/i,
  /no clear direction/i,
  /nothing (?:looks|seems|feels) (?:the same|familiar)/i,
  // walk-3 gap family: a path/way that "twists/turns/shifts wrong" — the qualifier
  // (wrong/strange/oddly/on itself/back on) is required so a legit "the path bends
  // around the hill" is NOT flagged.
  /(?:path|track|trail|way|road)s? (?:that )?(?:twist\w*|turn\w*|bend\w*|fold\w*|shift\w*|writh\w*|buckl\w*) (?:wrong|strange\w*|oddly|on itself|back on)/i,
  // losing your bearings / footing-as-orientation / your way
  /\b(?:lose|losing|lost)\s+(?:your|my|his|her|their)\s+(?:bearings|sense of (?:place|direction)|way\b)/i,
  // the ground itself becoming unreliable / unfamiliar underfoot ("gives way to
  // something unfamiliar" — allow a few words between the verb and the qualifier)
  /ground (?:that )?(?:gives?\s+way|shift\w*|tilt\w*|drop\w*|buckl\w*)[^.!?]{0,24}\b(?:unfamiliar|strange|nowhere|beneath you)/i,
  /(?:everything|the world) (?:looks|seems|feels) (?:unfamiliar|strange|wrong)/i
];

// Returns the list of lost-motif hits IF the narration is set in a starter-zone
// location; otherwise []. Log-only auditor (same severity family as goal-ignored).
export function detectStarterZoneLostMotif(narrationText, location = {}) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  if (!isStarterZoneLocation(location)) return [];
  const hits = [];
  for (const re of LOST_MOTIF_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ phrase: m[0], index: m.index });
  }
  return hits;
}
