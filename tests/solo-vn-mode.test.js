import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSoloRun,
  createDefaultVnState,
  normalizeVnState,
  validateSoloRun
} from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { buildSoloScenePayload, validateSoloScenePayload } from "../server/solo/scene.js";
import { deriveVnState, resolveGmNarration } from "../server/solo/gmProvider.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

// Adds a visible, talkable NPC at the run's starting location, mirroring the
// fixture used by the talk-action tests.
function addTalkableNpc(run) {
  run.npcs.placeholder_npc = {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder NPC",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    dialogueBeats: [
      {
        beatId: "quiet_area",
        label: "Quiet Area",
        text: "There is not much to say yet, but the area has been quiet.",
        revealed: false,
        repeatable: false,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        edition: run.edition,
        policyProfileId: run.policyProfileId
      }
    ]
  };
  return run;
}

function validProviderOutput(body = "Provider narration.") {
  return {
    ok: true,
    narration: {
      title: "Start Location",
      body,
      tone: "mysterious",
      sensoryDetails: ["quiet air"],
      focusEntityIds: ["location:start_location"]
    },
    suggestedActionLabels: ["Inspect area"],
    warnings: [],
    stateMutations: []
  };
}

// ---------------------------------------------------------------------------
// schema: VN state shape, factory, normalizer, run default + validation
// ---------------------------------------------------------------------------

test("createDefaultVnState is ambient", () => {
  assert.deepEqual(createDefaultVnState(), { active: false, speakerId: null });
});

test("normalizeVnState collapses malformed input to ambient", () => {
  assert.deepEqual(normalizeVnState(undefined), { active: false, speakerId: null });
  assert.deepEqual(normalizeVnState(null), { active: false, speakerId: null });
  assert.deepEqual(normalizeVnState("nope"), { active: false, speakerId: null });
  assert.deepEqual(normalizeVnState({ active: "yes", speakerId: 7 }), { active: false, speakerId: null });
});

test("normalizeVnState keeps a speaker only while active", () => {
  assert.deepEqual(normalizeVnState({ active: true, speakerId: "npc_a" }), { active: true, speakerId: "npc_a" });
  assert.deepEqual(normalizeVnState({ active: true, speakerId: "" }), { active: true, speakerId: null });
  assert.deepEqual(normalizeVnState({ active: false, speakerId: "npc_a" }), { active: false, speakerId: null });
});

test("a fresh run starts ambient and validates", () => {
  const run = createDefaultSoloRun({ runId: "vn_default", now: TEST_NOW });
  assert.deepEqual(run.vn, { active: false, speakerId: null });
  assert.equal(validateSoloRun(run).ok, true);
});

test("validateSoloRun tolerates an absent vn but rejects a malformed one", () => {
  const run = createDefaultSoloRun({ runId: "vn_validate", now: TEST_NOW });
  delete run.vn; // a run that predates the field stays valid
  assert.equal(validateSoloRun(run).ok, true);

  run.vn = { active: "true", speakerId: 5 };
  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "vn.active"));
});

// ---------------------------------------------------------------------------
// gmProvider: deriveVnState classifier (the GM-driven trigger)
// ---------------------------------------------------------------------------

test("deriveVnState defaults to ambient when vnMode is missing or false", () => {
  assert.deepEqual(deriveVnState({}), { active: false, speakerId: null });
  assert.deepEqual(deriveVnState({ vnMode: false, speakerId: "npc_a" }), { active: false, speakerId: null });
  assert.deepEqual(deriveVnState(null), { active: false, speakerId: null });
});

test("deriveVnState activates for a direct exchange with a present NPC", () => {
  const vn = deriveVnState(
    { vnMode: true, speakerId: "npc:tavern_keeper" },
    { knownNpcIds: ["npc:tavern_keeper", "tavern_keeper"] }
  );
  assert.deepEqual(vn, { active: true, speakerId: "npc:tavern_keeper" });
});

test("deriveVnState demotes a hallucinated speaker to ambient", () => {
  const vn = deriveVnState(
    { vnMode: true, speakerId: "npc:ghost_who_isnt_here" },
    { knownNpcIds: ["npc:tavern_keeper"] }
  );
  assert.deepEqual(vn, { active: false, speakerId: null });
});

test("deriveVnState matches a known id across the npc: prefix", () => {
  // Known set holds only the raw id; a prefixed speaker still matches.
  assert.deepEqual(
    deriveVnState({ vnMode: true, speakerId: "npc:keeper" }, { knownNpcIds: ["keeper"] }),
    { active: true, speakerId: "npc:keeper" }
  );
});

test("deriveVnState trusts the speaker when no known set is supplied", () => {
  assert.deepEqual(deriveVnState({ vnMode: true, speakerId: "npc_x" }), { active: true, speakerId: "npc_x" });
});

// ---------------------------------------------------------------------------
// scene payload: surfaces the VN signal
// ---------------------------------------------------------------------------

