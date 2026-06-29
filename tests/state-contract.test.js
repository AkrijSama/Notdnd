import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { buildBattleMapPayload, buildSoloScenePayload } from "../server/solo/scene.js";

// STEP 0 state contract (see server/solo/CONTRACT.md). These tests freeze the
// shared data shape the parallel tracks build against: every contract field is
// present in the scene payload with sane defaults, and legacy runs that predate
// the fields still validate + emit defaults.

function defaultRun(runId) {
  return createDefaultSoloRun({ runId });
}

test("createDefaultSoloRun carries the contract defaults and validates", () => {
  const run = defaultRun("run_contract_default");
  assert.equal(validateSoloRun(run).ok, true);
  assert.equal(run.mode, "campaign");
  assert.equal(run.player.xp, 0);
  assert.deepEqual(run.player.inventory, []);
  assert.deepEqual(run.player.conditions, []);
});

test("scene payload emits run.mode (default campaign)", () => {
  const payload = buildSoloScenePayload(defaultRun("run_contract_mode"));
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "campaign");
});

test("scene payload emits player.resources.{hp,mp} gauges", () => {
  const payload = buildSoloScenePayload(defaultRun("run_contract_res"));
  const res = payload.player.resources;
  assert.ok(res, "resources present");
  for (const key of ["hp", "mp"]) {
    assert.equal(typeof res[key].current, "number", `${key}.current is number`);
    assert.equal(typeof res[key].max, "number", `${key}.max is number`);
  }
  // HP mirrors the persisted hitPoints gauge (10/10 on a default run).
  assert.equal(res.hp.max, 10);
});

test("scene payload emits player.inventory as an array of {id,name,qty}", () => {
  const payload = buildSoloScenePayload(defaultRun("run_contract_inv"));
  const inv = payload.player.inventory;
  assert.ok(Array.isArray(inv), "inventory is array");
  // Default run seeds a field_ration in run.inventory — projected into the array.
  assert.ok(inv.length >= 1);
  for (const item of inv) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.name, "string");
    assert.equal(typeof item.qty, "number");
  }
});

test("scene payload emits player.xp, level, and conditions", () => {
  const payload = buildSoloScenePayload(defaultRun("run_contract_xp"));
  assert.equal(typeof payload.player.xp, "number");
  assert.equal(typeof payload.player.level, "number");
  assert.ok(Array.isArray(payload.player.conditions));
});

test("scene battleMap is populated with a player token every scene", () => {
  const payload = buildSoloScenePayload(defaultRun("run_contract_map"));
  const map = payload.battleMap;
  assert.ok(map && Array.isArray(map.tokens), "battleMap.tokens is array");
  assert.equal(typeof map.width, "number");
  assert.equal(typeof map.height, "number");
  const playerToken = map.tokens.find((t) => t.kind === "player");
  assert.ok(playerToken, "player token present");
  assert.equal(typeof playerToken.x, "number");
  assert.equal(typeof playerToken.y, "number");
  assert.match(playerToken.entityId, /^player:/);
});

test("buildBattleMapPayload emits a token for a co-located NPC", () => {
  const run = defaultRun("run_contract_npc_token");
  const locId = run.currentLocationId;
  // Tested via the pure builder so it doesn't depend on full NPC schema validity.
  run.npcs = {
    npc_hale: { npcId: "npc_hale", currentLocationId: locId },
    npc_elsewhere: { npcId: "npc_elsewhere", currentLocationId: "somewhere_else" }
  };
  const map = buildBattleMapPayload(run);
  const haleToken = map.tokens.find((t) => t.entityId === "npc:npc_hale");
  assert.ok(haleToken, "co-located NPC token present");
  assert.equal(haleToken.kind, "npc");
  // An NPC in another location is NOT placed on this scene's map.
  assert.equal(map.tokens.some((t) => t.entityId === "npc:npc_elsewhere"), false);
  // Player token still anchors the centre.
  assert.ok(map.tokens.some((t) => t.kind === "player"));
});

test("buildBattleMapPayload honours persisted token positions", () => {
  const run = defaultRun("run_contract_persisted_pos");
  const playerEntityId = `player:${run.player.playerId}`;
  run.battleMap = { tokens: [{ entityId: playerEntityId, kind: "player", x: 2, y: 9 }] };
  const map = buildBattleMapPayload(run);
  const playerToken = map.tokens.find((t) => t.entityId === playerEntityId);
  assert.equal(playerToken.x, 2);
  assert.equal(playerToken.y, 9);
});

test("legacy run missing contract fields still validates and emits defaults", () => {
  const run = defaultRun("run_contract_legacy");
  // Simulate a run persisted before the contract existed.
  delete run.mode;
  delete run.player.xp;
  delete run.player.inventory;
  delete run.player.conditions;
  delete run.battleMap;

  assert.equal(validateSoloRun(run).ok, true, "legacy run still validates");

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "campaign");
  assert.equal(payload.player.xp, 0);
  assert.ok(Array.isArray(payload.player.conditions));
  assert.ok(payload.player.resources.hp && payload.player.resources.mp);
  assert.ok(Array.isArray(payload.battleMap.tokens));
  assert.ok(payload.battleMap.tokens.some((t) => t.kind === "player"));
});

