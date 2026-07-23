// THE CYBERPUNK ACCEPTANCE TEST (the real deliverable of the two-blocker dispatch).
//
// A non-Babel world, built through the CREATOR door (compileWorldBook — how a cyberpunk world is
// actually made), declaring its OWN rank ladder, status sheet, threat ladder, and NO corruption.
// It must get NONE of Babel's welded identity and ALL of its own:
//   • no chaosling / no violet / essence-sight SILENT   (JOB 1)
//   • its own rank ladder, not E→DG                      (JOB 2.1)
//   • its own diegetic status sheet, not the D&D fallback (JOB 2.2)
//   • its own threat ladder driving the minted encounter (JOB 2.3)
// Any Babel fallback here = not done.
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { readableEnemiesAt } from "../server/solo/essence.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";
import { characterFromScenePlayer } from "../src/components/soloSceneShell.js";

// A cyberpunk world-book. rankLadder + sheetSpec ride world.* (CARRIED_WORLD_KEYS); threatLadder
// rides top-level; NO world.corruption is declared (→ neutral threat, no violet).
function neonBook(threatLadder = { "feral hound-drone": "common", "corp-sec": "uncommon", "black ICE": "very-rare" }) {
  return {
    name: "Neon Divide",
    vibe: "a drowned megacity of chrome and rain",
    identity: { name: "Neon Divide", tone: "cyberpunk", genre: "cyberpunk" },
    threatLadder,
    world: {
      variant: "neon", // explicitly NOT "babel"
      rankLadder: ["Civ", "Runner", "Operator", "Ghost", "Legend"],
      sheetSpec: {
        family: "generic", windowTitle: "DECK", showRank: true, showRankedSkills: true,
        statLabels: [
          { label: "BODY", ability: "strength" },
          { label: "REFLEX", ability: "dexterity" },
          { label: "TECH", ability: "intelligence" },
          { label: "COOL", ability: "charisma" }
        ]
      }
      // NO corruption
    }
  };
}

function loadNeon(book = neonBook()) {
  const { scenario, validation } = compileWorldBook(book);
  assert.equal(validation.ok, true, `neon compiles+validates: ${JSON.stringify(validation.errors?.slice(0, 3))}`);
  const run = createDefaultSoloRun({ runId: "neon_run" });
  loadScenarioIntoRun(run, scenario, { worldSeed: "neon_seed" });
  return { scenario, run };
}

test("JOB 1 — no corruption declared → NEUTRAL threat: no chaosling, no violet, essence-sight SILENT", () => {
  const { scenario, run } = loadNeon();
  assert.equal(run.world.corruption, undefined, "no corruption identity leaks into a world that declared none");
  const block = Object.values(scenario.bestiary.statBlocks || {})[0];
  assert.equal(block.kind, "beast", "the tier-1 threat is a neutral beast, not a chaosling");
  assert.equal(block.corruption, undefined, "no violet corruption on the block");
  assert.ok(!block.tags.includes("chaosling") && !block.tags.includes("corrupted"), "no chaos tags");
  assert.doesNotMatch(block.name, /^Chaos-/, "no Chaos- prefix");
  // essence-sight SILENT: the placed hostile reads as nothing (no sight-readable chaos skills).
  const hostile = Object.values(run.npcs).find((n) => n.flags?.hostile);
  assert.ok(hostile && resolveStatBlock(hostile.statBlockId), "the minted threat is placed + resolvable");
  run.currentLocationId = hostile.currentLocationId;
  assert.deepEqual(readableEnemiesAt(run, hostile.currentLocationId), [], "essence-sight has nothing to read on a neutral world");
});

test("JOB 2.1 — the world's OWN rank ladder drives the readout, not Babel's E→DG", () => {
  const { run } = loadNeon();
  assert.deepEqual(run.world.rankLadder, ["Civ", "Runner", "Operator", "Ghost", "Legend"], "the cyberpunk ladder reaches run.world");
  // a top-rung ranked skill resolves to the world's top rung ("Legend"), never Babel's "A"/"S".
  run.player.babelSkills = [5];
  const rank = buildSoloScenePayload(run).player.rank;
  assert.equal(rank, "Legend", "rank reads the cyberpunk ladder (E→DG would give 'A')");
  assert.ok(!["E", "D", "C", "B", "A", "S", "SS", "SSS", "DG"].includes(rank), "no Babel rung leaks");
});

test("JOB 2.2 — the world's OWN diegetic status sheet renders, not the D&D fallback", () => {
  const { run } = loadNeon();
  const payload = buildSoloScenePayload(run);
  // server: the diegetic fields emit because a sheetSpec is declared (not because it's babel).
  assert.notEqual(payload.player.rank, null, "the diegetic sheet emits a rank (sheetSpec-gated)");
  assert.equal(payload.player.babelStats, null, "the babel-family stat spine does NOT leak into a generic-family sheet");
  // client: the diegetic WINDOW renders (not the D&D sheet), relabeled by the world's statLabels.
  const character = characterFromScenePlayer(payload.player, run.world);
  assert.ok(character.babel, "the diegetic status WINDOW renders (not null → not the D&D fallback)");
  const statKeys = character.babel.stats.map((s) => s.key);
  assert.deepEqual(statKeys, ["BODY", "REFLEX", "TECH", "COOL"], "the sheet shows the world's OWN stat labels, not STR/DEX/VIT/…");
});

test("JOB 2.2 — a world with NO sheetSpec falls to the D&D sheet (the neutral default)", () => {
  const { scenario } = loadNeon();
  delete scenario.world.sheetSpec;
  const run = createDefaultSoloRun({ runId: "neon_nosheet" });
  loadScenarioIntoRun(run, scenario, { worldSeed: "s" });
  const character = characterFromScenePlayer(buildSoloScenePayload(run).player, run.world);
  assert.equal(character.babel, null, "no sheetSpec → the default D&D sheet (character.babel null)");
});

test("JOB 2.3 — the world's OWN threat ladder drives which creature the encounter mints", () => {
  // The common rung names the tier-1 threat; a hound-drone ladder mints a wolf chassis…
  const hound = Object.values(loadNeon(neonBook({ "feral hound-drone": "common" })).scenario.bestiary.statBlocks)[0];
  assert.match(hound.name, /wolf/i, "a 'hound-drone' common threat maps to the wolf chassis");
  // …and a bear-thing ladder mints a bear chassis — the SAME world, only the ladder changed.
  const bear = Object.values(loadNeon(neonBook({ "feral bear-thing": "common" })).scenario.bestiary.statBlocks)[0];
  assert.match(bear.name, /bear/i, "a 'bear-thing' common threat maps to the bear chassis");
  assert.notEqual(hound.name, bear.name, "a different threat ladder mints a different encounter");
});
