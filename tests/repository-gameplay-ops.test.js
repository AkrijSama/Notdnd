import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCampaignMember,
  applyOperation,
  getState,
  initializeDatabase,
  loginUser,
  registerUser,
  resetDatabase
} from "../server/db/repository.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-gameplay-tests-"));
const dbPath = path.join(tmpDir, "gameplay.db.json");
process.env.NOTDND_DB_PATH = dbPath;

test("player can roll dice and create journal entry", () => {
  initializeDatabase();
  resetDatabase();

  const owner = loginUser({ email: "demo@notdnd.local", password: "demo1234" }).user;
  const player = registerUser({
    email: "player@example.com",
    password: "Password123",
    displayName: "Player One"
  }).user;

  const ownerState = getState({ userId: owner.id });
  const campaignId = ownerState.selectedCampaignId;

  addCampaignMember({ campaignId, email: player.email, role: "player" }, { actorUserId: owner.id });

  const rollResult = applyOperation(
    "roll_dice",
    {
      campaignId,
      expression: "1d20+5",
      label: "Perception"
    },
    {
      actorUserId: player.id
    }
  );

  assert.equal(rollResult.roll.label, "Perception");

  const journalResult = applyOperation(
    "add_journal_entry",
    {
      campaignId,
      title: "Clue",
      body: "Track leads to northern tower.",
      visibility: "party"
    },
    {
      actorUserId: player.id
    }
  );

  assert.equal(journalResult.entry.title, "Clue");

  const state = getState({ userId: player.id });
  assert.ok((state.recentRollsByCampaign[campaignId] || []).length >= 1);
  assert.ok((state.journalsByCampaign[campaignId] || []).some((entry) => entry.title === "Clue"));
});

test("player cannot toggle fog but gm can", () => {
  initializeDatabase();
  resetDatabase();

  const owner = loginUser({ email: "demo@notdnd.local", password: "demo1234" }).user;
  const player = registerUser({
    email: "fogplayer@example.com",
    password: "Password123",
    displayName: "Fog Player"
  }).user;

  const state = getState({ userId: owner.id });
  const campaignId = state.selectedCampaignId;
  const mapId = state.maps[0].id;

  addCampaignMember({ campaignId, email: player.email, role: "player" }, { actorUserId: owner.id });

  assert.throws(
    () =>
      applyOperation(
        "toggle_fog_cell",
        { campaignId, mapId, x: 4, y: 4 },
        { actorUserId: player.id }
      ),
    /write access/
  );

  const result = applyOperation(
    "toggle_fog_cell",
    { campaignId, mapId, x: 4, y: 4 },
    { actorUserId: owner.id }
  );

  assert.equal(result.revealed, true);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
