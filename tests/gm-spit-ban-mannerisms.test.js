import assert from "node:assert/strict";
import test from "node:test";
import { buildActionGmMessage } from "../server/gm/actionNarration.js";
import { detectSpitViolations, stripSpitGestures, detectRepeatedGestures, extractGestureSignatures } from "../server/gm/mannerismAudit.js";
import { NPC_MANNERISMS, pickUniqueMannerism, npcTakenMannerisms, backfillNpcMannerisms } from "../server/solo/npcIdentity.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

// spit-ban-and-mannerisms (owner law, 2026-07-11): NO SPITTING, anywhere, ever.
// The vacuum is filled by committed per-NPC mannerisms.

function contractText() {
  const run = { world: { tone: "grim" }, currentLocationId: "loc_a", locations: { loc_a: { locationId: "loc_a", name: "The Yard" } } };
  const resolved = { action: { type: "attempt" }, attemptResult: { intent: "wait", success: true, band: "automatic", checkResult: null } };
  return buildActionGmMessage(run, resolved);
}

// (1) CONTRACT BAN
test("(1) the contract bans spitting as a class (not a euphemism invitation)", () => {
  const msg = contractText();
  assert.match(msg, /no character, NPC, or player ever SPITS/i);
  assert.match(msg, /hawking, expelling\) are prohibited as a class/i);
  assert.match(msg, /convey contempt or grit through a committed mannerism/i);
});

// (2) LIVE AUDITOR — the double-spit regression (owner's described shape).
test("(2) the auditor flags a double-spit narration and strips both gestures", () => {
  const narration =
    "Garrick eyes you coldly. He spits to the side, unimpressed. \"You're late.\" " +
    "Then he spits into the dirt at your boots and turns away.";
  const spits = detectSpitViolations(narration);
  assert.equal(spits.length, 2, "both spit sentences flagged");
  const fixed = stripSpitGestures(narration);
  assert.equal(fixed.removed.length, 2);
  assert.doesNotMatch(fixed.text, /\bspit/i, "no spit survives the repair");
  assert.match(fixed.text, /You're late/, "the non-spit dialogue is preserved");
});

test("(2b) 'spite'/'despite' are NOT false positives; a lone spit still flags", () => {
  assert.equal(detectSpitViolations("She acted in spite of the danger, despite the cost.").length, 0);
  assert.equal(detectSpitViolations("The old man spat at the mention of the king.").length, 1);
});

// (3) MANNERISM MINT — curated pool, unique per run, no bodily fluids.
test("(3) the mannerism pool is curated and clean (no bodily fluids / medical tics)", () => {
  assert.ok(NPC_MANNERISMS.length >= 30, "at least 30 mannerisms");
  const blob = NPC_MANNERISMS.join(" | ").toLowerCase();
  for (const banned of ["spit", "spat", "drool", "snot", "phlegm", "twitch", "tremor", "stutter", "limp"]) {
    assert.doesNotMatch(blob, new RegExp(`\\b${banned}`), `pool must not contain "${banned}"`);
  }
  assert.equal(new Set(NPC_MANNERISMS).size, NPC_MANNERISMS.length, "pool has no duplicates");
});

test("(3) mint assigns UNIQUE mannerisms across a roster", () => {
  const run = createDefaultSoloRun({ runId: "man_unique" });
  const assigned = [];
  for (let i = 0; i < 8; i += 1) {
    const m = pickUniqueMannerism([...assigned], i * 7);
    assert.ok(!assigned.includes(m), `mannerism ${i} is unique`);
    assigned.push(m);
  }
});

test("(3d) backfill gives legacy present NPCs a mannerism, unique, once", () => {
  const run = createDefaultSoloRun({ runId: "man_backfill" });
  const mk = (id, seed) => ({ npcId: id, displayName: id, currentLocationId: run.currentLocationId, status: "alive", identitySeed: seed });
  run.npcs = { a: mk("a", 1), b: mk("b", 2), c: mk("c", 3) };
  const done = backfillNpcMannerisms(run, ["a", "b", "c"]);
  assert.deepEqual(done.sort(), ["a", "b", "c"]);
  const ms = ["a", "b", "c"].map((id) => run.npcs[id].mannerism);
  assert.ok(ms.every((m) => typeof m === "string" && m.length > 0));
  assert.equal(new Set(ms).size, 3, "backfilled mannerisms are unique");
  // idempotent: a second pass changes nothing (already set)
  assert.equal(backfillNpcMannerisms(run, ["a", "b", "c"]).length, 0);
});

// (4) REPETITION GUARD — same gesture across turns/NPCs.
test("(4) the repetition guard flags a stock gesture reused across NPCs in a session", () => {
  const turn1 = 'Marta narrows her eyes at the ledger.';
  const first = detectRepeatedGestures(turn1, []);
  assert.deepEqual(first.repeated, [], "nothing repeats on the first sighting");
  // a DIFFERENT NPC does the SAME gesture later in the session
  const turn2 = 'Soren narrows his eyes and says nothing.';
  const second = detectRepeatedGestures(turn2, first.signatures);
  assert.ok(second.repeated.includes("narrow eyes"), "the reused subject-stripped gesture is flagged");
});

test("(4) distinct gestures do not trip the guard", () => {
  const sigs = detectRepeatedGestures("She taps the table twice.", []).signatures;
  const next = detectRepeatedGestures("He folds his arms slowly.", sigs);
  assert.deepEqual(next.repeated, []);
});
