// B1 — creator worlds get PEOPLE + PURPOSE. compileWorldBook mints a starter cast,
// a quest spine, a tier-1 encounter, and an essence hook for every user world, and
// the compiled scenario loads into a real run (romanceable cast, a placed+resolvable
// threat, a followable trail). Kills "barren".
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { buildSightPayload } from "../server/solo/essence.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";

test("a {name, vibe} world compiles with cast + quest spine + encounter (validates)", () => {
  const { scenario, validation } = compileWorldBook({ name: "Ashfall", vibe: "a drowned empire of ash and tide" });
  assert.equal(validation.ok, true, `compiled scenario validates: ${JSON.stringify(validation.errors?.slice(0, 3))}`);
  // CAST: 4-6, romanceable-stamped (law R2), in keeper/trader/quest-giver/... roles
  assert.ok(scenario.cast.length >= 4 && scenario.cast.length <= 6, "4-6 cast");
  assert.ok(scenario.cast.every((c) => c.romanceable === true && c.ageClass === "adult"), "cast romanceable + adult");
  const roles = scenario.cast.map((c) => c.role);
  assert.ok(roles.includes("keeper") && roles.includes("trader") && roles.includes("quest-giver"), "keeper/trader/quest-giver present");
  // QUEST SPINE: 1 main (wired to opening) + 2 sides, ridden by cast
  assert.deepEqual(Object.keys(scenario.questOffers).sort(), ["offer_main", "offer_side_landmark", "offer_side_threat"]);
  assert.equal(scenario.opening.questObjectiveFrom, "offer_main", "main quest arrives diegetically");
  assert.ok(scenario.cast.some((c) => c.questOffer === "offer_main"), "a cast member offers the main");
  // ENCOUNTER: a minted tier-1 threat with world-flavored naming + a placement. Ashfall declares
  // NO world.corruption, so its threat is a NEUTRAL beast — NOT a violet chaosling (JOB 1: the
  // chaosling/violet identity is Babel furniture, not an engine default welded onto every world).
  const blocks = Object.values(scenario.bestiary.statBlocks || {});
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tier, 1, "tier-1 threat");
  assert.equal(blocks[0].kind, "beast", "a corruption-less world mints a NEUTRAL beast, not a chaosling");
  assert.equal(blocks[0].corruption, undefined, "no violet corruption leaks into a world that declared none");
  assert.match(blocks[0].name, /roosevelt elk|wolf|bear|boar|lion|deer|coyote|snake|raven|otter/i, "base-animal chassis, world-flavored name");
  assert.equal(scenario.bestiary.placements.length, 1, "the encounter is placed");
});

test("the compiled world LOADS into a run: romanceable cast, a placed+resolvable threat, a trail", () => {
  const { scenario } = compileWorldBook({ name: "Ashfall", vibe: "ash and tide" });
  const run = createDefaultSoloRun({ now: new Date(1730000000000).toISOString() });
  loadScenarioIntoRun(run, scenario, { worldSeed: "seed1" });
  const cast = Object.values(run.npcs).filter((n) => !n.flags?.hostile);
  const hostiles = Object.values(run.npcs).filter((n) => n.flags?.hostile);
  assert.ok(cast.length >= 4, "cast instantiated");
  assert.ok(cast.every((n) => n.romanceable === true), "scenario cast gets romanceable (the loader gap, now closed)");
  assert.equal(hostiles.length, 1, "the tier-1 threat is placed as a hostile");
  assert.ok(resolveStatBlock(hostiles[0].statBlockId), "the MINTED block resolves — combat can fight it (runtime registry)");
  assert.notEqual(hostiles[0].currentLocationId, "start_location", "the danger sits BEYOND the kept ground (anti-lost)");
  run.currentLocationId = "start_location";
  const traces = buildSightPayload(run).traces;
  assert.ok(traces.some((t) => t.followable), "a followable essence trail leads to the encounter");
});

test("an interview-rich world uses its answers (people → cast names, POIs → placement)", () => {
  const wb = {
    name: "Verdance", vibe: "a green corruption",
    nameBanks: { settlements: ["Elkwater"], wilds: ["The Bonelight"], people: ["Ruth", "Odile", "Emory", "Priya"] },
    factions: [{ factionId: "faction_keepers", name: "The Keepers", disposition: "friendly", standing: 10 }],
    pois: [{ id: "loc_grove", name: "The Bonelight Grove", description: "A grove where the dead sing." }]
  };
  const { scenario, validation } = compileWorldBook(wb);
  assert.equal(validation.ok, true);
  // cast names come from the world's people bank
  const names = scenario.cast.map((c) => c.displayName);
  assert.ok(names.includes("Ruth") && names.includes("Odile"), "cast drawn from the interview's people bank");
  // the authored POI is a real location + the cast/encounter spread onto it
  assert.ok(scenario.locations.loc_grove, "authored POI compiled");
  assert.ok(scenario.cast.some((c) => c.at === "loc_grove"), "cast placed at the authored landmark");
  // faction carried onto a cast member
  assert.ok(scenario.cast.some((c) => c.factionId === "faction_keepers"), "faction disposition carried to cast");
});

test("authored cast/quests are NEVER overwritten by the mint (authored wins)", () => {
  const wb = {
    name: "Authored", vibe: "hand-made",
    cast: [{ npcId: "npc_hero", displayName: "The Hero", role: "ally", at: "start_location", ageClass: "adult" }]
  };
  const { scenario } = compileWorldBook(wb);
  assert.equal(scenario.cast.length, 1, "authored cast preserved, not replaced");
  assert.equal(scenario.cast[0].npcId, "npc_hero");
  assert.equal(scenario.bestiary.placements.length, 0, "no minted encounter when cast is authored");
});
