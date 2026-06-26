import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-player-portrait-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "pp.db.json");
process.env.NOTDND_ASSETS_ROOT = path.join(tmpDir, "assets");
process.env.NOTDND_MOCK_IMAGE = "true";
delete process.env.FAL_API_KEY;

const { createSoloRun, getSoloRun, saveSoloRun, initializeDatabase, resetDatabase } = await import("../server/db/repository.js");
const { runPlayerImageJob } = await import("../server/solo/imageWorker.js");
const { buildPlayerPayload, playerNeedsPortrait } = await import("../server/solo/scene.js");
const { buildCharacter, toRunPlayer } = await import("../server/solo/characterBuild.js");
const { renderSoloCharacterSidebar, characterFromScenePlayer } = await import("../src/components/soloSceneShell.js");

function seedRunWithCharacter(runId) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  run.world = { ...run.world, tone: "grimdark", artStyle: "anime" };
  const built = buildCharacter({ name: "Kael", race: "Elf", characterClass: "Ranger", background: "Outlander", baseAbilityScores: { strength: 12, dexterity: 15, constitution: 13, intelligence: 10, wisdom: 14, charisma: 8 } });
  run.player = toRunPlayer(built, run.player);
  saveSoloRun(run);
}

test("playerNeedsPortrait true when a character exists with no portrait", () => {
  seedRunWithCharacter("run_pp_a");
  assert.equal(playerNeedsPortrait(getSoloRun("run_pp_a")), true);
});

test("runPlayerImageJob generates + stores the player portrait (idempotent)", async () => {
  seedRunWithCharacter("run_pp_b");
  const result = await runPlayerImageJob({ runId: "run_pp_b" });
  assert.equal(result.ok, true);

  const run = getSoloRun("run_pp_b");
  assert.ok(run.player.portraitUri && run.player.portraitUri.includes("/player/base."));
  const onDisk = path.join(process.env.NOTDND_ASSETS_ROOT, "run_pp_b", "player", "base.png");
  assert.ok(fs.existsSync(onDisk), "player portrait written to disk");

  // payload exposes it; no longer "needs" a portrait
  assert.equal(buildPlayerPayload(run).portraitUri, run.player.portraitUri);
  assert.equal(playerNeedsPortrait(run), false);

  const second = await runPlayerImageJob({ runId: "run_pp_b" });
  assert.equal(second.skipped, true);
});

test("runPlayerImageJob reports missing run", async () => {
  const r = await runPlayerImageJob({ runId: "nope" });
  assert.equal(r.ok, false);
});

test("sidebar renders the player portrait img when present", () => {
  const character = characterFromScenePlayer({
    displayName: "Kael",
    className: "Ranger",
    abilities: { strength: 12, dexterity: 17, constitution: 13, intelligence: 10, wisdom: 14, charisma: 8 },
    hitPoints: { current: 11, max: 11 },
    portraitUri: "/data/assets/run_pp_b/player/base.png"
  });
  assert.equal(character.portraitUri, "/data/assets/run_pp_b/player/base.png");
  const html = renderSoloCharacterSidebar(character);
  assert.match(html, /<img class="solo-portrait-img" src="\/data\/assets\/run_pp_b\/player\/base.png"/);
});
