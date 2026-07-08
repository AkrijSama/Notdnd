import test from "node:test";
import assert from "node:assert/strict";

import {
  commitNarratedNpc,
  detectPhantomNpcNames,
  auditAndCommitNarratedNpcs,
  detectPhantomLoreNames,
  commitNarratedLoreFact,
  auditAndCommitNarratedLore
} from "../server/solo/npcCommit.js";
import { evaluatePhantomEntities, evaluateGmNarration } from "../server/solo/gmEval.js";
import { validateNpc, createDefaultSoloRun } from "../server/solo/schema.js";

const seq = () => {
  let n = 0;
  return () => `id${++n}`;
};

test("commitNarratedNpc commits a schema-valid NPC record", () => {
  const run = createDefaultSoloRun();
  const npc = commitNarratedNpc(run, { displayName: "Grace", role: "healer" }, { idFactory: seq() });
  assert.ok(npc);
  assert.equal(npc.displayName, "Grace");
  assert.equal(npc.role, "healer");
  assert.equal(npc.origin, "hybrid");
  assert.equal(npc.currentLocationId, run.currentLocationId);
  assert.equal(validateNpc(npc).ok, true, "committed record validates");
  assert.ok(run.npcs[npc.npcId], "written into run.npcs");
});

test("commitNarratedNpc is idempotent by display name (no duplicate cast)", () => {
  const run = createDefaultSoloRun();
  const a = commitNarratedNpc(run, { displayName: "Doc Han" }, { idFactory: seq() });
  const b = commitNarratedNpc(run, { displayName: "doc han" }, { idFactory: seq() });
  assert.equal(a.npcId, b.npcId, "same name -> same record");
  assert.equal(Object.keys(run.npcs).length, 1);
});

test("commitNarratedNpc fails closed on invalid input", () => {
  const run = createDefaultSoloRun();
  assert.equal(commitNarratedNpc(run, {}, {}), null);
  assert.equal(commitNarratedNpc(run, { displayName: "" }, {}), null);
  assert.equal(commitNarratedNpc(null, { displayName: "X" }, {}), null);
});

test("detectPhantomNpcNames flags characters that speak/act but not known names or pronouns", () => {
  const text = "Grace nods and steps closer. A man named Doc Han says nothing. You said the password. The door creaks.";
  const phantoms = detectPhantomNpcNames(text, ["Elowen"]);
  assert.ok(phantoms.includes("Grace"), "Grace acts -> phantom");
  assert.ok(phantoms.includes("Doc Han"), "named Doc Han -> phantom");
  assert.ok(!phantoms.includes("You"), "pronoun You ignored");
  assert.ok(!phantoms.some((p) => p.toLowerCase() === "the"), "sentence-initial The ignored");
});

test("detectPhantomNpcNames catches DIALOGUE self-introductions (the S2 cascade gap)", () => {
  // "Name's Goran," he mutters — the name is the speech CONTENT, no "X says" tag.
  assert.ok(detectPhantomNpcNames('"Name’s Goran," he mutters, not lifting his head.', []).includes("Goran"));
  assert.ok(detectPhantomNpcNames('"Call me Vorga," she says flatly.', []).includes("Vorga"));
  assert.ok(detectPhantomNpcNames('"The name is Doran." He turns away.', []).includes("Doran"));
});

test("detectPhantomNpcNames catches POSSESSIVE-name-as-present, not place/object possessives", () => {
  // "Goran's chair scrapes back" — a present person acting via possession.
  assert.ok(detectPhantomNpcNames("From the hearth, Goran’s chair scrapes back.", []).includes("Goran"));
  assert.ok(detectPhantomNpcNames("Vorga's rag stills on the bar top.", []).includes("Vorga"));
  // place/object possessives must NOT be mistaken for people
  const noise = detectPhantomNpcNames("The tavern's door groans and the hearth's glow dims.", []);
  assert.ok(!noise.includes("Tavern") && !noise.includes("Hearth"), "place/object possessives ignored");
});

test("a place-suffix name is NOT mis-committed as an NPC (routes to lore)", () => {
  // "Garrison"/"...Watchtower" end in place suffixes — the NPC detector must skip
  // them (they belong to the lore path), even in a possessive or action position.
  assert.ok(!detectPhantomNpcNames("The Garrison's gate groans open.", []).includes("Garrison"));
  assert.ok(!detectPhantomNpcNames("The Old Watchtower looms over the road.", []).includes("Old Watchtower"));
  // but the lore detector DOES claim them
  assert.ok(detectPhantomLoreNames("A bell tolls from the Old Watchtower.", []).includes("Old Watchtower"));
});

