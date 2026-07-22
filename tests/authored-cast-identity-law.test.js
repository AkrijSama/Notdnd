// AUTHORED-CONTENT SURVIVES THE PROCEDURAL IDENTITY PASS (coherence walk finding #1).
//
// The bug: authored Babel cast (npc_marshal = "Marshal Odile Grace") were renamed to a
// generated name ("Renn") on lazy-commit, because runIdentityJob → updateNpcIdentity
// overwrote displayName unconditionally. Authored copy references cast BY NAME ("Grace's
// licensing office", "Ask Grace what a license buys"), so the rename broke the world.
//
// This is a LAW test: EVERY authored NPC in babel.json is run through the SAME live
// lazy-commit path (runIdentityJob, offline placeholder provider — the deterministic
// FALLBACK_NAMES path that WOULD stomp if the guard regressed) and every authored
// identity field must survive byte-identical. It fails loudly if a future procedural
// pass re-introduces the stomp.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-authored-identity-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "authored.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
// Force the offline/deterministic fallback path — no text provider, so generateNpcIdentity
// returns a FALLBACK_NAMES identity. That is exactly the pass that stomped authored names.
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const { createSoloRun, getSoloRun, saveSoloRun, initializeDatabase, resetDatabase } =
  await import("../server/db/repository.js");
const { runIdentityJob } = await import("../server/solo/npcIdentity.js");
const { loadScenarioIntoRun, loadScenarioFile } = await import("../server/campaign/scenarioLoader.js");

// The authored cast, straight from the world-book — the source of truth.
const scenario = loadScenarioFile("babel");
const authoredCast = (Array.isArray(scenario.cast) ? scenario.cast : Object.values(scenario.cast || {}));

function babelRunInDb(runId) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_authored", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  loadScenarioIntoRun(run, scenario, {});
  saveSoloRun(run);
  return run;
}

test("every authored Babel cast name survives the live lazy-commit identity pass", async () => {
  const runId = "run_authored_names";
  babelRunInDb(runId);

  for (const c of authoredCast) {
    const npcId = c.npcId;
    const authoredName = c.displayName;
    if (typeof authoredName !== "string" || !authoredName.trim()) continue; // nameless authored → generation is legitimate
    // Run the SAME job the live path runs when the player reaches this NPC.
    const res = await runIdentityJob({ runId, npcId });
    assert.ok(res.ok, `identity job ran for ${npcId}`);
    const npc = getSoloRun(runId).npcs[npcId];
    assert.equal(
      npc.displayName,
      authoredName,
      `authored displayName for ${npcId} must survive byte-identical (got "${npc.displayName}", authored "${authoredName}")`
    );
    // The affordance layer reads generatedName || displayName — it must NEVER hold a ghost
    // name that would surface as "Talk to Renn" over "Marshal Odile Grace".
    if (typeof npc.generatedName === "string" && npc.generatedName.trim()) {
      assert.equal(npc.generatedName, authoredName, `${npcId} generatedName must not shadow the authored name`);
    }
  }
});

test("an authored appearance (the VOICE's green-gold light) survives the pass", async () => {
  const runId = "run_authored_appearance";
  babelRunInDb(runId);
  // Any authored cast member that committed an appearance must keep it byte-identical.
  const withAppearance = authoredCast.filter((c) => typeof c.appearance === "string" && c.appearance.trim());
  for (const c of withAppearance) {
    await runIdentityJob({ runId, npcId: c.npcId });
    const npc = getSoloRun(runId).npcs[c.npcId];
    assert.equal(npc.appearance, c.appearance, `authored appearance for ${c.npcId} must survive`);
  }
  // If babel authored no appearances, the test is vacuously green — still a live guard for
  // the day a world commits one (portrait override).
  assert.ok(true);
});

test("a PROCEDURAL placeholder NPC (displayName === role) still gets a generated name", async () => {
  // The guard must not over-fire: a genuine procedural NPC (placeholder name) must still
  // be named by the pass, or the pantry/roster fills with role-labelled ghosts.
  const runId = "run_procedural_name";
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_proc", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  run.npcs.npc_proc = { npcId: "npc_proc", displayName: "stranger", role: "stranger", known: true, status: "present", memoryFactIds: [], tags: [], flags: {} };
  saveSoloRun(run);
  await runIdentityJob({ runId, npcId: "npc_proc" });
  const npc = getSoloRun(runId).npcs.npc_proc;
  assert.notEqual(npc.displayName, "stranger", "a placeholder (displayName === role) must be replaced with a real name");
  assert.ok(typeof npc.displayName === "string" && npc.displayName.trim().length > 0);
});
