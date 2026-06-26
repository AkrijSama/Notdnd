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

test("scene payload exposes battleMap (null until set)", () => {
  const run = freshRun("run_map_a");
  assert.equal(buildSoloScenePayload(run).battleMap, null);
});

test("updateSoloRunBattleMap persists positions, surfaced by the scene payload", () => {
  freshRun("run_map_b");
  const battleMap = { width: 12, height: 10, positions: { player: { x: 3, y: 7 }, "npc:n1": { x: 8, y: 2 } } };
  assert.equal(updateSoloRunBattleMap("run_map_b", battleMap), true);

  const run = getSoloRun("run_map_b");
  assert.deepEqual(run.battleMap, battleMap);
  assert.deepEqual(buildSoloScenePayload(run).battleMap, battleMap);
});

test("a run carrying battleMap still passes full validation on save", () => {
  freshRun("run_map_c");
  updateSoloRunBattleMap("run_map_c", { width: 12, height: 10, positions: { player: { x: 1, y: 1 } } });
  const run = getSoloRun("run_map_c");
  // saveSoloRun runs validateSoloRun; battleMap must be tolerated.
  assert.doesNotThrow(() => saveSoloRun(run));
});

test("updateSoloRunBattleMap reports missing run", () => {
  freshRun("run_map_d");
  assert.equal(updateSoloRunBattleMap("nope", { positions: {} }), false);
});
