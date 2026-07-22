// STARTER-ZONE ANTI-LOST LAW (owner ruling 2026-07-19). The Waking Mile + the Green
// Static Fringe are HER kept-clear ground: honest paths, orientation never in doubt;
// the shimmer is a BOUNDARY MARKER, not a confusion field. Three layers proven here:
//   (a) DATA — babel.json starter-zone records carry no disorientation vocabulary.
//   (b) DIRECTIVE — the narrator contract gains the anti-lost rule for starter scenes.
//   (c) AUDITOR — the lost-motif check, calibrated against the LIVE run_c50caf3c turns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isStarterZoneLocation,
  detectStarterZoneLostMotif,
  STARTER_ZONE_TAG
} from "../server/solo/starterZone.js";
import { buildProviderPromptMessages } from "../server/solo/gmProvider.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const babel = JSON.parse(fs.readFileSync(path.join(dir, "../server/campaign/scenarios/babel.json"), "utf8"));

// ── the LIVE run_c50caf3c turns (verbatim), the ground truth for calibration ──
const TURN4 = "You push north toward the town, but the trees shift around you in ways that have nothing to do with wind. The sun stays fixed overhead through gaps that don't match the canopy you just passed. Your sense of direction unravels entirely, the dirt track south is gone behind you, replaced by mossy ground that slopes gently into deeper shadow.";
const TURN3 = "You sweep the fringe one more time. The ground yields nothing it hasn't already shown you: scattered rock, brittle lichen, the faded trace of an old game trail that leads nowhere worth following. The woods thicken into a wall of green and shadow that swallows light.";
const FRINGE = { locationId: "start_location", name: "The Green Static — Fringe", tags: ["modern arcane", "zone", "wilderness"] };
const WAKING = { locationId: "loc_waking_mile", tags: [STARTER_ZONE_TAG] };
const HEART = { locationId: "third_location", tags: ["zone", "deep"] };

// ── (a) DATA ──────────────────────────────────────────────────────────────────
test("DATA: the Green Static Fringe start description carries NO disorientation vocabulary", () => {
  const desc = babel.locations.start_location.description;
  assert.doesNotMatch(desc, /half-beat/i, "no 'half-beat wrong'");
  assert.doesNotMatch(desc, /compass needles/i, "no compass/sun navigation-confusion seed");
  assert.doesNotMatch(desc, /wrong woods/i, "the ground here is not framed as the wrong woods");
  assert.deepEqual(detectStarterZoneLostMotif(desc, FRINGE), [], "no lost-motif hits in the committed description");
  // reframed per the twist: honest ground + the shimmer as a boundary marker
  assert.match(desc, /boundary/i);
  assert.match(desc, /paths are honest|way is easy to read/i);
});

test("DATA: the start location is marked as kept-clear starter zone; the Waking Mile stays correct", () => {
  assert.ok(babel.locations.start_location.tags.includes(STARTER_ZONE_TAG), "start_location tagged poi:start-area");
  assert.ok(babel.locations.loc_waking_mile.tags.includes(STARTER_ZONE_TAG), "waking mile still tagged");
  const wm = babel.locations.loc_waking_mile.description;
  assert.match(wm, /boundary marker/i, "the shimmer is a boundary marker (unchanged, correct)");
  assert.deepEqual(detectStarterZoneLostMotif(wm, WAKING), [], "waking-mile boundary text does NOT flag");
});

test("DATA: the scene-opening template is scrubbed of starter-zone disorientation", () => {
  assert.doesNotMatch(babel.opening.situation, /wrong woods breathe/i, "situation no longer breathes the wrong woods around you");
  assert.doesNotMatch(babel.opening.authoredBeats[0], /half-beat wrong/i, "the waking beat drops 'a half-beat wrong'");
});

// ── (b) DIRECTIVE ───────────────────────────────────────────────────────────────
test("DIRECTIVE: the narrator contract gains the anti-lost rule for starter-zone scenes", () => {
  const inStarter = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: { locationId: "start_location", name: "Fringe", starterZone: true } });
  const sys = inStarter[0].content;
  assert.match(sys, /STARTER ZONE \(Her kept-clear ground\)/);
  assert.match(sys, /orientation is NEVER in doubt/i);
  assert.match(sys, /BOUNDARY MARKER, not a confusion field/i);
});

