import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// WALK-3 V2 — REACHABILITY ON THE OPENING PATH SPECIFICALLY.
//
// The prior VOICE test hand-constructed a speaker object (including a portraitUri
// the server could never produce) and asserted a CLASS NAME STRING. That is why the
// feature could be dead while the test stayed green: it exercised the renderer, not
// the wire. This test drives the REAL authored-opening path end to end —
// createWorldOnboardingRun → run state → buildSoloScenePayload — and asserts the
// opening actually reaches the VN cast surface.
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-openvoice-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "openvoice.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";

const { initializeDatabase, resetDatabase, createGuestUser, getSoloRun } = await import(
  "../server/db/repository.js"
);
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");
const { buildSoloScenePayload } = await import("../server/solo/scene.js");

const CHAR = {
  name: "Akrij",
  race: "Human",
  characterClass: "Fighter",
  background: "Drifter",
  pronouns: "he/him",
  gender: "male",
  bodyType: "average"
};

const VOICE_NPC_ID = "npc_voice";

async function babelRun() {
  initializeDatabase();
  resetDatabase();
  const guest = createGuestUser();
  const result = await createWorldOnboardingRun(guest.user.id, {
    world: { tone: "dark fantasy", artStyle: "anime" },
    character: CHAR,
    mode: "campaign",
    scenarioId: "babel"
  });
  assert.ok(result.runId, "run created");
  const run = getSoloRun(result.runId);
  assert.ok(run, "run readable back from the store");
  return run;
}

test("V2: the authored opening COMMITS the VOICE as the VN speaker (run.vn), not just narration", async () => {
  const run = await babelRun();
  assert.ok(Array.isArray(run.openingBeats) && run.openingBeats.length > 0, "authored beats present");
  assert.equal(run.openingSpeakerId, VOICE_NPC_ID, "the opening is attributed to her cast id");

  // THE MISSING DOOR. openingSpeakerId alone only fed a look-alike nameplate in the
  // narration log; the real VN surface gates on run.vn → scene.vnMode.
  assert.ok(run.vn && typeof run.vn === "object", "run.vn must be committed by the opening");
  assert.equal(run.vn.active, true, "the VN surface must be ACTIVE for the opening set-piece");
  assert.equal(run.vn.speakerId, VOICE_NPC_ID, "…and pointed at the VOICE, not left ambient");
});

test("V2: the scene payload carries the opening through the VN surface", async () => {
  const run = await babelRun();
  const payload = buildSoloScenePayload(run);

  // This is what the client's VN overlay gates on (renderSoloDialogueOverlay ←
  // state.dialogueActive ← scene.vnMode). Previously false for every opening.
  assert.equal(payload.vnMode, true, "vnMode must be true at the opening moment");
  assert.equal(payload.speakerId, VOICE_NPC_ID, "the VN speaker is the VOICE");

  // The opening speaker block still rides for the named frame.
  assert.ok(payload.openingSpeaker, "openingSpeaker present");
  assert.equal(payload.openingSpeaker.npcId, VOICE_NPC_ID);
  assert.equal(payload.openingSpeaker.displayName, "The VOICE");
});

test("V2: her portrait resolves through the REAL asset key (img_<id>_base), not the phantom one", async () => {
  const run = await babelRun();
  // Simulate her portrait having been cooked, in the EXACT shape the worker mints
  // (a partial asset fails schema validation and silently degrades the payload).
  const assetId = `img_${VOICE_NPC_ID}_base`;
  run.imageAssets = run.imageAssets || {};
  run.imageAssets[assetId] = {
    assetId,
    targetType: "npc",
    targetId: VOICE_NPC_ID,
    status: "generated",
    promptSummary: "style:anime",
    uri: "/data/assets/run_x/npc_voice/base.png",
    locked: false,
    version: 1,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    tags: [],
    flags: {},
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: []
  };
  if (run.npcs[VOICE_NPC_ID]) run.npcs[VOICE_NPC_ID].imageAssetId = assetId;

  const payload = buildSoloScenePayload(run);
  assert.equal(
    payload.openingSpeaker.portraitUri,
    "/data/assets/run_x/npc_voice/base.png",
    "the opening read `img_<npcId>` while assets mint as `img_<npcId>_base` — so her portrait was ALWAYS null"
  );
});

test("V2: no cooked portrait yet degrades honestly (named frame, no broken image)", async () => {
  const run = await babelRun();
  const payload = buildSoloScenePayload(run);
  assert.equal(payload.openingSpeaker.portraitUri, null, "uncooked art → null, never a broken uri");
  assert.equal(payload.openingSpeaker.displayName, "The VOICE", "still her named frame");
});
