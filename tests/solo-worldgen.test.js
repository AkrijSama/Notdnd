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

test("default start (player + AI silent) = forest ruins usable as a base, not a crossroads", async () => {
  const world = await generateWorld({}); // nothing specified
  assert.equal(world.startingLocationType, "ruins", "default start type is ruins");
  assert.match(world.startingLocationName, /Ruins/, "default start name reads as ruins");
  assert.equal(world.startIsBaseable, true, "ruins start is flagged baseable");
  // Grounded in wilderness AND framed as an adoptable base.
  assert.match(world.startingLocation.description, /forest|wood|wilds|wastes|dead zone/i);
  assert.match(world.startingLocation.description, /base of your own|foothold/i);
});

test("an explicit starting location is never overridden by the forest-ruins default", async () => {
  const world = await generateWorld({
    tone: "dark fantasy",
    startingLocationName: "The Ember Tavern",
    startingLocationType: "tavern"
  });
  assert.equal(world.startingLocationType, "tavern");
  assert.equal(world.startingLocationName, "The Ember Tavern");
  assert.equal(world.startIsBaseable, false, "a tavern is not an adoptable base");
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
  // FIX C: a blank pronouns field defaults to he/him (owner default).
  assert.equal(run.player.pronouns, "he/him");

  const contact = run.npcs.npc_start_contact;
  assert.ok(contact, "starting contact created");
  assert.equal(contact.role, "Gate Warden"); // city gate -> Gate Warden
  assert.ok(contact.generatedName);

  // Opening narration is generated + stored so the player reads real prose on
  // entry (mock GM under NOTDND_MOCK_OPENROUTER, else the location fallback).
  assert.ok(typeof run.narration === "string" && run.narration.trim().length > 0, "opening narration stored");
});

test("createWorldOnboardingRun honors an explicit pronoun choice", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "pronoun@notdnd.local", password: "password123", displayName: "Pronoun Tester" });

  const result = await createWorldOnboardingRun(user.id, {
    world: { name: "Realm", tone: "grimdark", startingLocationName: "Gate", startingLocationType: "city gate", flavor: "rust" },
    character: {
      name: "Mira",
      pronouns: "she/her",
      race: "Human",
      characterClass: "Fighter",
      background: "Soldier",
      baseAbilityScores: { strength: 15, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 11, charisma: 8 }
    }
  });

  const run = getSoloRun(result.runId);
  assert.equal(run.player.pronouns, "she/her", "explicit pronouns are preserved, not overwritten by the default");
});

test("default run starts ALONE in the forest ruins — no unexplained starting NPC", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "alone@notdnd.local", password: "password123", displayName: "Alone Tester" });
  const result = await createWorldOnboardingRun(user.id, {
    world: {}, // blank -> forest-ruins default
    character: {
      name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal",
      baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 }
    }
  });
  const run = getSoloRun(result.runId);
  // Forest-ruins default applied.
  assert.match(run.locations.start_location.name, /Ruins/);
  assert.ok(run.locations.start_location.tags.includes("ruins"));
  // No contextless stranger: nobody is placed in the starting area.
  assert.equal(run.npcs.npc_start_contact, undefined, "no starting contact at an abandoned ruin");
  const atStart = Object.values(run.npcs).filter((n) => n.currentLocationId === "start_location");
  assert.equal(atStart.length, 0, "the player starts alone");
});

test("a self-evident venue (tavern) justifies a starting contact with a stated reason", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "venue@notdnd.local", password: "password123", displayName: "Venue Tester" });
  const result = await createWorldOnboardingRun(user.id, {
    world: { tone: "dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern" },
    character: {
      name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal",
      baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 }
    }
  });
  const run = getSoloRun(result.runId);
  const contact = run.npcs.npc_start_contact;
  assert.ok(contact, "a tavern self-evidently has a keeper present");
  assert.equal(contact.role, "Tavern Keeper");
  // Their presence is justified to the GM (introInstructions drives the intro directive).
  assert.match(contact.introInstructions, /Justify this character's presence/);
  assert.match(contact.introInstructions, /tends this tavern/);
});

test("an explicit module-placed starting NPC is honored only with a stated reason", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "module@notdnd.local", password: "password123", displayName: "Module Tester" });
  // Abandoned ruins (not self-evident) + an explicit reasoned placement.
  const placed = await createWorldOnboardingRun(user.id, {
    world: {
      tone: "dark fantasy", startingLocationName: "The Hollow Ruins", startingLocationType: "ruins",
      startingNpc: { role: "Fellow Scavenger", reason: "she has been picking through these ruins for salvage when you arrive" }
    },
    character: {
      name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal",
      baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 }
    }
  });
  const placedRun = getSoloRun(placed.runId);
  const contact = placedRun.npcs.npc_start_contact;
  assert.ok(contact, "explicit reasoned placement is honored");
  assert.equal(contact.role, "Fellow Scavenger");
  assert.match(contact.introInstructions, /picking through these ruins/);

  // Same ruins WITHOUT a reason -> still alone (no contextless stranger).
  resetDatabase();
  const { user: user2 } = registerUser({ email: "noreason@notdnd.local", password: "password123", displayName: "NoReason" });
  const bare = await createWorldOnboardingRun(user2.id, {
    world: { tone: "dark fantasy", startingLocationName: "The Hollow Ruins", startingLocationType: "ruins" },
    character: {
      name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal",
      baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 }
    }
  });
  assert.equal(getSoloRun(bare.runId).npcs.npc_start_contact, undefined, "ruins with no reason -> alone");
});

// ─────────────────────────────────────────────────────────────────────────────
// C.5 — a SANDBOX run does NOT inject the procedural quarry-quest (owner decision
// (a): zero authored objective). Campaign runs still get their directed spine.
// Stop CREATING the dead record upstream, not just suppressing it downstream.
// ─────────────────────────────────────────────────────────────────────────────
test("CAMPAIGN run (default mode) still injects the procedural main quest", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "camp@notdnd.local", password: "password123", displayName: "Camp" });
  const result = await createWorldOnboardingRun(user.id, {
    world: { name: "Realm", tone: "grimdark", startingLocationName: "Gate", startingLocationType: "city gate", flavor: "rust" },
    character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } }
  });
  const run = getSoloRun(result.runId);
  assert.equal(run.mode, "campaign", "default run is campaign mode");
  assert.ok(run.quests.quest_main, "campaign run has the directed main quest");
  assert.equal(run.quests.quest_main.isMain, true);
});

test("SANDBOX run creates NO quest_main and no quest-linked spine NPCs (and stays schema-valid)", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "sand@notdnd.local", password: "password123", displayName: "Sand" });
  const result = await createWorldOnboardingRun(user.id, {
    world: { name: "Realm", tone: "grimdark", startingLocationName: "Gate", startingLocationType: "city gate", flavor: "rust" },
    character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } },
    mode: "sandbox"
  });
  const run = getSoloRun(result.runId);
  assert.equal(run.mode, "sandbox", "run is flagged sandbox");
  assert.equal(run.quests.quest_main, undefined, "NO procedural quarry-quest injected");
  assert.equal(Object.keys(run.quests || {}).length, 0, "sandbox starts with zero authored objectives");
  // The quest-linked procedural contacts are not created (no dangling linkedQuestIds).
  assert.equal(run.npcs.npc_quest_giver, undefined, "no directed quest-giver in a sandbox");
  assert.equal(run.npcs.npc_far_witness, undefined, "no directed far-witness in a sandbox");
  // The run still opens with real prose (open-world, no objective hook).
  assert.ok(typeof run.narration === "string" && run.narration.trim().length > 0, "sandbox opening narration still generated");
});
