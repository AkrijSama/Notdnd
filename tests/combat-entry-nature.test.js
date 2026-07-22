// Finding #6 — combat-entry determinism + the SEPARATE creature-nature weapon leak.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { scrubNatureContradiction } from "../server/solo/natureAudit.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
function greyRun() {
  const run = createDefaultSoloRun({ runId: "grey_fixed", now: T(0) });
  run.worldSeed = "grey_fixed";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  run.currentLocationId = "loc_waking_mile";
  return run;
}

// ── 3.1-3.3: combat entry is DETERMINISTIC pre-model binding — lock the walked
// phrasings so a future narrowing of ATTACK_ENTRY_RE turns this net RED. (The 1-in-6
// miss was NOT REPRODUCED at this tip — see the findings doc — but a deterministic
// path deserves a deterministic lock.)
const PHRASINGS = [
  "draw my weapon and attack the limping grey", // the phrasing the walk saw miss
  "attack the limping grey",
  "strike the limping grey",
  "I attack the grey",
  "swing at the limping grey",
  "kill the limping grey"
];
for (const intent of PHRASINGS) {
  test(`combat entry is deterministic for: "${intent}"`, () => {
    const r = resolveSoloAction(greyRun(), { type: "attempt", actorId: "player", intent }, { now: T(1) });
    // ENTRY is the Finding #6 concern and is deterministic (pre-model detectAttackIntent).
    // The round-1 OUTCOME is roll-dependent, so we assert entry, not the post-round status.
    assert.equal(r.action?.enteredCombatViaIntent, true, `"${intent}" must ENTER combat (pre-model detectAttackIntent), never fall through to free narration`);
    assert.notEqual(r.attemptResult?.gateCategory, "phantom_hostile", "a committed present hostile is never refused as a phantom");
  });
}

// ── 3.4: an animal narrated wielding a MANUFACTURED WEAPON is a nature leak the scrub
// did not cover ("its fist" was caught; "a club" was not). Now closed.
function animalOnlyRun() {
  const run = greyRun();
  // Keep ONLY the animal present so animalContext (no-human gate) fires.
  const grey = Object.values(run.npcs).find((n) => n.currentLocationId === "loc_waking_mile" && (n.flags?.hostile || /grey|wolf/i.test(n.displayName || "")));
  run.npcs = grey ? { [grey.npcId]: { ...grey, currentLocationId: "loc_waking_mile", status: "present" } } : {};
  return run;
}

test("3.4: a wolf wielding a club/cudgel is scrubbed to its natural weapon", () => {
  const run = animalOnlyRun();
  const r = scrubNatureContradiction("The grey swings a club at you, raises its cudgel, and its fist connects.", run);
  assert.ok(r.scrubbed.length >= 2, "the manufactured weapons + fist are all nature violations");
  assert.doesNotMatch(r.text, /\bclub\b/i, "no club — a wolf has no hands to hold one");
  assert.doesNotMatch(r.text, /\bcudgel\b/i, "no cudgel");
  assert.doesNotMatch(r.text, /\bfist\b/i, "fist was already covered (→ forepaw/claw)");
  assert.match(r.text, /claw/i, "the weapon becomes a natural one");
});

test("3.4: the scrub does NOT touch the PLAYER's own weapon or a scene-object weapon", () => {
  const run = animalOnlyRun();
  // "your sword" is the player's (second person), never the animal's.
  const a = scrubNatureContradiction("You raise your sword as the grey circles.", run);
  assert.match(a.text, /your sword/i, "the player's weapon is not a nature violation");
  // A weapon lying in the scene (no wield verb, no his/her/its) is not attributed to the beast.
  const b = scrubNatureContradiction("A rusted axe lies in the mud near the grey.", run);
  assert.match(b.text, /rusted axe/i, "a scene-object weapon is not scrubbed onto the animal");
});
