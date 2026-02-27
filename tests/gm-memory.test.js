import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureCampaignMemoryDocs, listCampaignMemoryDocs, searchCampaignMemory, writeCampaignMemoryDoc } from "../server/gm/memoryStore.js";

test("campaign memory docs are created, writable, and searchable by keyword", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-memory-tests-"));
  process.env.NOTDND_MEMORY_ROOT = tmpDir;

  ensureCampaignMemoryDocs("cmp_test", {
    human: "# Human GM Guide\n\n## Plot Device\nThe obsidian key opens the drowned archive.\n",
    agent: "# Agent GM Guide\n\n## Villain Plan\nCaptain Vey prepares the harbor ambush.\n",
    timeline: "# Shared Timeline\n\n## Session 1\nThe party secured the lighthouse beacon.\n"
  });

  const docs = listCampaignMemoryDocs("cmp_test");
  assert.equal(docs.length, 3);
  assert.ok(docs.some((doc) => doc.key === "human"));

  const saved = writeCampaignMemoryDoc("cmp_test", "timeline", "# Shared Timeline\n\n## Session 2\nThe party recovered the obsidian key.\n");
  assert.match(saved.content, /obsidian key/);

  const results = searchCampaignMemory("cmp_test", "obsidian key harbor", { limit: 3 });
  assert.ok(results.length >= 1);
  assert.ok(results.some((entry) => entry.text.includes("obsidian key")));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
