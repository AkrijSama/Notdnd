import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-map-persist-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "map.db.json");

const { createSoloRun, getSoloRun, saveSoloRun, updateSoloRunBattleMap, initializeDatabase, resetDatabase } =
  await import("../server/db/repository.js");
const { buildSoloScenePayload } = await import("../server/solo/scene.js");

function freshRun(runId) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId, now: "2026-01-01T00:00:00.000Z" });
  return getSoloRun(runId);
}

test("scene payload always exposes a populated battleMap (state contract)", () => {
  const run = freshRun("run_map_a");
  const map = buildSoloScenePayload(run).battleMap;
  // Contract: battleMap is always populated (not null), with a player token.
  assert.ok(map && Array.isArray(map.tokens));
  assert.ok(map.tokens.some((t) => t.kind === "player"));
});

test("updateSoloRunBattleMap persists token positions, surfaced by the scene payload", () => {
  freshRun("run_map_b");
  const run0 = getSoloRun("run_map_b");
  const playerEntityId = `player:${run0.player.playerId}`;
  const battleMap = { width: 12, height: 10, tokens: [{ entityId: playerEntityId, kind: "player", x: 3, y: 7 }] };
  assert.equal(updateSoloRunBattleMap("run_map_b", battleMap), true);

  const run = getSoloRun("run_map_b");
  assert.deepEqual(run.battleMap, battleMap);
  // The payload surfaces the persisted player position (width/height honoured too).
  const map = buildSoloScenePayload(run).battleMap;
  assert.equal(map.width, 12);
  assert.equal(map.height, 10);
  const playerToken = map.tokens.find((t) => t.entityId === playerEntityId);
  assert.deepEqual({ x: playerToken.x, y: playerToken.y }, { x: 3, y: 7 });
});

test("a run carrying battleMap tokens still passes full validation on save", () => {
  freshRun("run_map_c");
  const run0 = getSoloRun("run_map_c");
  updateSoloRunBattleMap("run_map_c", {
    width: 12,
    height: 10,
    tokens: [{ entityId: `player:${run0.player.playerId}`, kind: "player", x: 1, y: 1 }]
  });
  const run = getSoloRun("run_map_c");
  // saveSoloRun runs validateSoloRun; battleMap + tokens must be tolerated.
  assert.doesNotThrow(() => saveSoloRun(run));
});

test("updateSoloRunBattleMap reports missing run", () => {
  freshRun("run_map_d");
  assert.equal(updateSoloRunBattleMap("nope", { positions: {} }), false);
});
