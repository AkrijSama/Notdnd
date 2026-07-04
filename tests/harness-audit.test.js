import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildRichFixtureRun,
  classifyCorpusInput,
  looksLikeQuestion,
  extractProperNouns,
  knownNamesFromScene,
  auditProseAgainstState,
  auditInventedAgents
} from "../scripts/selfplayAudit.mjs";

// The harness-audit helpers are load-bearing for the adversarial battery: the
// classifier mirrors the ENGINE's own dispatch, and the phantom auditor is the
// prose-integrity metric. Both must be stable, pure, and honest.

test("classifier mirrors the engine's dispatch on the canonical phrasings", () => {
  const run = buildRichFixtureRun();
  assert.equal(classifyCorpusInput(run, "search the ruins for anything useful"), "search");
  assert.equal(classifyCorpusInput(run, "go deeper into the ruins"), "move");
  assert.equal(classifyCorpusInput(run, "Grab the crate and sling it over my shoulder."), "take");
  assert.equal(classifyCorpusInput(run, "Yes, I'll take the job."), "accept");
  assert.equal(classifyCorpusInput(run, "attack the towering ogre with my sword"), "other");
});

test("classifier surfaces the engine's REAL claims, including the finding classes", () => {
  const run = buildRichFixtureRun();
  // FINDING: the engine claims this question as a MOVE (directional fallback).
  // The classifier must report the truth, not launder it into "question".
  assert.equal(classifyCorpusInput(run, "How deep does this ruin go? Is it lit?"), "move");
  assert.equal(looksLikeQuestion("How deep does this ruin go? Is it lit?"), true,
    "the surface flag disagrees — that disagreement IS the finding");
  // FINDING: "Ok,"-prefixed utterances near a live offer are claimed by accept.
  assert.equal(classifyCorpusInput(run, "Ok, ill be back. I take the crate and carry it towards the destination."), "accept");
  // FINDING: plural goal phrasing is NOT captured (GOAL_ESTABLISH gap).
  assert.equal(classifyCorpusInput(run, "I will make these ruins my stronghold"), "other");
  assert.equal(classifyCorpusInput(run, "I claim this place as my own and vow to rebuild it"), "goal");
});

test("compound detection: distinct mechanics across clauses", () => {
  const run = buildRichFixtureRun();
  assert.equal(classifyCorpusInput(run, "grab the crate then go deeper into the ruins"), "compound");
  assert.equal(classifyCorpusInput(run, "search the room for anything useful and pocket whatever I find"), "compound");
});

test("question flag: interrogatives and trailing question marks", () => {
  assert.equal(looksLikeQuestion("Are these tools salvageable and usable?"), true);
  assert.equal(looksLikeQuestion("what lies beyond the gate"), true);
  assert.equal(looksLikeQuestion("force the gate open"), false);
});

test("proper-noun extraction: names yes, sentence-initial furniture no", () => {
  const nouns = extractProperNouns(
    "You step into the hall. Garrick eyes you warily as the wind howls. The road to Ashfall Reach is closed, said Mara."
  );
  assert.ok(nouns.includes("Garrick"), `expected Garrick in ${JSON.stringify(nouns)}`);
  assert.ok(nouns.includes("Mara"));
  assert.ok(nouns.some((n) => n.includes("Ashfall")), "multi-token place name extracted");
  assert.ok(!nouns.includes("You"), "sentence furniture excluded");
});

test("phantom audit: state-vouched names pass, invented names flagged", () => {
  const sceneStub = {
    location: { name: "Ashfall Reach Crossing" },
    cast: [{ displayName: "A waiting figure" }],
    playerInventory: [{ name: "Trail Loaf" }],
    quests: { activeQuests: [{ title: "Deliver to The Ashfall Expanse" }] },
    availableMoves: [{ name: "The Ember Tavern" }]
  };
  const clean = auditProseAgainstState(
    "At Ashfall Reach Crossing, the waiting figure nods toward The Ember Tavern.",
    sceneStub
  );
  assert.equal(clean.phantoms.length, 0, `expected clean, got ${JSON.stringify(clean.phantoms)}`);
  const dirty = auditProseAgainstState(
    'The stranger smiles. "Seek out Lord Vexmoor at the Sunken Cathedral," says Ilse.',
    sceneStub
  );
  const names = dirty.phantoms.map((p) => p.name);
  assert.ok(names.some((n) => n.includes("Vexmoor")), `Vexmoor is a phantom: ${JSON.stringify(names)}`);
  assert.ok(names.some((n) => n.includes("Ilse")), "Ilse is a phantom NPC name");
});

