import assert from "node:assert/strict";
import test from "node:test";
import { detectFoundObjects, auditAndCommitFoundObjects } from "../server/solo/npcCommit.js";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";

// The documented T3 crime, verbatim from the recorded transcript
// (run_a3870598): invented on a no-stakes move turn, zero committed backing,
// carried across 5 turns via conversation context. MUST flag.
const T3 =
  "At the bottom, half-buried in lichen-crusted soil, you find a rusted iron strongbox, its lid pried open and empty.";

test("T3 strongbox: the documented gap case is detected", () => {
  const found = detectFoundObjects(T3, {});
  assert.equal(found.length, 1);
  assert.equal(found[0].noun, "strongbox");
  assert.equal(found[0].label, "rusted iron strongbox");
});

test("guards: negation, figurative, scenery mass nouns, quoted speech, committed objects", () => {
  assert.deepEqual(detectFoundObjects("You search the ravine but you find nothing of value.", {}), []);
  assert.deepEqual(detectFoundObjects("You find yourself at a crossroads. You find a way through the grief.", {}), []);
  assert.deepEqual(detectFoundObjects("You find a patch of mud and thick brush under drifting mist.", {}), []);
  assert.deepEqual(detectFoundObjects('Mira grins. "If you dig there, you find a key, I promise."', {}), []);
  // Re-describing an already-committed object is not a discovery.
  assert.deepEqual(detectFoundObjects(T3, { committedTokens: new Set(["strongbox"]) }), []);
  // Non-string / empty input is safe.
  assert.deepEqual(detectFoundObjects(null, {}), []);
});

test("detection variants: adverbs, other discovery verbs, one flag per noun", () => {
  assert.equal(detectFoundObjects("Beneath the boards you finally uncover a brass locket.", {})[0].noun, "locket");
  assert.equal(detectFoundObjects("Digging deeper, you unearth an old ledger.", {})[0].noun, "ledger");
  assert.equal(detectFoundObjects("You stumble upon a hidden lever behind the shelf.", {})[0].noun, "lever");
  // Same noun twice in one narration commits once.
  const twice = detectFoundObjects("You find a small key. Later you find a rusty key on a hook.", {});
  assert.equal(twice.length, 1);
});

test("commit: the discovery becomes a real objectState on the current location with provenance", () => {
  const run = createDefaultSoloRun({ runId: "run_foundobj" });
  const committed = auditAndCommitFoundObjects(run, T3, []);
  assert.deepEqual(committed, ["rusted iron strongbox"]);
  const entry = run.locations[run.currentLocationId].flags.objectStates["found-strongbox"];
  assert.ok(entry, "objectState committed on the current location");
  assert.equal(entry.state, "discovered");
  assert.equal(entry.label, "rusted iron strongbox");
  assert.equal(entry.setBy, "found-object-auditor");
  assert.ok(Array.isArray(entry.matchTokens) && entry.matchTokens.includes("strongbox"));
  assert.ok(typeof entry.since === "string" && entry.since.length > 0, "discovered-this-turn provenance");
  // The run still validates (location.flags is free-form by contract).
  assert.equal(validateSoloRun(run).ok, true);
  // Idempotent: the next turn re-describing it commits nothing (world owns it).
  assert.deepEqual(auditAndCommitFoundObjects(run, T3, []), []);
});

test("commit guard: a player-inventory item of the same class never re-commits", () => {
  const run = createDefaultSoloRun({ runId: "run_foundobj_inv" });
  run.inventory.iron_key = { itemId: "iron_key", name: "Iron Key", quantity: 1, tags: [], flags: {} };
  assert.deepEqual(auditAndCommitFoundObjects(run, "You find a small key under the mat.", []), []);
});
