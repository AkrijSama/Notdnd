import test from "node:test";
import assert from "node:assert/strict";

import { attributeSceneDialogue } from "../server/solo/gmProvider.js";

const npcs = [
  { npcId: "npc_grace", displayName: "Grace" },
  { npcId: "npc_han", displayName: "Doc Han" }
];

test("attributes each quoted line to the tagged present NPC (multi-NPC)", () => {
  const text = 'Grace says, "The road north is watched." Doc Han replies, "Then we go by the river."';
  const lines = attributeSceneDialogue(text, npcs);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].speakerId, "npc_grace");
  assert.equal(lines[0].kind, "npc");
  assert.equal(lines[0].text, "The road north is watched.");
  assert.equal(lines[1].speakerId, "npc_han");
  assert.equal(lines[1].speakerName, "Doc Han");
  assert.equal(lines[1].text, "Then we go by the river.");
});

test("attributes via a trailing tag ('said X') as well as a leading one", () => {
  const text = '"We should not linger," said Grace.';
  const lines = attributeSceneDialogue(text, npcs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speakerId, "npc_grace");
});

test("falls back to the SOLE present NPC when a line has no explicit tag", () => {
  const text = 'The door creaks open. "You came after all."';
  const lines = attributeSceneDialogue(text, [{ npcId: "npc_grace", displayName: "Grace" }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speakerId, "npc_grace");
  assert.equal(lines[0].kind, "npc");
});

test("marks an ungrounded tagged name as unknown (never invents a present NPC)", () => {
  const text = 'Someone in the crowd, Bartleby says, "Move along."';
  const lines = attributeSceneDialogue(text, npcs); // Bartleby is not present
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "unknown");
  assert.equal(lines[0].speakerId, null);
  assert.equal(lines[0].speakerName, "Bartleby"); // surfaced for the plate, flagged unknown
});

test("attributes a line to the player when the player's name is tagged", () => {
  const text = 'Elowen says, "I will not run."';
  const lines = attributeSceneDialogue(text, npcs, { playerName: "Elowen" });
  assert.equal(lines[0].kind, "player");
  assert.equal(lines[0].speakerName, "Elowen");
});

test("returns [] for narration with no quoted speech", () => {
  assert.deepEqual(attributeSceneDialogue("The wind moves through the empty hall.", npcs), []);
  assert.deepEqual(attributeSceneDialogue("", npcs), []);
});

test("two unattributed lines with two NPCs present stay unknown (no guessing)", () => {
  const text = '"First voice." Then, from the dark, "Second voice."';
  const lines = attributeSceneDialogue(text, npcs);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.kind === "unknown"));
});