test("contract validators reject malformed contract fields", () => {
  const badMode = defaultRun("run_contract_bad_mode");
  badMode.mode = "freeplay";
  assert.equal(validateSoloRun(badMode).ok, false);

  const badInv = defaultRun("run_contract_bad_inv");
  badInv.player.inventory = [{ name: "no id" }];
  assert.equal(validateSoloRun(badInv).ok, false);

  const badToken = defaultRun("run_contract_bad_token");
  badToken.battleMap = { tokens: [{ entityId: "x", kind: "monster", x: 1, y: 1 }] };
  assert.equal(validateSoloRun(badToken).ok, false);
});

// ── STEP 0.5: death-state contract ──────────────────────────────────────────

test("default run carries death-state defaults (status alive, deathSaves 0/0)", () => {
  const run = defaultRun("run_death_default");
  assert.equal(validateSoloRun(run).ok, true);
  assert.equal(run.player.status, "alive");
  assert.deepEqual(run.player.deathSaves, { successes: 0, failures: 0 });
});

test("scene payload emits player.status, player.deathSaves, runStatus, resumable", () => {
  const payload = buildSoloScenePayload(defaultRun("run_death_payload"));
  assert.equal(payload.player.status, "alive");
  assert.deepEqual(payload.player.deathSaves, { successes: 0, failures: 0 });
  assert.equal(payload.runStatus, "active");
  assert.equal(payload.resumable, true);
  assert.equal(payload.isDead, false);
});

test("a dead run is surfaced as terminal / non-resumable in the payload", () => {
  const run = defaultRun("run_death_terminal");
  run.status = "dead";
  run.player.status = "dead";
  assert.equal(validateSoloRun(run).ok, true, "dead run validates");
  const payload = buildSoloScenePayload(run);
  // buildSoloScenePayload only returns ok for a renderable run; a dead run still
  // renders (death/review screen), so these fields must be present.
  assert.equal(payload.runStatus, "dead");
  assert.equal(payload.resumable, false);
  assert.equal(payload.isDead, true);
  assert.equal(payload.player.status, "dead");
});

test("the four canonical lifecycle statuses + legacy values validate", () => {
  for (const status of ["alive", "dying", "stable", "dead", "active", "downed"]) {
    const run = defaultRun(`run_status_${status}`);
    run.player.status = status;
    assert.equal(validateSoloRun(run).ok, true, `${status} validates`);
  }
});

test("a revival item validates via use.effectType=revive and via tags", () => {
  const byEffect = defaultRun("run_revive_effect");
  byEffect.inventory.revive_scroll = {
    itemId: "revive_scroll", name: "Scroll of Revivify", quantity: 1,
    usable: true, consumable: true,
    use: { effectType: "revive", label: "Read the scroll" },
    tags: [], flags: {}
  };
  assert.equal(validateSoloRun(byEffect).ok, true);

  const byTag = defaultRun("run_revive_tag");
  byTag.inventory.token = {
    itemId: "token", name: "Resurrection Token", quantity: 1,
    usable: true, consumable: true, tags: ["revival"], flags: {}
  };
  assert.equal(validateSoloRun(byTag).ok, true);
});

test("death-state validators reject bad status and out-of-range deathSaves", () => {
  const badStatus = defaultRun("run_death_bad_status");
  badStatus.player.status = "zombie";
  assert.equal(validateSoloRun(badStatus).ok, false);

  const badRunStatus = defaultRun("run_death_bad_runstatus");
  badRunStatus.status = "vanquished";
  assert.equal(validateSoloRun(badRunStatus).ok, false);

  const tooHigh = defaultRun("run_death_saves_high");
  tooHigh.player.deathSaves = { successes: 4, failures: 0 };
  assert.equal(validateSoloRun(tooHigh).ok, false);

  const negative = defaultRun("run_death_saves_neg");
  negative.player.deathSaves = { successes: 0, failures: -1 };
  assert.equal(validateSoloRun(negative).ok, false);

  const nonInt = defaultRun("run_death_saves_float");
  nonInt.player.deathSaves = { successes: 1.5, failures: 0 };
  assert.equal(validateSoloRun(nonInt).ok, false);
});

test("legacy run without death-state fields still validates and gets defaults", () => {
  const run = defaultRun("run_death_legacy");
  delete run.player.status;
  delete run.player.deathSaves;
  assert.equal(validateSoloRun(run).ok, true, "legacy run validates");
  const payload = buildSoloScenePayload(run);
  assert.equal(payload.player.status, "alive");
  assert.deepEqual(payload.player.deathSaves, { successes: 0, failures: 0 });
});
