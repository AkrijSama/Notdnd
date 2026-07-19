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
export const STARTER_ZONE_TAG = "poi:start-area";
export const STARTER_ZONE_LOCATION_IDS = new Set(["start_location", "loc_waking_mile"]);

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
  /nothing (?:looks|seems|feels) (?:the same|familiar)/i
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
