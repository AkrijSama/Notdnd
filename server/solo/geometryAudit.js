// GEOMETRY AUDITOR (B3) — the narrated-state-drift family, for the minted layout. The
// layout directive (layout.buildLayoutDirective) commits the scene's geometry — which
// structural kinds stand where — and closes with "never contradict these positions or
// invent new geometry." This auditor flags a narration that claims a built structure
// (a door, a gate, stone walls, a pond) the committed template does NOT have. Log-only,
// same idiom as detectStarterZoneLostMotif / detectFabricatedCombatNumbers.
//
// FIGURATIVE GUARD (the starterZone precedent — phrase-level, never bare keyword): a
// "wall of rain", a "door to freedom", "death's door" are not geometry claims and must
// never flag. Only a CONCRETE built structure contradicting the committed kind set does.
import { resolveLocationLayout } from "./layout.js";

// Figurative uses that must NOT flag.
const FIGURATIVE_WALL = /\bwalls?\s+of\s+(?:rain|fog|mist|sound|noise|silence|fire|flame|flames|water|heat|smoke|ice|wind|dust|shadow|shadows|darkness|light|muscle|flesh|people|bodies|text|worry|grief|pain|green|leaves|thorns|glass)\b/i;
const FIGURATIVE_DOOR = /\b(?:door|doorway|gate|gateway)s?\s+(?:to|of|into)\s+(?:opportunity|freedom|the\s+past|the\s+future|hope|hell|heaven|salvation|escape|possibility|memory|perception|understanding|no\s+return|another\s+world|the\s+soul|his|her|their|my|your)\b|\bdeath'?s\s+door\b|\bclosed\s+the\s+door\s+on\b|\bopen[- ]door\s+policy\b/i;

// Concrete built-structure claims.
const DOOR_RE = /\b(?:a|the|through the|past the|open(?:ed)? the|behind the|a wooden|an iron|a heavy)\s+(?:door|doorway)\b/i;
const GATE_RE = /\b(?:a|the|through the|past the|open(?:ed)? the|behind the)\s+(?:gate|gateway|portcullis)\b/i;
const BUILT_WALL_RE = /\b(?:stone|brick|timber|wooden|plaster|concrete|mud[- ]brick|earthen|log|panelled|panel)\s+walls?\b|\bthe\s+walls\s+of\s+(?:the|this)\s+(?:room|chamber|hall|cell|hut|cabin|building|house|shop|tavern|store)\b/i;
const WATER_RE = /\b(?:a|the)\s+(?:pond|pool|reservoir|cistern|still\s+water|dark\s+water|black\s+water)\b/i;

const first = (text, re) => { const m = text.match(re); return m ? m[0].trim() : null; };

/**
 * Flag narration that contradicts the committed layout's structure set. Returns
 * [{ kind, phrase }] (empty when clean, no location, or no layout). Never throws.
 */
export function detectGeometryContradiction(narrationText, run) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  const locId = run?.currentLocationId;
  if (typeof locId !== "string" || !locId) return [];
  const layout = resolveLocationLayout(run, locId);
  if (!layout || !Array.isArray(layout.cells)) return [];
  const kinds = new Set(layout.cells.map((c) => c && c.kind));
  const hits = [];

  // A built door only exists in an `interior` layout; a narrated door anywhere the
  // template commits none is invented geometry (guarding figurative "door to X").
  if (!kinds.has("door") && DOOR_RE.test(text) && !FIGURATIVE_DOOR.test(text)) {
    hits.push({ kind: "door", phrase: first(text, DOOR_RE) });
  }
  // A gate only exists in a `town-approach` layout.
  if (!kinds.has("gate") && GATE_RE.test(text) && !FIGURATIVE_DOOR.test(text)) {
    hits.push({ kind: "gate", phrase: first(text, GATE_RE) });
  }
  // Built walls exist in interior/town-approach/ruin (`wall` cells) and as the cave's
  // stone throat. Forest/clearing/road scatter a few `rock` cells (pebbles, not walls),
  // so key the exclusion on the CAVE template, not the rock kind — an open template
  // commits no walls → a "stone wall" there is invented.
  if (!kinds.has("wall") && layout.templateId !== "cave" && BUILT_WALL_RE.test(text) && !FIGURATIVE_WALL.test(text)) {
    hits.push({ kind: "wall", phrase: first(text, BUILT_WALL_RE) });
  }
  // Open water only stands in a `cave` (the pond). Elsewhere a pond is invented.
  if (!kinds.has("water") && WATER_RE.test(text)) {
    hits.push({ kind: "water", phrase: first(text, WATER_RE) });
  }
  return hits;
}
