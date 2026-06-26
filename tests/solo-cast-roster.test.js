import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-cast-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "cast.db.json");

const {
  createSoloRun,
  getSoloRun,
  saveSoloRun,
  initializeDatabase,
  resetDatabase,
  createSoloNpc,
  ensureNpcImageAssets,
  updateImageAssetStatus
} = await import("../server/db/repository.js");
const { buildSoloScenePayload } = await import("../server/solo/scene.js");

test("createSoloNpc keeps origin 'user' (no longer coerced to hybrid)", () => {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId: "run_origin", now: "2026-01-01T00:00:00.000Z" });
  const created = createSoloNpc("run_origin", { name: "Vex", description: "a fence", origin: "user" });
  const npc = getSoloRun("run_origin").npcs[created.npcId];
  assert.equal(npc.origin, "user");
});

test("scene payload exposes the full cast roster with resolved portrait URIs", () => {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId: "run_cast", now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun("run_cast");
  run.npcs.vex = {
    npcId: "vex",
    displayName: "Vex",
    generatedName: "Vex",
    role: "Fence",
    currentLocationId: "start_location",
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {},
    origin: "user"
  };
  saveSoloRun(run);

  ensureNpcImageAssets("run_cast", "vex", { style: "illustrated" });
  updateImageAssetStatus("run_cast", "img_vex_base", "generated", "/data/assets/run_cast/vex/base.png");

  const payload = buildSoloScenePayload(getSoloRun("run_cast"));
  assert.notEqual(payload.ok, false);
  assert.ok(Array.isArray(payload.cast));

  const vex = payload.cast.find((member) => member.npcId === "vex");
  assert.ok(vex, "cast should include the NPC");
  assert.equal(vex.displayName, "Vex");
  assert.equal(vex.role, "Fence");
  assert.equal(vex.origin, "user");
  assert.equal(vex.present, true);
  assert.equal(vex.portraitUri, "/data/assets/run_cast/vex/base.png");
});

test("scene payload includes the player's character projection", () => {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId: "run_player", now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun("run_player");
  run.player.displayName = "Nyx";
  run.player.className = "disgraced knight";
  saveSoloRun(run);

  const payload = buildSoloScenePayload(getSoloRun("run_player"));
  assert.notEqual(payload.ok, false);
  assert.ok(payload.player);
  assert.equal(payload.player.displayName, "Nyx");
  assert.equal(payload.player.className, "disgraced knight");
  assert.equal(payload.player.level, 1);
  assert.deepEqual(payload.player.hitPoints, { current: 10, max: 10 });
  assert.equal(payload.player.armorClass, null); // not tracked on run.player
  assert.equal(payload.player.abilities.strength, 10);
});

test("cast portraitUri is null until the base asset is generated", () => {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId: "run_cast2", now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun("run_cast2");
  run.npcs.vex = {
    npcId: "vex",
    displayName: "Vex",
    role: "Fence",
    currentLocationId: "start_location",
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {}
  };
  saveSoloRun(run);
  ensureNpcImageAssets("run_cast2", "vex", {}); // base stays "queued"

  const payload = buildSoloScenePayload(getSoloRun("run_cast2"));
  const vex = payload.cast.find((member) => member.npcId === "vex");
  assert.equal(vex.portraitUri, null);
});