test("DIRECTIVE: non-starter scenes do NOT carry the anti-lost rule", () => {
  const beyond = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: { locationId: "third_location", name: "The Heart", starterZone: false } });
  assert.doesNotMatch(beyond[0].content, /STARTER ZONE \(Her kept-clear ground\)/);
});

// ── (c) AUDITOR — calibrated against the transcript ─────────────────────────────
test("AUDITOR: detection is id-OR-tag (a pre-tag run copy is still caught by id)", () => {
  assert.equal(isStarterZoneLocation(FRINGE), true, "start_location by id, even without the tag");
  assert.equal(isStarterZoneLocation(WAKING), true, "waking mile by tag");
  assert.equal(isStarterZoneLocation(HEART), false, "the Heart (beyond the shimmer) is not starter zone");
  assert.equal(isStarterZoneLocation({}), false);
});

test("AUDITOR: the live last turn FLAGS (true-positive) inside the starter zone", () => {
  const hits = detectStarterZoneLostMotif(TURN4, FRINGE);
  assert.ok(hits.length >= 1, "turn 4 flags");
  const phrases = hits.map((h) => h.phrase.toLowerCase()).join(" | ");
  assert.match(phrases, /sense of direction unravels/);
  assert.match(phrases, /gone behind you/);
  // the two prior turns also carried lost motifs — they flag too
  assert.ok(detectStarterZoneLostMotif(TURN3, FRINGE).length >= 1, "turn 3 (leads nowhere / swallows light) flags");
});

test("AUDITOR: the shimmer-boundary text does NOT flag (marker, not confusion)", () => {
  assert.deepEqual(detectStarterZoneLostMotif(babel.locations.loc_waking_mile.description, WAKING), [], "boundary marker is clean");
  assert.deepEqual(detectStarterZoneLostMotif(babel.locations.start_location.description, FRINGE), [], "corrected Fringe is clean");
});

test("AUDITOR: fires ONLY inside the starter zone (same lost text beyond the shimmer is ignored)", () => {
  assert.deepEqual(detectStarterZoneLostMotif(TURN4, HEART), [], "the Heart is beyond the shimmer — disorientation is allowed there");
  assert.deepEqual(detectStarterZoneLostMotif(TURN4, {}), [], "no location -> no audit");
});

// ── WALK-3 GAP FAMILY (coherence walk finding #4): "the path twists wrong" ──────
// The live T6 slip inside start_location. It matched no prior pattern AND the prompt
// directive did not forbid it. Both are now widened. Detection is the alarm; the
// directive is the preventive guarantee (a post-hoc strip would mangle — the motif is
// embedded mid-sentence: "You push through the underbrush … but the path twists wrong.").
test("AUDITOR (widened): 'the path twists wrong' flags inside the starter zone", () => {
  const T6 = "You push through the underbrush toward where you thought you heard the wolf, but the path twists wrong. A root catches your ankle and you stumble into a pocket of still air.";
  const hits = detectStarterZoneLostMotif(T6, FRINGE);
  assert.ok(hits.length > 0, "the walk-3 phrase must now flag");
  assert.match(hits[0].phrase, /twists?\s+wrong/i);
});

test("AUDITOR (widened): sibling disorientation phrasings flag", () => {
  for (const s of [
    "the way shifts wrong beneath you",
    "you lose your bearings among the trunks",
    "the ground gives way to something unfamiliar",
    "everything looks unfamiliar here"
  ]) {
    assert.ok(detectStarterZoneLostMotif(s, WAKING).length > 0, `should flag: "${s}"`);
  }
});

test("AUDITOR (widened): legitimate path description is NOT flagged (no over-fire)", () => {
  // A path bending around real geography is honest orientation, not disorientation.
  for (const s of [
    "the path bends around the hill toward the flagpole",
    "the trail turns east at the old fence and runs straight to town",
    "the way curves gently down to the stream"
  ]) {
    assert.equal(detectStarterZoneLostMotif(s, FRINGE).length, 0, `must NOT flag legit prose: "${s}"`);
  }
});

test("DIRECTIVE (preventive): the starter-zone contract now forbids the twists-wrong family", () => {
  // The directive gates on location.starterZone (gm.js surfaces the kept-clear flag).
  const msgs = buildProviderPromptMessages({ location: { locationId: "start_location", name: "The Green Static — Fringe", starterZone: true } });
  const text = JSON.stringify(msgs);
  // The preventive guarantee must name the family the auditor alarms on.
  assert.match(text, /twists, turns, shifts, or folds WRONG/i);
  assert.match(text, /losing your bearings/i);
});
