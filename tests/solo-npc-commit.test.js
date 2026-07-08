import test from "node:test";
import assert from "node:assert/strict";

import {
  commitNarratedNpc,
  detectPhantomNpcNames,
  auditAndCommitNarratedNpcs,
  detectPhantomLoreNames,
  commitNarratedLoreFact,
  auditAndCommitNarratedLore,
  detectInventedAgents,
  auditAndCommitInventedAgents,
  inferNpcGenderFromNarration,
  backfillNpcGenderFromNarration
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

test("detectInventedAgents flags a generic actor with agency (B2), respects cast + negation", () => {
  // the exact 2/5-session offenders
  assert.ok(detectInventedAgents("Only the creature's unblinking gaze demands an answer.").includes("Creature"));
  assert.ok(detectInventedAgents('"I\'ll not be ordered about by some gutter scavenger," he hisses.').includes("Scavenger"));
  // a concrete acting agent is committed even when other cast exists…
  assert.ok(detectInventedAgents("A wolf lunges from the dark.", { hasCast: true }).includes("Wolf"));
  // …but a PARAPHRASE noun (figure/stranger) is vouched by existing cast, not invented
  assert.deepEqual(detectInventedAgents("The figure steps forward.", { hasCast: true }), []);
  // an already-committed token is not re-flagged
  assert.deepEqual(detectInventedAgents("The scavenger nods.", { knownAgentTokens: new Set(["scavenger"]) }), []);
  // honest ABSENCE is not an invention
  assert.deepEqual(detectInventedAgents("No creature stirs in the dark."), []);
});

test("inferNpcGenderFromNarration (#50) reads the pronouns the narration uses", () => {
  assert.deepEqual(inferNpcGenderFromNarration("Mara", "Mara wipes the bar. She eyes you, her hand near a knife."), { gender: "female", pronouns: "she/her" });
  assert.deepEqual(inferNpcGenderFromNarration("Goran", "Goran hunches lower. He mutters into his drink."), { gender: "male", pronouns: "he/him" });
  assert.deepEqual(inferNpcGenderFromNarration("Ash", "Ash nods. They keep their hood up, watching."), { gender: "non-binary", pronouns: "they/them" });
  assert.equal(inferNpcGenderFromNarration("Mara", "The door creaks in the wind."), null, "no signal -> null");
});

test("auditAndCommitNarratedNpcs commits gender/pronouns so the portrait can match (#50)", () => {
  const run = createDefaultSoloRun();
  auditAndCommitNarratedNpcs(run, 'Mara nods and sets down a mug. She eyes you, her hand near a knife.', [run.player?.displayName], { idFactory: seq() });
  const mara = Object.values(run.npcs).find((n) => n.displayName === "Mara");
  assert.ok(mara, "Mara committed");
  assert.equal(mara.gender, "female");
  assert.equal(mara.pronouns, "she/her");
});

test("backfillNpcGenderFromNarration (#50) grounds an ungendered committed NPC from the text", () => {
  const run = createDefaultSoloRun();
  // a starting/identity NPC minted without gender
  run.npcs = { npc_keeper: { npcId: "npc_keeper", displayName: "Esk", role: "tavern keeper", status: "present", currentLocationId: run.currentLocationId, memoryFactIds: [] } };
  const updated = backfillNpcGenderFromNarration(run, "Esk wipes down the bar. She eyes you, her hand never far from the tap.");
  assert.deepEqual(updated, ["Esk"]);
  assert.equal(run.npcs.npc_keeper.gender, "female");
  assert.equal(run.npcs.npc_keeper.pronouns, "she/her");
  // idempotent — an already-gendered NPC is left alone (no overwrite)
  const again = backfillNpcGenderFromNarration(run, "Esk grins. He leans in.");
  assert.deepEqual(again, [], "does not overwrite a committed gender");
  assert.equal(run.npcs.npc_keeper.gender, "female");
});

test("auditAndCommitInventedAgents promotes an un-named acting agent into cast", () => {
  const run = createDefaultSoloRun();
  const committed = auditAndCommitInventedAgents(run, "The creature snarls and lunges at you.", [run.player?.displayName], { idFactory: seq() });
  assert.deepEqual(committed, ["Creature"]);
  assert.ok(Object.values(run.npcs).some((n) => n.displayName === "Creature"));
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
