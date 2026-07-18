// VERDANCE REGION v1 — proof that the world-book DATA (docs/worlds/babel/
// verdance-region-v1.md) loads into a run through the EXISTING mints/threads/
// services/regionMap surfaces. No engine behavior is tested here that this pass
// authored — only that the loaded data is live (reachable nodes, seeded services,
// instantiated threads, seeded factions, era set).
import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { deriveAffordances } from "../server/solo/affordances.js";
import { buildRegionMapPayload } from "../server/solo/regionMap.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

function babelRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.campaignId = "cmp_test";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

const POI_IDS = [
  "loc_world_tree", "loc_root_shrine", "loc_penitents_row", "loc_st_brigids",
  "loc_warm_house", "loc_tithing_mill", "loc_drowned_highway", "loc_ranger_station_9",
  "loc_reservoir", "loc_champions_cairn", "loc_unfinished_map", "loc_old_rapture",
  "loc_elkwater_crossing", "loc_poachers_yard", "loc_waking_mile", "loc_bonelight_grove",
  "loc_stillborn_field", "loc_choir_cave", "loc_cold_door", "loc_her_clearing"
];

test("verdance: the 20 POIs load as real locations and the run stays schema-valid", () => {
  const run = babelRun();
  assert.equal(validateSoloRun(run).ok, true, "run valid after loading the region");
  assert.equal(POI_IDS.length, 20);
  for (const id of POI_IDS) assert.ok(run.locations[id], `POI ${id} minted as a location`);
});

test("verdance: every POI is reachable from the start via the exit graph (BFS)", () => {
  const run = babelRun();
  const start = run.currentLocationId;
  assert.equal(start, "start_location");
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of run.locations[cur]?.connectedLocationIds || []) {
      if (!seen.has(next) && run.locations[next]) { seen.add(next); queue.push(next); }
    }
  }
  for (const id of POI_IDS) assert.ok(seen.has(id), `POI ${id} reachable from start via committed exits`);
});

test("verdance: authored edges are symmetrized (undirected reachability), worldgen links kept", () => {
  const run = babelRun();
  assert.ok(run.locations.loc_elkwater_crossing.connectedLocationIds.includes("loc_waking_mile"));
  assert.ok(run.locations.loc_waking_mile.connectedLocationIds.includes("loc_elkwater_crossing"), "reciprocal added");
  // start_location gained the POI reciprocal WITHOUT losing its worldgen link.
  assert.ok(run.locations.start_location.connectedLocationIds.includes("loc_waking_mile"), "POI edge reached start");
  assert.ok(run.locations.start_location.connectedLocationIds.includes("second_location"), "worldgen link preserved");
});

test("verdance: Elkwater services seed live market + inn affordance chips", () => {
  const run = babelRun();
  run.currentLocationId = "loc_elkwater_crossing";
  const aff = deriveAffordances(run);
  const services = aff.filter((a) => a.source === "service");
  assert.ok(services.length >= 2, "at least two service chips at Elkwater");
  assert.ok(services.every((a) => a.feasibility === "ok"), "services live (not gated)");
  const labels = services.map((a) => a.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes("market")), "market chip");
  assert.ok(labels.some((l) => l.includes("bunk") || l.includes("room")), "inn chip");
});

test("verdance: both region thread-fronts are LIVE in run.threads; retired fronts are gone", () => {
  const run = babelRun();
  assert.ok(run.threads.front_congregation, "Hollow Congregation thread instantiated");
  assert.equal(run.threads.front_congregation.status, "active");
  assert.ok(run.threads.front_warm_house, "Warm House thread instantiated");
  assert.equal(run.threads.front_warm_house.status, "active");
  // The Congregation grounds in real region POIs (the collectDeclaredIds object-map fix).
  assert.ok(run.threads.front_congregation.groundedIn.locationIds.includes("loc_tithing_mill"));
  assert.ok(!run.threads.front_queue && !run.threads.front_cordon, "pre-region fronts retired");
});

test("verdance: four factions seed; the Congregation stays secret; disposition/wants ride flags", () => {
  const run = babelRun();
  const f = run.factions;
  assert.ok(f.faction_root_shrine && f.faction_congregation && f.faction_elkwater && f.faction_poachers_yard, "all four seeded");
  assert.equal(f.faction_congregation.discovered, false, "hostile-secret faction is undiscovered");
  assert.equal(f.faction_root_shrine.discovered, true, "the keepers are known");
  assert.equal(f.faction_congregation.flags.disposition, "hostile-secret");
  assert.match(f.faction_congregation.flags.wants, /Cold Door/);
  assert.ok(f.faction_root_shrine.standing > 0, "friendly-reserved standing positive");
  assert.ok(f.faction_poachers_yard.standing < 0, "greedy crew standing negative");
});

test("verdance: the era field reaches run.world (closes the art-pipeline era gap)", () => {
  const run = babelRun();
  assert.match(run.world.era, /Pacific Northwest/i);
  assert.equal(run.world.variant, "babel");
});

test("verdance: danger tiers commit to state.dangerLevel for the regionMap hazard read", () => {
  const run = babelRun();
  assert.equal(run.locations.loc_cold_door.state.dangerLevel, 4, "the portal is DEADLY");
  assert.equal(run.locations.loc_elkwater_crossing.state.dangerLevel, 0, "the settlement is safe");
  assert.equal(run.locations.loc_choir_cave.state.dangerLevel, 3);
});

test("verdance: a map:babel fact reveals the region as regionMap nodes (Ranger/Unfinished-Map loot READ)", () => {
  const run = babelRun();
  // Simulate looting a map-knowledge item (the loader-seed of this is a ledgered
  // content gap; the REVEAL read already exists and consumes the region cleanly).
  run.memoryFacts = Array.isArray(run.memoryFacts) ? run.memoryFacts : [];
  run.memoryFacts.push({ factId: "fact_ranger_map", type: "map_knowledge", text: "A ranger's map of the Verdance.", tags: ["map:babel", "item"] });
  const region = buildRegionMapPayload(run);
  assert.ok(region, "region payload builds");
  const nodeIds = region.nodes.map((n) => n.id);
  assert.ok(nodeIds.includes("loc_elkwater_crossing"), "map reveals Elkwater as a node");
  assert.ok(nodeIds.includes("loc_cold_door"), "map reveals the Cold Door as a node");
  const coldDoor = region.nodes.find((n) => n.id === "loc_cold_door");
  assert.equal(coldDoor.revealedBy, "fact_ranger_map", "the node records which fact revealed it (auditable)");
});