test("knownNamesFromScene harvests every committed-name surface", () => {
  const names = knownNamesFromScene({
    location: { name: "The Salt Ruins", flags: { objectStates: { "the-east-wall": { label: "the east wall" } } } },
    recentDevelopment: { title: "Smoke on the horizon" },
    discoveredDetails: [{ label: "The Old Well" }],
    cast: [{ displayName: "A winded courier" }]
  });
  for (const expected of ["the salt ruins", "the east wall", "smoke on the horizon", "the old well", "a winded courier"]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
});

test("the shipped corpus fixture is well-formed and carries the known breaker inputs", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/real-player-corpus.json", import.meta.url), "utf8"));
  assert.ok(fixture.total >= 100, `corpus unexpectedly small: ${fixture.total}`);
  assert.ok(fixture.realPlayer >= 50, "real-player share present");
  const texts = fixture.entries.map((e) => e.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("i take the crate and carry it towards the destination")), "owner crash input present");
  assert.ok(texts.some((t) => t.includes("how deep does this ruin go")), "question-as-move input present");
  assert.ok(texts.some((t) => t.includes("make these ruins my stronghold")), "plural goal input present");
  for (const e of fixture.entries) {
    assert.ok(typeof e.text === "string" && e.class && typeof e.question === "boolean");
  }
});

// ── Invented-agent auditor (the class the phantom check misses) ──────────────
// The 2026-07-03 prose ladder's oss-120b cells invented a maintenance drone to
// fight (enemy, combat, loot — zero proper nouns, zero phantoms). These pin the
// auditor to that exact failure class and to its honest counterparts.

test("invented agents: an acting drone with no committed entity is flagged; a cast-vouched figure passes", () => {
  const emptyScene = { location: { name: "Night City" }, cast: [] };
  const droneFight = auditInventedAgents(
    "Your blade shatters a rusted maintenance drone's chassis. The dying drone clatters to the floor, sparks raining down.",
    emptyScene
  );
  assert.ok(droneFight.inventions.some((i) => i.kind === "agent" && i.detail === "drone"),
    `drone fight must flag: ${JSON.stringify(droneFight.inventions)}`);

  const castScene = { location: { name: "Night City" }, cast: [{ displayName: "A mysterious figure" }] };
  const vouched = auditInventedAgents("The figure steps closer, watching you without haste.", castScene);
  assert.equal(vouched.inventions.length, 0, `cast-vouched figure is not an invention: ${JSON.stringify(vouched.inventions)}`);
});

test("invented agents: negated absence and the player's own voice are honest, an answering voice is not", () => {
  const emptyScene = { location: { name: "Night City" }, cast: [] };
  const honest = auditInventedAgents(
    "Your strike connects with nothing — no figure stands before you. With your voice announced, you must decide your next move.",
    emptyScene
  );
  assert.equal(honest.inventions.length, 0, `honest no-target narration passes: ${JSON.stringify(honest.inventions)}`);

  const answering = auditInventedAgents(
    'A thin, crackling voice sputters through a dusty speaker: "Intruder — override engaged."',
    emptyScene
  );
  assert.ok(answering.inventions.some((i) => i.kind === "agent" && i.detail === "voice"), "an answering voice with no committed speaker is an invention");
  assert.ok(answering.inventions.some((i) => i.kind === "dialogue"), "dialogue with no committed speaker is flagged");
});

test("invented agents: player-voiced speech passes, pseudo-state tags always flag", () => {
  const emptyScene = { location: { name: "Night City" }, cast: [] };
  const playerSpeech = auditInventedAgents('You call out, "Hello? Anyone there?" and the echo dies against the ruins.', emptyScene);
  assert.equal(playerSpeech.inventions.filter((i) => i.kind === "dialogue").length, 0,
    `player speech is legitimate: ${JSON.stringify(playerSpeech.inventions)}`);

  const tagLeak = auditInventedAgents(
    'You spot a hidden opening. [UPDATE_ENTITY: name="The Warehouse" facts="has a scavenger nest"]',
    { location: { name: "Night City" }, cast: [{ displayName: "A scavenger" }] }
  );
  assert.ok(tagLeak.inventions.some((i) => i.kind === "state_tag"), "leaked [UPDATE_ENTITY...] tag flagged even with cast present");
});
