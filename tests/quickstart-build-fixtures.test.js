import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleQuickstartBuildPayload } from "../server/api/quickstartRoutes.js";
import {
  createQuickstartCampaignFromParsed,
  getState,
  initializeDatabase,
  resetDatabase
} from "../server/db/repository.js";
import { parseHomebrewDocuments } from "../server/homebrew/parser.js";
import { loadFixtureManifest, loadFixtureFile } from "./helpers/fixtures.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-tests-"));
const dbPath = path.join(tmpDir, "quickstart.db.json");
process.env.NOTDND_DB_PATH = dbPath;
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "memory");

const manifest = loadFixtureManifest().filter((entry) => entry.shouldParse);

for (const entry of manifest) {
  test(`quickstart build route fixture: ${entry.file}`, () => {
    initializeDatabase();
    resetDatabase();

    const response = handleQuickstartBuildPayload(
      {
        campaignName: `Fixture ${entry.file}`,
        setting: "Fixture Setting",
        players: ["Kai", "Rune"],
        files: [loadFixtureFile(entry.file)]
      },
      {
        parseHomebrewDocuments,
        createQuickstartCampaignFromParsed,
        getState
      }
    );

    const state = response.state;
    const campaign = state.campaigns.find((item) => item.id === response.launch.campaignId);
    assert.ok(campaign, "campaign should exist in state");
    assert.equal(campaign.status, "Ready");

    const map = state.maps.find((item) => item.id === campaign.activeMapId);
    assert.ok(map, "map should exist for active campaign");
    const maps = state.maps.filter((item) => item.campaignId === campaign.id);
    assert.ok(maps.length >= 2, `expected >=2 maps, got ${maps.length}`);

    const tokens = state.tokensByMap[map.id] || [];
    assert.ok(tokens.length >= 2, `expected >=2 tokens on map, got ${tokens.length}`);

    const initiative = state.initiative.filter((turn) => turn.campaignId === campaign.id);
    assert.ok(initiative.length >= 2, `expected >=2 initiative entries, got ${initiative.length}`);

    const encounters = state.encounters.filter((item) => item.campaignId === campaign.id);
    assert.ok(encounters.length >= 2, `expected >=2 encounters, got ${encounters.length}`);

    const pkg = state.campaignPackagesByCampaign[campaign.id];
    assert.ok(pkg, "campaign package should exist");
    assert.ok((pkg.scenes || []).length >= 2, "expected campaign package scenes");
    assert.ok((pkg.npcs || []).length >= 1, "expected campaign package npcs");

    const journals = state.journalsByCampaign[campaign.id] || [];
    assert.ok(journals.length >= 2, `expected >=2 journals, got ${journals.length}`);

    const chat = state.chatLog.filter((line) => line.campaignId === campaign.id);
    assert.ok(chat.some((line) => line.text.includes("VTT room launched")), "expected launch chat line");

    const memoryDir = path.join(process.env.NOTDND_MEMORY_ROOT, campaign.id);
    assert.ok(fs.existsSync(path.join(memoryDir, "human-gm.md")), "expected human gm memory doc");
    assert.ok(fs.existsSync(path.join(memoryDir, "agent-gm.md")), "expected agent gm memory doc");

    assert.ok(response.parsed.confidence.score >= entry.minConfidence, "expected confidence floor");
  });
}

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
