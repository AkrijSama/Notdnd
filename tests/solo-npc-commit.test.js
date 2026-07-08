import test from "node:test";
import assert from "node:assert/strict";

import {
  commitNarratedNpc,
  detectPhantomNpcNames,
  auditAndCommitNarratedNpcs
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
