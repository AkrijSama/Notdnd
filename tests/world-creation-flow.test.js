// END-TO-END: a saved user world COMPILES → LOADS into a real run (the character-creation
// handoff mints the run via createWorldOnboardingRun) → is world-ISOLATED (a stranger's
// run never loads the owner's world). Zero real LLM calls (mock openrouter + placeholder
// worldgen). This is the "compile + load + handoff + isolation + style-lock" proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-wcflow-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "flow.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";
delete process.env.OPENAI_API_KEY;

const { initializeDatabase, resetDatabase, createGuestUser, addUserWorld, getSoloRun } = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");
const { compileWorldBook } = await import("../server/campaign/worldBook.js");
const { styleForRun } = await import("../server/solo/artStyle.js");

const CHAR = {
  name: "Rae", pronouns: "she/her", race: "Human", characterClass: "Rogue", background: "Urchin",
  baseAbilityScores: { strength: 10, dexterity: 14, constitution: 10, intelligence: 12, wisdom: 10, charisma: 12 }
};

function seatWorld(userId, id) {
  const { scenario } = compileWorldBook(
    { name: "Neon Reach", vibe: "rain that never stops", world: { artStyle: "cinematic" }, pois: [{ name: "The Sprawl", poiClass: "settlement", dangerLevel: 1 }] },
    { scenarioId: id }
  );
  return addUserWorld(userId, { id, name: "Neon Reach", tagline: "rain", scenario, worldBook: {}, schemaVersion: 1 });
}

test("a saved user world loads into a playable run bound to that world (the handoff)", async () => {
  initializeDatabase();
  resetDatabase();
  const owner = createGuestUser();
  const rec = seatWorld(owner.user.id, "uw_flow_1");

  const result = await createWorldOnboardingRun(owner.user.id, { world: {}, character: CHAR, mode: "campaign", userWorldId: rec.id });
  assert.ok(result.runId, "a run was minted");
  const run = getSoloRun(result.runId);
  assert.equal(run.world.name, "Neon Reach", "the run loaded the user world, not worldgen");
  assert.equal(run.world.userWorldId, "uw_flow_1", "world-isolation stamp: the run is bound to this world");
  assert.equal(run.world.worldKind, "user");
  const start = run.locations[run.currentLocationId];
  assert.ok(start, "the run starts somewhere");
  assert.ok((start.tags || []).some((t) => /start-area/.test(t)), "on the kept-ground start");
});

test("style-lock: a user world honors the picked art style", async () => {
  initializeDatabase();
  resetDatabase();
  const owner = createGuestUser();
  const rec = seatWorld(owner.user.id, "uw_flow_style");
  // The player picks 'cinematic' at creation (client sends world.artStyle).
  const result = await createWorldOnboardingRun(owner.user.id, { world: { artStyle: "cinematic" }, character: CHAR, mode: "campaign", userWorldId: rec.id });
  const run = getSoloRun(result.runId);
  assert.equal(styleForRun(run), "realistic", "cinematic → canonical 'realistic' is locked for the run");
});

test("world ISOLATION at the run boundary: a stranger's run never loads the owner's world", async () => {
  initializeDatabase();
  resetDatabase();
  const owner = createGuestUser();
  const stranger = createGuestUser();
  const rec = seatWorld(owner.user.id, "uw_flow_iso");

  // The stranger passes the owner's userWorldId — getUserWorld is owner-scoped, so it
  // resolves to nothing and the run falls back to worldgen (never the owner's world).
  const result = await createWorldOnboardingRun(stranger.user.id, { world: {}, character: CHAR, mode: "campaign", userWorldId: rec.id });
  const run = getSoloRun(result.runId);
  assert.notEqual(run.world.name, "Neon Reach", "the stranger did NOT get the owner's world");
  assert.equal(run.world.userWorldId, undefined, "no cross-world binding — characters never cross worlds");
});
