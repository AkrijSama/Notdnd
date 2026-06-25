import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-npc-identity-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "identity.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
// Force the offline/deterministic fallback path (no text provider configured).
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
delete process.env.OPENAI_API_KEY;

const {
  createSoloRun,
  getSoloRun,
  saveSoloRun,
  initializeDatabase,
  resetDatabase,
  markNpcIntroduced
} = await import("../server/db/repository.js");
const { generateNpcIdentity, runIdentityJob, deterministicSeed } = await import("../server/solo/npcIdentity.js");
const { buildNpcIntroDirective, collectNpcsWithPendingIntro } = await import("../server/solo/scene.js");

function seedRunWithNpc(runId, npcId, role, extras = {}) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_identity", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  if (extras.campaignId) {
    run.campaignId = extras.campaignId;
  }
  run.npcs[npcId] = {
    npcId,
    displayName: role,
    role,
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {},
    ...(extras.npc || {})
  };
  saveSoloRun(run);
}

test("generateNpcIdentity returns complete, non-null identity offline", async () => {
  const identity = await generateNpcIdentity({ role: "Tavern Keeper", worldSeed: "seed_x", npcIndex: 0 });
  assert.ok(identity.generatedName && typeof identity.generatedName === "string");
  assert.ok(identity.appearance && typeof identity.appearance === "string");
  assert.ok(identity.personality && typeof identity.personality === "string");
  assert.ok(identity.portraitPrompt.includes(identity.generatedName));
  assert.equal(typeof identity.identitySeed, "number");
});

test("generateNpcIdentity is deterministic per (worldSeed, npcIndex)", async () => {
  const a = await generateNpcIdentity({ role: "Tavern Keeper", worldSeed: "seed_x", npcIndex: 0 });
  const b = await generateNpcIdentity({ role: "Tavern Keeper", worldSeed: "seed_x", npcIndex: 0 });
  assert.deepEqual(a, b);

  const c = await generateNpcIdentity({ role: "Tavern Keeper", worldSeed: "seed_x", npcIndex: 1 });
  assert.notEqual(a.identitySeed, c.identitySeed);
  assert.equal(deterministicSeed("seed_x", 0), a.identitySeed);
});

test("runIdentityJob writes identity via narrow write and promotes name to displayName", async () => {
  seedRunWithNpc("run_id_a", "guard", "Guard");
  const result = await runIdentityJob({ runId: "run_id_a", npcId: "guard" });
  assert.equal(result.ok, true);

  const run = getSoloRun("run_id_a");
  const npc = run.npcs.guard;
  assert.ok(npc.generatedName);
  assert.equal(npc.displayName, npc.generatedName);
  assert.ok(npc.appearance && npc.personality && npc.portraitPrompt);
  assert.equal(typeof npc.identitySeed, "number");
  // role is preserved
  assert.equal(npc.role, "Guard");
  // run is still schema-valid after the narrow write
  assert.doesNotThrow(() => saveSoloRun(getSoloRun("run_id_a")));
});

test("runIdentityJob is idempotent and reports missing npc", async () => {
  seedRunWithNpc("run_id_b", "guard", "Guard");
  await runIdentityJob({ runId: "run_id_b", npcId: "guard" });
  const second = await runIdentityJob({ runId: "run_id_b", npcId: "guard" });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);

  const missing = await runIdentityJob({ runId: "run_id_b", npcId: "ghost" });
  assert.equal(missing.ok, false);
});

test("generateNpcIdentity fills gaps but never overwrites user-provided fields", async () => {
  const out = await generateNpcIdentity({
    role: "Guard",
    worldSeed: "seed_x",
    npcIndex: 0,
    existing: { generatedName: "CustomName", appearance: "a tall figure cloaked in red" }
  });
  assert.equal(out.generatedName, "CustomName");
  assert.equal(out.appearance, "a tall figure cloaked in red");
  assert.ok(out.personality && typeof out.personality === "string");
  assert.ok(out.portraitPrompt.includes("CustomName"));
  assert.ok(out.portraitPrompt.includes("cloaked in red"));
});

test("runIdentityJob bridges the NPC into the campaign memory graph", async () => {
  seedRunWithNpc("run_id_c", "guard", "Guard", { campaignId: "cmp_bridge" });
  const result = await runIdentityJob({ runId: "run_id_c", npcId: "guard" });
  assert.equal(result.ok, true);

  const npc = getSoloRun("run_id_c").npcs.guard;
  assert.ok(npc.memoryDocId && npc.memoryDocId.endsWith(".md"));

  const docPath = path.join(process.env.NOTDND_MEMORY_ROOT, "cmp_bridge", "memory", npc.memoryDocId);
  assert.ok(fs.existsSync(docPath), "memory doc should exist on disk");
  const content = fs.readFileSync(docPath, "utf8");
  assert.ok(content.includes("type: npc"));
  assert.ok(content.includes(npc.generatedName));

  // Idempotent: a second run skips (identity + memory doc already present).
  const second = await runIdentityJob({ runId: "run_id_c", npcId: "guard" });
  assert.equal(second.skipped, true);
});

test("runIdentityJob skips the bridge when the run has no campaignId", async () => {
  seedRunWithNpc("run_id_d", "guard", "Guard");
  await runIdentityJob({ runId: "run_id_d", npcId: "guard" });
  const npc = getSoloRun("run_id_d").npcs.guard;
  assert.ok(npc.generatedName, "identity still generated");
  assert.equal(npc.memoryDocId, undefined, "no memory doc without a campaign");
});

test("intro directive is built from introInstructions and consumed once", () => {
  seedRunWithNpc("run_id_e", "guard", "Guard", {
    npc: { generatedName: "Doorman", introInstructions: "Have them slam the door open" }
  });
  const run = getSoloRun("run_id_e");
  const directive = buildNpcIntroDirective(run);
  assert.ok(directive.includes("slam the door open"));
  assert.ok(directive.includes("Doorman"));
  assert.deepEqual(collectNpcsWithPendingIntro(run), ["guard"]);

  assert.equal(markNpcIntroduced("run_id_e", "guard"), true);
  const after = getSoloRun("run_id_e");
  assert.equal(after.npcs.guard.introInstructions, null);
  assert.equal(buildNpcIntroDirective(after), "");
});
