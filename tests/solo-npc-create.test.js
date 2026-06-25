import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-npc-create-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "create.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
delete process.env.OPENAI_API_KEY;

const {
  createSoloRun,
  getSoloRun,
  saveSoloRun,
  initializeDatabase,
  resetDatabase,
  createSoloNpc
} = await import("../server/db/repository.js");
const { runIdentityJob } = await import("../server/solo/npcIdentity.js");

function freshRun(runId, { campaignId } = {}) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_create", runId, now: "2026-01-01T00:00:00.000Z" });
  if (campaignId) {
    const run = getSoloRun(runId);
    run.campaignId = campaignId;
    saveSoloRun(run);
  }
}

test("createSoloNpc with name + description = hybrid; identity fills gaps, name preserved", async () => {
  freshRun("run_c_a", { campaignId: "cmp_a" });
  const created = createSoloNpc("run_c_a", {
    name: "Doorman",
    description: "a hulking bouncer with a soft voice",
    introInstructions: "Have them block the exit",
    origin: "user"
  });
  assert.ok(created && created.npcId);

  let npc = getSoloRun("run_c_a").npcs[created.npcId];
  assert.equal(npc.origin, "hybrid"); // user coerced to hybrid (no upload)
  assert.equal(npc.generatedName, "Doorman"); // user name preserved
  assert.equal(npc.introInstructions, "Have them block the exit");
  assert.equal(npc.known, true);

  await runIdentityJob({ runId: "run_c_a", npcId: created.npcId });
  npc = getSoloRun("run_c_a").npcs[created.npcId];
  assert.equal(npc.generatedName, "Doorman"); // still preserved after fill-gaps
  assert.equal(npc.displayName, "Doorman");
  assert.ok(npc.appearance && npc.personality && npc.portraitPrompt);
  assert.ok(npc.memoryDocId && npc.memoryDocId.endsWith(".md"));

  const docPath = path.join(process.env.NOTDND_MEMORY_ROOT, "cmp_a", "memory", npc.memoryDocId);
  assert.ok(fs.existsSync(docPath), "memory doc bridged to disk");
});

test("createSoloNpc with no name/description defaults to procedural", async () => {
  freshRun("run_c_b", { campaignId: "cmp_b" });
  const created = createSoloNpc("run_c_b", {});
  const npc = getSoloRun("run_c_b").npcs[created.npcId];
  assert.equal(npc.origin, "procedural");
  assert.ok(!npc.generatedName);

  await runIdentityJob({ runId: "run_c_b", npcId: created.npcId });
  const filled = getSoloRun("run_c_b").npcs[created.npcId];
  assert.ok(filled.generatedName && filled.appearance && filled.portraitPrompt);
});

test("createSoloNpc honors explicit procedural origin and returns null for missing run", () => {
  freshRun("run_c_c");
  const created = createSoloNpc("run_c_c", { name: "Ignored", origin: "procedural" });
  const npc = getSoloRun("run_c_c").npcs[created.npcId];
  assert.equal(npc.origin, "procedural");

  assert.equal(createSoloNpc("run_missing", { name: "X" }), null);
});

test("createSoloNpc keeps the run schema-valid", () => {
  freshRun("run_c_d", { campaignId: "cmp_d" });
  const created = createSoloNpc("run_c_d", { name: "Vex", description: "a sly fence" });
  assert.ok(created.npcId);
  // saveSoloRun re-validates the whole run; must not throw.
  assert.doesNotThrow(() => saveSoloRun(getSoloRun("run_c_d")));
});
