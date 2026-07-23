// JOB 1 — the chaosling/violet corruption identity is WORLD-BOOK DATA (world.corruption), not
// engine law. Babel declares chaosling/violet (byte-identical); a world declaring NOTHING gets a
// NEUTRAL threat: no chaosling, no violet, essence-sight SILENT. Both doors carry world.corruption.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { mintChaosling, spawnChaosling, registerStatBlock, CHAOSLING_CORRUPTION, NEUTRAL_CORRUPTION, resolveCorruptionIdentity, sightReadableSkills } from "../server/campaign/bestiary.js";
import { readableEnemiesAt } from "../server/solo/essence.js";

test("GATE(1.5 babel byte-identical): babel's authored world.corruption mints IDENTICAL to the engine chaosling default", () => {
  const babelCorruption = loadScenarioFile("babel").world.corruption;
  assert.ok(babelCorruption, "babel authors world.corruption in its world-book");
  const viaBook = mintChaosling("grey_wolf", 1, "golden_seed", resolveCorruptionIdentity(babelCorruption));
  const viaEngineDefault = mintChaosling("grey_wolf", 1, "golden_seed"); // CHAOSLING_CORRUPTION default = pre-migration
  assert.deepEqual(viaBook, viaEngineDefault, "babel's book reproduces the engine chaosling mint BYTE-IDENTICAL");
  // ...and it IS the chaosling identity (the golden values).
  assert.equal(viaBook.kind, "chaosling");
  assert.equal(viaBook.corruption.palette, "violet");
  assert.match(viaBook.corruption.artFragment, /violet/);
  assert.ok(viaBook.tags.includes("chaosling") && viaBook.tags.includes("corrupted"));
  assert.match(viaBook.name, /^Chaos-/);
});

test("1.2 (both doors): world.corruption reaches run.world via scenarioLoader AND compileWorldBook", () => {
  const run = createDefaultSoloRun({ runId: "corr_json" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  assert.equal(run.world.corruption?.kind, "chaosling", "JSON door carries world.corruption");
  // creator door: a world-book declaring corruption compiles + loads it.
  const { scenario } = compileWorldBook({ name: "Neon City", identity: { name: "Neon City", tone: "cyberpunk" }, vibe: "x", world: { corruption: { kind: "nano-blight", palette: "acid-green", chaosSkills: false } } });
  assert.equal(scenario.world.corruption?.kind, "nano-blight", "creator door emits world.corruption");
  const run2 = createDefaultSoloRun({ runId: "corr_creator" });
  loadScenarioIntoRun(run2, scenario, {});
  assert.equal(run2.world.corruption?.kind, "nano-blight", "creator-authored corruption reaches run.world");
});

test("GATE(1.6 neutral): a world declaring NO corruption mints a plain threat — no chaosling, no violet, essence-sight SILENT", () => {
  const neutral = mintChaosling("grey_wolf", 1, "seed", NEUTRAL_CORRUPTION);
  assert.notEqual(neutral.kind, "chaosling", "neutral threat is not a chaosling");
  assert.equal(neutral.corruption, undefined, "no violet corruption field at all");
  assert.deepEqual(neutral.carriedSkills, [], "no chaos skills");
  assert.equal(neutral.sightReadable, false, "not sight-readable");
  assert.ok(!neutral.tags.includes("chaosling") && !neutral.tags.includes("corrupted"), "no chaos tags");
  assert.doesNotMatch(neutral.name, /^Chaos-/, "no Chaos- name prefix");
  // a world that AUTHORED nothing resolves to exactly this neutral mint.
  assert.deepEqual(mintChaosling("grey_wolf", 1, "seed", resolveCorruptionIdentity(undefined)), neutral);
});

test("1.4: essence-sight is SILENT for a neutral threat, and reads the chaosling (babel byte-identical)", () => {
  // At a tier where the chaosling carries chaos skills, essence-sight reads the chaosling but stays
  // SILENT on the neutral threat — the ONLY difference is world.corruption (chaosSkills true vs false).
  const neutral = mintChaosling("grey_wolf", 3, "seed", NEUTRAL_CORRUPTION);
  const chaosling = mintChaosling("grey_wolf", 3, "seed"); // default chaosling, same base+tier+seed
  assert.ok(sightReadableSkills(chaosling).length >= 1, "the chaosling IS sight-readable (unchanged)");
  assert.deepEqual(sightReadableSkills(neutral), [], "neutral threat → sightReadableSkills [] → essence-sight has nothing to read");
});

test("1.4 (player door): scene.sight.readableEnemies is SILENT for a neutral-world foe, reads a chaos foe", () => {
  // The player-facing essence-sight surface (scene.sight.readableEnemies ← readableEnemiesAt).
  const chaos = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 3, seed: "chaos_e" }); // default CHAOSLING
  const neutral = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 3, seed: "neutral_e", corruption: NEUTRAL_CORRUPTION });
  registerStatBlock(chaos);
  registerStatBlock(neutral);
  const mkRun = (block) => ({ npcs: { f: { npcId: "f", currentLocationId: "loc", status: "present", statBlockId: block.statBlockId, flags: { statBlockId: block.statBlockId } } } });
  assert.ok(readableEnemiesAt(mkRun(chaos), "loc").length >= 1, "chaos foe is read by essence-sight");
  assert.deepEqual(readableEnemiesAt(mkRun(neutral), "loc"), [], "neutral foe → essence-sight SILENT (the player sees nothing)");
});

test("a world can declare a DIFFERENT corruption identity (its own kind/palette, no chaos skills)", () => {
  const acid = resolveCorruptionIdentity({ kind: "nano-blight", namePrefix: "Blighted ", palette: "acid-green", extraTags: ["blighted"], chaosSkills: false, markers: { 1: "faint acid-green veins" } });
  const mint = mintChaosling("grey_wolf", 1, "seed", acid);
  assert.equal(mint.kind, "nano-blight");
  assert.equal(mint.corruption.palette, "acid-green");
  assert.match(mint.corruption.artFragment, /acid-green/);
  assert.match(mint.name, /^Blighted /);
  assert.ok(mint.tags.includes("blighted") && !mint.tags.includes("chaosling"));
  assert.deepEqual(mint.carriedSkills, [], "no chaos skills → essence-sight silent for this world too");
});