test("scene payload exposes ambient VN by default", () => {
  const run = createDefaultSoloRun({ runId: "vn_scene_default", now: TEST_NOW });
  const payload = buildSoloScenePayload(run);
  assert.equal(payload.ok, true);
  assert.equal(payload.vnMode, false);
  assert.equal(payload.speakerId, null);
  assert.equal(validateSoloScenePayload(payload).ok, true);
});

test("scene payload reflects an active VN scene state", () => {
  const run = createDefaultSoloRun({ runId: "vn_scene_active", now: TEST_NOW });
  run.vn = { active: true, speakerId: "placeholder_npc" };
  const payload = buildSoloScenePayload(run);
  assert.equal(payload.vnMode, true);
  assert.equal(payload.speakerId, "placeholder_npc");
  assert.equal(validateSoloScenePayload(payload).ok, true);
});

// ---------------------------------------------------------------------------
// action dispatcher: the manual talk trigger + ambient reset
// ---------------------------------------------------------------------------

test("a talk action sets direct VN scene state on the produced run", () => {
  const run = addTalkableNpc(createDefaultSoloRun({ runId: "vn_talk", now: TEST_NOW }));
  const resolved = resolveSoloAction(
    run,
    { type: "talk", actorId: "player", targetEntityId: "npc:placeholder_npc" },
    { now: TEST_NOW, idFactory: idFactory() }
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.npcId, "placeholder_npc");
  assert.deepEqual(resolved.run.vn, { active: true, speakerId: "placeholder_npc" });
});

test("a non-talk action resets VN to ambient without mutating the input run", () => {
  const run = addTalkableNpc(createDefaultSoloRun({ runId: "vn_reset", now: TEST_NOW }));
  // Pretend the run is mid-dialogue.
  run.vn = { active: true, speakerId: "placeholder_npc" };
  const before = clone(run);

  const resolved = resolveSoloAction(
    run,
    { type: "move", actorId: "player", fromLocationId: "start_location", toLocationId: "second_location", direction: "east" },
    { now: TEST_NOW, idFactory: idFactory() }
  );
  assert.equal(resolved.ok, true);
  // The produced run returns to ambient prose...
  assert.deepEqual(resolved.run.vn, { active: false, speakerId: null });
  // ...while the shared input run is left untouched (no read-side mutation).
  assert.deepEqual(run.vn, before.vn);
});

// ---------------------------------------------------------------------------
// gmProvider end-to-end: VN signal on resolveGmNarration output
// ---------------------------------------------------------------------------

test("resolveGmNarration placeholder carries an ambient VN signal", async () => {
  const scene = buildSoloScenePayload(createDefaultSoloRun({ runId: "vn_gm_placeholder", now: TEST_NOW }));
  const narration = await resolveGmNarration(scene, { mode: "placeholder" });
  assert.equal(narration.ok, true);
  assert.equal(narration.vnMode, false);
  assert.equal(narration.speakerId, null);
});

test("resolveGmNarration surfaces a GM-driven direct VN exchange with a present NPC", async () => {
  const run = addTalkableNpc(createDefaultSoloRun({ runId: "vn_gm_direct", now: TEST_NOW }));
  const scene = buildSoloScenePayload(run);
  const speaker = scene.visibleEntities.find((entity) => entity.entityType === "npc");
  assert.ok(speaker, "expected a visible npc in the scene");

  const narration = await resolveGmNarration(scene, {
    providerEnabled: true,
    providerFn: async () =>
      JSON.stringify({
        ...validProviderOutput("The keeper leans in and speaks only to you."),
        vnMode: true,
        speakerId: speaker.entityId
      })
  });
  assert.equal(narration.ok, true);
  assert.equal(narration.vnMode, true);
  assert.equal(narration.speakerId, speaker.entityId);
});

test("resolveGmNarration keeps ambient chatter as prose", async () => {
  const scene = buildSoloScenePayload(addTalkableNpc(createDefaultSoloRun({ runId: "vn_gm_ambient", now: TEST_NOW })));
  const narration = await resolveGmNarration(scene, {
    providerEnabled: true,
    providerFn: async () =>
      JSON.stringify({
        ...validProviderOutput("Voices murmur across the crowded room, none of them meant for you."),
        vnMode: false,
        speakerId: null
      })
  });
  assert.equal(narration.ok, true);
  assert.equal(narration.vnMode, false);
  assert.equal(narration.speakerId, null);
});

test("resolveGmNarration demotes a GM-named speaker that is not in the scene", async () => {
  // No NPCs in the scene, so any named speaker is unanchored.
  const scene = buildSoloScenePayload(createDefaultSoloRun({ runId: "vn_gm_hallucinated", now: TEST_NOW }));
  const narration = await resolveGmNarration(scene, {
    providerEnabled: true,
    providerFn: async () =>
      JSON.stringify({
        ...validProviderOutput("A stranger who was never here turns to address you."),
        vnMode: true,
        speakerId: "npc:not_in_scene"
      })
  });
  assert.equal(narration.ok, true);
  assert.equal(narration.vnMode, false);
  assert.equal(narration.speakerId, null);
});
