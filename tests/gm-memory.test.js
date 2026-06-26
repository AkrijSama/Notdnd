import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContextWindow,
  ensureCampaignMemoryDocsAsync,
  getEntity,
  listEntities,
  search,
  upsertEntity
} from "../server/gm/memoryStore.js";

test("campaign memory entities are persisted, searchable, and context-windowed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-memory-tests-"));
  process.env.NOTDND_MEMORY_ROOT = tmpDir;

  await ensureCampaignMemoryDocsAsync("cmp_test");

  await upsertEntity("cmp_test", {
    name: "Kael the Blacksmith",
    type: "npc",
    tags: ["thornwall", "blacksmith"],
    body: "Kael runs the only smithy in Thornwall. He secretly supports the Iron Pact and knows about the Undercrypt entrance.",
    relations: [{ target: "Thornwall", type: "located_in" }]
  });

  await upsertEntity("cmp_test", {
    name: "Thornwall",
    type: "location",
    tags: ["town"],
    body: "A fortified river town known for steelwork and river trade.",
    relations: []
  });

  const listed = await listEntities("cmp_test");
  assert.ok(listed.some((entity) => entity.name === "Kael the Blacksmith"));

  const fetched = await getEntity("cmp_test", "Kael the Blacksmith");
  assert.match(fetched.body, /smithy/i);

  const results = await search("cmp_test", "iron pact undercrypt", { limit: 3 });
  assert.ok(results.length >= 1);
  assert.ok(results.some((entry) => entry.name === "Kael the Blacksmith"));

  const context = await buildContextWindow("cmp_test", "ask kael about undercrypt", 400);
  assert.match(context, /Kael the Blacksmith/i);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
