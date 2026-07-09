import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { commitSocialDisposition, resolveSocialTarget } from "../server/solo/relationships.js";

const seq = () => {
  let n = 0;
  return () => `id${++n}`;
};

function npc(id, displayName, extra = {}) {
  return { npcId: id, displayName, role: "barkeep", status: "present", known: true, tags: [], flags: {}, memoryFactIds: [], origin: "hybrid", ...extra };
}

function runWithNpc(overrides = {}) {
  const run = createDefaultSoloRun({ runId: "rel_test" });
  run.npcs = { npc_mara: npc("npc_mara", "Mara", { currentLocationId: run.currentLocationId, ...overrides }) };
  return run;
}

test("commitSocialDisposition: a clean persuade success raises trust and stays schema-valid", () => {
  const run = runWithNpc();
  const change = commitSocialDisposition(run, { intent: "persuade Mara to trust me", band: "success", success: true }, { idFactory: seq() });
  assert.ok(change, "a change is committed");
  assert.equal(change.targetNpcId, "npc_mara");
  assert.equal(change.meter, "trust");
  assert.equal(change.before, 0);
  assert.equal(change.after, 3);
  // committed to state as a keyed record
  const rel = Object.values(run.relationships)[0];
  assert.equal(rel.meters.trust, 3);
  assert.equal(validateSoloRun(run).ok, true, "run stays schema-valid");
});

test("commitSocialDisposition: verb maps to the right meter (charm→affection, intimidate→fear)", () => {
  const charm = commitSocialDisposition(runWithNpc(), { intent: "charm the woman at the bar", band: "success" }, { idFactory: seq() });
  assert.equal(charm.meter, "affection");
  assert.equal(charm.after, 3);
  const fear = commitSocialDisposition(runWithNpc(), { intent: "intimidate Mara into talking", band: "success" }, { idFactory: seq() });
  assert.equal(fear.meter, "fear");
  assert.equal(fear.after, 3);
});

test("commitSocialDisposition: at-a-cost gives less + suspicion; failure gives only suspicion", () => {
  const cost = commitSocialDisposition(runWithNpc(), { intent: "persuade Mara", band: "success_at_cost" }, { idFactory: seq() });
  assert.equal(cost.delta, 1);
  assert.equal(cost.suspicionDelta, 1);
  const fail = commitSocialDisposition(runWithNpc(), { intent: "persuade Mara", band: "failure" }, { idFactory: seq() });
  assert.equal(fail.delta, 0);
  assert.equal(fail.suspicionDelta, 2);
});

test("commitSocialDisposition: no groundable target -> null (no phantom disposition)", () => {
  const run = createDefaultSoloRun({ runId: "rel_none" });
  run.npcs = {}; // nobody present
  assert.equal(commitSocialDisposition(run, { intent: "persuade the barkeep", band: "success" }), null);
});

test("resolveSocialTarget: names in intent beat the sole-present fallback", () => {
  const run = createDefaultSoloRun({ runId: "rel_two" });
  run.npcs = {
    a: npc("npc_a", "Mara", { currentLocationId: run.currentLocationId }),
    b: npc("npc_b", "Goran", { currentLocationId: run.currentLocationId, role: "drunk" })
  };
  assert.equal(resolveSocialTarget(run, { intent: "flatter Goran" }).npcId, "npc_b");
  // two present, none named -> ambiguous -> null (no guessed disposition)
  assert.equal(resolveSocialTarget(run, { intent: "make small talk" }), null);
});
