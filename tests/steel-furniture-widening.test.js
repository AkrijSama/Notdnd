// STEEL/FURNITURE WIDENING + LEDGERED-BUG NET (stage 3, 2026-07-21).
//
// The audit's GOVERNING FINDING: scenarioLoader's world whitelist carried only
// scalar strings, so every OBJECT/ARRAY world knob authored on scenario.world was
// silently dropped at load. This net locks:
//   1. WIDENING — object/array world slots now survive into run.world (the
//      reachability half of a planned gate; a future consumer reads run.world.<slot>).
//   2. DEAD SLOT → REAL CONSUMER — babel.deathLaw.epilogue reaches run.world.
//   3-6. FOUR LEDGERED BUGS — factions.wants read, front reputationEffects carry,
//      essenceTrail illegal band removed, artStyleOptions.allowed binding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { relevantFactionId } from "../server/solo/goalDoors.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
function baseRun() {
  const run = createDefaultSoloRun({ now: T(0), runId: "sf_fixed" });
  run.worldSeed = "sf_fixed";
  return run;
}
function loadBabel(mutate) {
  const scenario = JSON.parse(JSON.stringify(loadScenarioFile("babel")));
  if (mutate) mutate(scenario);
  const run = baseRun();
  loadScenarioIntoRun(run, scenario, {});
  return run;
}

// ── 1. WIDENING — object/array world knobs survive load (planned-gate reachability) ──
test("WIDENING: authored object/array world slots reach run.world (were silently dropped)", () => {
  const orientationMix = { straight: 0.7, gay: 0.15, bi: 0.15 };
  const systemLore = { cosmology: "the Tower keeps a hundred floors" };
  const playerSense = { grantsCombatFocus: true };
  const suggestionExemplars = ["Ask Grace what a license buys"];
  const run = loadBabel((s) => {
    s.world.orientationMix = orientationMix;
    s.world.systemLore = systemLore;
    s.world.playerSense = playerSense;
    s.world.suggestionExemplars = suggestionExemplars;
    s.world.sightAccent = "#123456";
  });
  assert.deepEqual(run.world.orientationMix, orientationMix, "orientationMix must survive the loader whitelist");
  assert.deepEqual(run.world.systemLore, systemLore, "systemLore must survive");
  assert.deepEqual(run.world.playerSense, playerSense, "playerSense must survive");
  assert.deepEqual(run.world.suggestionExemplars, suggestionExemplars, "array slots must survive");
  assert.equal(run.world.sightAccent, "#123456", "scalar sightAccent must survive");
});

test("WIDENING: nameBanks (compile-time-only dead slot) is now reachable at runtime on run.world", () => {
  const run = loadBabel();
  assert.ok(run.world.nameBanks && Array.isArray(run.world.nameBanks.people), "babel's nameBanks must reach run.world");
  assert.ok(run.world.nameBanks.people.includes("Odile"), "the authored people bank must be readable at runtime");
});

test("WIDENING: a bare world (no object slots authored) rides through unchanged", () => {
  const run = loadBabel((s) => {
    delete s.world.nameBanks;
    delete s.world.deathLaw;
  });
  assert.equal(run.world.nameBanks, undefined, "an unauthored slot must not be invented");
  assert.equal(run.world.deathLaw, undefined, "an unauthored slot must not be invented");
});

// ── 2. DEAD SLOT → REAL CONSUMER: deathLaw.epilogue reaches run.world ──
test("DEAD SLOT deathLaw: babel's authored death-law epilogue reaches run.world (was a hardcoded client dict)", () => {
  const run = loadBabel();
  assert.ok(run.world.deathLaw && typeof run.world.deathLaw === "object", "deathLaw must survive the loader");
  assert.match(run.world.deathLaw.epilogue, /coma that was never death/i, "the authored epilogue must be carried verbatim");
});

// ── 3. BUG: factions.wants read (loader writes flags.wants; old read was f.wants) ──
test("BUG factions.wants: goal↔faction relevance matches on the authored agenda, not name-only", () => {
  const run = loadBabel();
  // The Root Shrine's agenda mentions "the Ledger" (in flags.wants, not top-level).
  const shrine = Object.values(run.factions).find((f) => f.factionId === "faction_root_shrine");
  assert.ok(shrine, "babel must seed the Root Shrine faction");
  assert.equal(shrine.wants, undefined, "wants rides flags.wants — there is no top-level engine field");
  assert.ok(shrine.flags && typeof shrine.flags.wants === "string", "the agenda must be committed on flags.wants");
  // A goal whose tokens overlap ONLY the agenda (not the name) must still resolve to it.
  const chosen = relevantFactionId(run, ["ledger"]);
  assert.equal(chosen, "faction_root_shrine", "the fixed read must reach flags.wants (name-only would miss 'ledger')");
});

// ── 4. BUG: scenario front reputationEffects carried into the thread ──
test("BUG front.reputationEffects: an authored front's standing effects survive into run.threads", () => {
  const effects = [{ target: "faction_elkwater", delta: 3, tags: ["helped"] }];
  const run = loadBabel((s) => {
    s.fronts[0].reputationEffects = effects;
  });
  const thread = run.threads[loadScenarioFile("babel").fronts[0].frontId];
  assert.ok(thread, "the front must instantiate a thread");
  assert.deepEqual(thread.reputationEffects, effects, "reputationEffects must ride the scenario front→thread path");
});

// ── 5. BUG: essenceTrail illegal enum value removed from babel data ──
// The bug was the ILLEGAL `band: "fresh"` (the trace enum is bright/clear/faint/cold
// and band is DERIVED from age, never authored). `palette: "violet"` is NOT dead — it
// is the authored CHAOS=violet law (missing-rungs asserts it), so it stays.
test("BUG essenceTrail.band: babel authors no (illegal) band; the violet chaos palette is preserved", () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve("server/campaign/scenarios/babel.json"), "utf8"));
  const placements = raw.bestiary?.placements || [];
  for (const p of placements) {
    if (p.essenceTrail) {
      assert.equal(p.essenceTrail.band, undefined, `${p.statBlockId}: band is derived from age, never authored (was the illegal "fresh")`);
    }
  }
  const demon = placements.find((p) => p.statBlockId === "rapture_drifter");
  assert.equal(demon?.essenceTrail?.palette, "violet", "the CHAOS=violet marker must survive the band cleanup");
});

// ── 6. BUG: artStyleOptions.allowed binding (babel's narrowed list must bind) ──
test("BUG artStyleOptions.allowed: babel's narrowed allowed list binds (was overwritten by the full STYLES set)", () => {
  const run = loadBabel();
  assert.deepEqual(
    run.world.artStyleOptions.allowed,
    ["anime", "dark-fantasy"],
    "the scenario's narrowed allowed list must survive stampArtStyle, not the run's worldgen default"
  );
});
