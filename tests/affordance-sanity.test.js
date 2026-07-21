import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { deriveAffordances, auditCastAffordances } from "../server/solo/affordances.js";

// U1 — AFFORDANCE SANITY. A live walk produced two broken talk chips:
//   • "Talk to Mile"  — a ROAD ("the Waking Mile") mis-read as a person.
//   • "Talk to Esk"   — an NPC who is NOT present at the scene.
// The fix: talk-class chips derive ONLY from committed PRESENT cast, with the verb
// their committed nature warrants (Talk for social cast, Face for a hostile beast),
// and a location name NEVER personifies. The affordance-sanity auditor drops any
// chip whose subject fails those gates.

// A scene fixture with FOUR subjects in scope:
//   loc "The Waking Mile"     — a committed LOCATION whose name a phantom NPC apes.
//   npc "Mile" (present)      — the personified-place phantom (must be dropped).
//   npc "Esk" (absent)        — a real NPC at ANOTHER location (must be dropped).
//   npc "Merrin" (present)    — a present social NPC (must yield a Talk chip).
//   npc "the Grey" (present)  — a present hostile beast (must yield a Face chip).
function walkFixture() {
  const run = createDefaultSoloRun({ runId: "run_aff_sanity" });
  const here = run.currentLocationId; // start_location
  const loc = run.locations[here];
  loc.name = "The Green Static, Fringe";
  loc.tags = ["zone", "wilderness"];

  // A committed ROAD in scope — the source of the "Talk to Mile" personification.
  run.locations.loc_waking_mile = {
    locationId: "loc_waking_mile",
    name: "The Waking Mile",
    description: "A worn track kept calm by Her.",
    connectedLocationIds: [here],
    state: { visited: false, discovered: true },
    memoryFactIds: [],
    tags: ["poi:start-area"],
    layoutTemplate: "road",
    flags: {}
  };

  run.npcs = {
    // Phantom personifying the road — committed present, but its name IS the place.
    npc_mile: {
      npcId: "npc_mile",
      displayName: "Waking Mile",
      role: "figure",
      currentLocationId: here,
      known: true,
      status: "alive",
      memoryFactIds: [],
      tags: [],
      flags: {}
    },
    // A genuine NPC who is NOT here (present at a different location).
    npc_esk: {
      npcId: "npc_esk",
      displayName: "Esk",
      role: "runner",
      currentLocationId: "loc_waking_mile",
      known: true,
      status: "alive",
      memoryFactIds: [],
      tags: [],
      flags: {}
    },
    // A present, social NPC — the legitimate Talk subject.
    npc_merrin: {
      npcId: "npc_merrin",
      generatedName: "Merrin",
      displayName: "Merrin",
      role: "villager",
      currentLocationId: here,
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: [],
      flags: {}
    },
    // A present, hostile BEAST — must get "Face", never "Talk".
    npc_grey: {
      npcId: "npc_grey",
      generatedName: "the Limping Grey",
      displayName: "the Limping Grey",
      role: "wolf",
      currentLocationId: here,
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: ["wolf", "beast", "corrupted"],
      flags: { hostile: true }
    }
  };
  return run;
}

const casts = (list) => list.filter((a) => a.source === "cast");

test("U1: a personified LOCATION ('the Waking Mile') never yields a talk chip", () => {
  const list = deriveAffordances(walkFixture());
  assert.ok(!list.some((a) => /waking mile|talk to mile|\bmile\b/i.test(a.label)), "no 'Talk to Mile' chip — a road is not a person");
  assert.ok(!list.some((a) => /waking mile/i.test(a.intent)), "the road never becomes a talk intent");
});

test("U1: an ABSENT NPC ('Esk') never yields a talk chip", () => {
  const list = deriveAffordances(walkFixture());
  assert.ok(!list.some((a) => /esk/i.test(a.label)), "no 'Talk to Esk' chip — Esk is not present");
});

test("U1: a PRESENT social NPC yields a Talk chip; a PRESENT beast yields Face", () => {
  const list = deriveAffordances(walkFixture());
  const talk = list.find((a) => a.label === "Talk to Merrin");
  assert.ok(talk && talk.source === "cast" && talk.intent === "Talk to Merrin.", "present social cast gets a Talk chip");
  const face = list.find((a) => /^Face /.test(a.label));
  assert.ok(face && /the Limping Grey/.test(face.label) && /^Face /.test(face.intent), "a hostile present beast gets Face, not Talk");
  // The beast is never offered a Talk chip.
  assert.ok(!list.some((a) => /Talk to (the )?Limping Grey/i.test(a.label)), "a beast is never a Talk subject");
  // Exactly the two legitimate cast chips survive the auditor (Merrin + the Grey).
  assert.equal(casts(list).length, 2, "only the two present, correctly-typed subjects survive");
});

test("U1: emitted cast chips keep the minimal shape (no internal subject metadata)", () => {
  const chips = casts(deriveAffordances(walkFixture()));
  for (const chip of chips) {
    assert.deepEqual(Object.keys(chip).sort(), ["feasibility", "intent", "label", "source"], "no subjectId/subjectName/subjectKind leaks to the payload");
  }
});

test("U1: the auditor is the single gate — it flags BOTH bad subjects directly", () => {
  const run = walkFixture();
  // Feed it raw candidates (as castCandidates would produce) and assert the auditor
  // drops the place-phantom and the absent NPC while keeping the two valid subjects.
  const candidates = [
    { label: "Talk to Waking Mile", intent: "Talk to Waking Mile.", source: "cast", feasibility: "ok", subjectId: "npc_mile", subjectName: "Waking Mile", subjectKind: "talk" },
    { label: "Talk to Esk", intent: "Talk to Esk.", source: "cast", feasibility: "ok", subjectId: "npc_esk", subjectName: "Esk", subjectKind: "talk" },
    { label: "Talk to Merrin", intent: "Talk to Merrin.", source: "cast", feasibility: "ok", subjectId: "npc_merrin", subjectName: "Merrin", subjectKind: "talk" },
    { label: "Face the Limping Grey", intent: "Face the Limping Grey.", source: "cast", feasibility: "ok", subjectId: "npc_grey", subjectName: "the Limping Grey", subjectKind: "face" }
  ];
  const kept = auditCastAffordances(run, candidates).map((c) => c.subjectId);
  assert.deepEqual(kept.sort(), ["npc_grey", "npc_merrin"], "both bad subjects flagged; both good ones kept");
});

test("U1: a beast mislabeled 'talk' is dropped, and a social NPC mislabeled 'face' is dropped", () => {
  const run = walkFixture();
  const kept = auditCastAffordances(run, [
    { label: "Talk to the Limping Grey", intent: "x", source: "cast", feasibility: "ok", subjectId: "npc_grey", subjectName: "the Limping Grey", subjectKind: "talk" },
    { label: "Face Merrin", intent: "x", source: "cast", feasibility: "ok", subjectId: "npc_merrin", subjectName: "Merrin", subjectKind: "face" }
  ]);
  assert.equal(kept.length, 0, "verb must match committed nature or the chip is dropped");
});
