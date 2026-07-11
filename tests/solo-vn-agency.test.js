import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { classifyNarrationVn, attributeSceneDialogue } from "../server/solo/gmProvider.js";

// vn-trigger-agency (owner 2026-07-11): the VN overlay opened without the player
// choosing to talk — a courier arrival beat naming a present NPC ("Ilse") auto-
// hijacked the dialogue with a never-met speaker. The AGENCY RULE: the VN opens
// ONLY from player-initiated conversation; world events near the player render
// as narration in the log. resolveSoloAction is now the SOLE authority on run.vn
// (the free-text narration auto-promotion was removed from the route).

const TEST_NOW = "2026-01-01T00:00:00.000Z";
function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}
function addNpc(run, npcId, displayName) {
  run.npcs[npcId] = {
    npcId,
    displayName,
    role: "Neutral present NPC",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: []
  };
  return run;
}

// (a) A momentum/world-event narration (a courier arriving, naming a present NPC
//     with quoted speech) must NOT open VN when the player took a non-talk action.
test("AGENCY: a world-event beat naming a present NPC does NOT auto-open VN on a non-talk turn", () => {
  const run = addNpc(createDefaultSoloRun({ runId: "vn_agency_event", now: TEST_NOW }), "npc_ilse", "Ilse");
  const presentNpcs = [{ npcId: "npc_ilse", displayName: "Ilse" }];
  // The EXACT bug narration: a courier bursts in and addresses/names Ilse. Under
  // the OLD trigger classifyNarrationVn returns active (quoted speech + one named
  // present NPC) — proving the beat *would* have hijacked the VN.
  const courierBeat = 'A courier bursts through the door, breathless. "Garrick sent me — Ilse, the cordon is broken!" he shouts, then is gone.';
  assert.equal(classifyNarrationVn(courierBeat, presentNpcs).active, true, "the old classifier WOULD have fired on this beat");

  // The player did NOT talk to anyone — a plain move. resolveSoloAction (the sole
  // VN authority) keeps the scene ambient: no auto-opened dialogue.
  const resolved = resolveSoloAction(
    run,
    { type: "move", actorId: "player", fromLocationId: "start_location", toLocationId: "second_location", direction: "east" },
    { now: TEST_NOW, idFactory: idFactory() }
  );
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.run.vn, { active: false, speakerId: null }, "VN stays closed — world events are narration, not an auto-opened dialogue");
});

// (b) A player talk action opens VN with the ADDRESSED NPC (speaker rule).
test("AGENCY + SPEAKER: a player talk action opens VN with the NPC the player addressed", () => {
  const run = addNpc(
    addNpc(createDefaultSoloRun({ runId: "vn_agency_talk", now: TEST_NOW }), "npc_marta", "Old Marta"),
    "npc_ilse",
    "Ilse"
  );
  const resolved = resolveSoloAction(
    run,
    { type: "talk", actorId: "player", targetEntityId: "npc:npc_marta" },
    { now: TEST_NOW, idFactory: idFactory() }
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.npcId, "npc_marta");
  // The speaker is the one addressed — never a substitute (never Ilse).
  assert.deepEqual(resolved.run.vn, { active: true, speakerId: "npc_marta" });
});

// (c) SCOPE: a GM response mixing the speaker's dialogue with a multi-actor scene
//     beat splits — the addressed speaker's line attributes to THEM (→ VN box);
//     the other-actor scene beat attributes elsewhere (→ narration log).
test("SCOPE: speaker dialogue and a multi-actor scene beat split by attribution", () => {
  const presentNpcs = [{ npcId: "npc_marta", displayName: "Old Marta" }];
  const mixed = 'Marta leans close. "The key is under the third floorboard," she says. Then a courier bursts in and shouts to Garrick across the room.';
  const lines = attributeSceneDialogue(mixed, presentNpcs, { playerName: "Wanderer" });
  // The addressed speaker's dialogue line is attributed to her (routes to the VN box).
  const martaLine = lines.find((l) => l.kind === "npc" && l.speakerId === "npc_marta");
  assert.ok(martaLine, "the speaker's own dialogue is attributed to the speaker");
  assert.match(martaLine.text, /third floorboard/);
  // The courier/Garrick scene beat is NOT attributed to Marta — it is not her
  // dialogue, so it never rides the VN box under her nameplate (routes to the log).
  assert.ok(
    !lines.some((l) => l.speakerId === "npc_marta" && /Garrick/.test(l.text)),
    "the multi-actor scene beat is not attributed to the VN speaker"
  );
});