test("detectPhantomLoreNames flags GM-asserted places (#41), not committed ones", () => {
  const flagged = detectPhantomLoreNames(
    "A bell echoes from the direction of the Old Watchtower, past the Iron Gate.",
    ["The Ember Tavern", "Bram"]
  );
  assert.ok(flagged.includes("Old Watchtower"), "phantom landmark flagged");
  assert.ok(flagged.includes("Iron Gate"), "second phantom landmark flagged");
  // a committed place is vouched, not flagged
  assert.deepEqual(
    detectPhantomLoreNames("You return to the Ember Tavern.", ["The Ember Tavern"]),
    []
  );
});

test("commitNarratedLoreFact / auditAndCommitNarratedLore commit a place as canonical lore", () => {
  const run = createDefaultSoloRun();
  const committed = auditAndCommitNarratedLore(run, "A bell tolls from the Old Watchtower.", [run.player?.displayName], { now: "2026-01-01T00:00:00.000Z", idFactory: seq() });
  assert.deepEqual(committed, ["Old Watchtower"]);
  const fact = run.memoryFacts.find((f) => f.type === "gm_lore");
  assert.ok(fact && fact.canonical === true && fact.payload?.name === "Old Watchtower");
  // idempotent — a re-mention commits nothing new
  const again = auditAndCommitNarratedLore(run, "The Old Watchtower looms.", [run.player?.displayName], { now: "2026-01-01T00:00:00.000Z", idFactory: seq() });
  assert.deepEqual(again, []);
});

test("auditAndCommitNarratedNpcs promotes a dialogue-introduced + possessive character", () => {
  const run = createDefaultSoloRun();
  const text = '"Name’s Goran," he mutters. Vorga’s rag stills on the bar.';
  const committed = auditAndCommitNarratedNpcs(run, text, [run.player?.displayName], { idFactory: seq() });
  assert.deepEqual(committed.sort(), ["Goran", "Vorga"]);
});

test("detectPhantomNpcNames does NOT flag an already-committed/visible name", () => {
  const text = "Grace nods.";
  assert.deepEqual(detectPhantomNpcNames(text, ["Grace"]), []);
  // first-name match against a committed full name
  assert.deepEqual(detectPhantomNpcNames(text, ["Grace Whitfield"]), []);
});

test("auditAndCommitNarratedNpcs promotes every phantom into run.npcs", () => {
  const run = createDefaultSoloRun();
  const text = "Grace nods. Doc Han grins.";
  const committed = auditAndCommitNarratedNpcs(run, text, [run.player?.displayName], { idFactory: seq() });
  assert.deepEqual(committed.sort(), ["Doc Han", "Grace"]);
  assert.equal(Object.keys(run.npcs).length, 2);
  // A second pass commits nothing new (idempotent).
  const again = auditAndCommitNarratedNpcs(run, text, [run.player?.displayName], { idFactory: seq() });
  assert.deepEqual(again, []);
});

test("evaluatePhantomEntities flags a phantom and passes a grounded scene", () => {
  const scenePayload = {
    location: { name: "The Cistern" },
    player: { displayName: "Elowen" },
    visibleEntities: [{ entityId: "npc:guard", displayName: "Marec" }]
  };
  const flagged = evaluatePhantomEntities(scenePayload, { narration: { body: "Grace nods at you." } });
  assert.equal(flagged.ok, false);
  assert.deepEqual(flagged.phantomNpcNames, ["Grace"]);

  const clean = evaluatePhantomEntities(scenePayload, { narration: { body: "Marec nods at you." } });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.phantomNpcNames, []);
});

test("evaluateGmNarration surfaces phantomNpcNames in its result", () => {
  const scenePayload = {
    location: { name: "The Cistern" },
    player: { displayName: "Elowen" },
    visibleEntities: []
  };
  const result = evaluateGmNarration(scenePayload, { narration: { title: "", body: "Doc Han says the way is shut." } });
  assert.ok(result.phantomNpcNames.includes("Doc Han"));
  assert.ok(result.warnings.includes("no_phantom_npcs"));
});
