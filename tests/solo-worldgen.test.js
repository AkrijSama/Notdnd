import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-worldgen-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "world.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";
delete process.env.OPENAI_API_KEY;

const { generateWorld } = await import("../server/solo/worldGen.js");
const { buildCharacter, toRunPlayer } = await import("../server/solo/characterBuild.js");
const { buildPlayerPayload } = await import("../server/solo/scene.js");
const { initializeDatabase, resetDatabase, registerUser, getSoloRun } = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");

test("generateWorld fills every blank field offline (deterministic fallback)", async () => {
  const world = await generateWorld({});
  for (const field of ["name", "tone", "startingLocationName", "startingLocationType", "flavor", "description"]) {
    assert.ok(typeof world[field] === "string" && world[field].trim().length > 0, `missing ${field}`);
  }
  assert.ok(world.startingLocation.name && world.startingLocation.description);
  assert.ok(["illustrated", "anime", "cinematic"].includes(world.artStyle));
});

test("generateWorld keeps player-provided fields verbatim", async () => {
  const world = await generateWorld({
    name: "The Test Realm",
    tone: "grimdark",
    startingLocationName: "Iron Gate",
    startingLocationType: "city gate",
    flavor: "A broken empire of rust and oaths",
    artStyle: "anime"
  });
  assert.equal(world.name, "The Test Realm");
  assert.equal(world.tone, "grimdark");
  assert.equal(world.startingLocationName, "Iron Gate");
  assert.equal(world.artStyle, "anime");
  assert.equal(world.startingLocation.name, "Iron Gate");
});

test("toRunPlayer projects the 5e character onto run.player", () => {
  const built = buildCharacter({
    name: "Kael",
    race: "Elf",
    characterClass: "Ranger",
    background: "Outlander",
    baseAbilityScores: { strength: 12, dexterity: 15, constitution: 13, intelligence: 10, wisdom: 14, charisma: 8 }
  });
  const player = toRunPlayer(built, {
    playerId: "player",
    displayName: "Player",
    abilities: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 },
    resources: { hitPoints: { current: 10, max: 10 }, stamina: { current: 6, max: 6 } }
  });
  assert.equal(player.displayName, "Kael");
  assert.equal(player.characterClass, "Ranger");
  assert.equal(player.race, "Elf");
  assert.equal(player.abilities.dexterity, 17); // 15 + Elf +2
  assert.equal(player.resources.hitPoints.max, built.derivedStats.maxHp);
  assert.equal(player.character.race, "Elf");
});

test("buildPlayerPayload surfaces the 5e character + derived AC/speed", () => {
  const built = buildCharacter({
    name: "Kael",
    race: "Elf",
    characterClass: "Ranger",
    background: "Outlander",
    baseAbilityScores: { strength: 12, dexterity: 15, constitution: 13, intelligence: 10, wisdom: 14, charisma: 8 }
  });
  const player = toRunPlayer(built, { displayName: "Player", abilities: {}, resources: {} });
  const payload = buildPlayerPayload({ player });
  assert.equal(payload.displayName, "Kael");
  assert.equal(payload.race, "Elf");
  assert.ok(payload.character);
  assert.equal(payload.armorClass, 13); // 10 + DEX(17 -> +3)
  assert.equal(payload.speed, 30); // Elf
});

test("createWorldOnboardingRun builds a run from world + character", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "world@notdnd.local", password: "password123", displayName: "World Tester" });

  const result = await createWorldOnboardingRun(user.id, {
    world: {
      name: "The Test Realm",
      tone: "grimdark",
      startingLocationName: "Iron Gate",
      startingLocationType: "city gate",
      flavor: "A broken empire of rust and oaths",
      artStyle: "anime"
    },
    character: {
      name: "Kael",
      race: "Elf",
      characterClass: "Ranger",
      background: "Outlander",
      baseAbilityScores: { strength: 12, dexterity: 15, constitution: 13, intelligence: 10, wisdom: 14, charisma: 8 }
    }
  });

  assert.ok(result.campaignId && result.runId);
  assert.equal(result.world.name, "The Test Realm");

  const run = getSoloRun(result.runId);
  assert.equal(run.campaignId, result.campaignId);
  assert.equal(run.world.name, "The Test Realm");
  assert.equal(run.world.tone, "grimdark");
  assert.equal(run.world.artStyle, "anime");
  assert.equal(run.locations.start_location.name, "Iron Gate");
  assert.equal(run.player.displayName, "Kael");
  assert.equal(run.player.character.race, "Elf");
  assert.equal(run.player.character.class, "Ranger");

  const contact = run.npcs.npc_start_contact;
  assert.ok(contact, "starting contact created");
  assert.equal(contact.role, "Gate Warden"); // city gate -> Gate Warden
  assert.ok(contact.generatedName);

  // Opening narration is generated + stored so the player reads real prose on
  // entry (mock GM under NOTDND_MOCK_OPENROUTER, else the location fallback).
  assert.ok(typeof run.narration === "string" && run.narration.trim().length > 0, "opening narration stored");
});
