// PART D — CONTENT PLUMBING: service kinds (quest-board / lore) + map-item seeds
// (Ranger Station 9 pinned maps, the Unfinished Map) whose pickup commits a map:babel
// knowledge fact that reveals the region graph. ZERO model calls.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAffordances } from "../server/solo/affordances.js";
import { resolveTakeAction } from "../server/solo/take.js";
import { mapKnowledgeReveals } from "../server/solo/regionMap.js";
import { LOCATION_SERVICE_KINDS, createDefaultSoloRun } from "../server/solo/schema.js";

const babel = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/campaign/scenarios/babel.json"), "utf8"));

// ── D1: SERVICE KINDS ────────────────────────────────────────────────────────
test("D1: quest-board + lore are committed service kinds", () => {
  assert.ok(LOCATION_SERVICE_KINDS.includes("quest-board"));
  assert.ok(LOCATION_SERVICE_KINDS.includes("lore"));
});

test("D1: quest-board / lore services derive affordance chips routing normal intents", () => {
  const run = {
    currentLocationId: "L",
    locations: { L: { name: "Hub", services: [{ kind: "quest-board", label: "Read the notice board" }, { kind: "lore", label: "Ask the elders about the region" }] } },
    npcs: {}, relationships: {}
  };
  const list = deriveAffordances(run);
  const board = list.find((a) => a.source === "service" && /notice board/i.test(a.label));
  const lore = list.find((a) => a.source === "service" && /region/i.test(a.label));
  assert.ok(board && board.feasibility === "ok" && /notice board/i.test(board.intent), "quest-board chip → normal intent");
  assert.ok(lore && lore.feasibility === "ok" && /region/i.test(lore.intent), "lore chip → normal intent");
});

test("D1: babel seeds Elkwater's quest-board + Root Shrine's lore", () => {
  const elk = babel.locations.loc_elkwater_crossing.services.map((s) => s.kind);
  const shrine = babel.locations.loc_root_shrine.services.map((s) => s.kind);
  assert.ok(elk.includes("quest-board"), "Elkwater has a quest-board");
  assert.ok(shrine.includes("lore"), "Root Shrine has lore");
});

// ── D2: MAP-ITEM SEEDS ───────────────────────────────────────────────────────
test("D2: Ranger Station 9 + the Unfinished Map seed takeable map-knowledge items", () => {
  for (const [id, detailId] of [["loc_ranger_station_9", "rs9_pinned_maps"], ["loc_unfinished_map", "unfinished_map"]]) {
    const details = babel.locations[id].searchDetails || [];
    const d = details.find((x) => x.detailId === detailId);
    assert.ok(d, `${id} seeds ${detailId}`);
    assert.equal(d.takeable, true);
    assert.ok(isPlainObject(d.grantItem), "carries a grantItem identity");
    assert.ok(Array.isArray(d.grantKnowledge) && d.grantKnowledge.includes("map:babel"), "pickup grants map:babel knowledge");
  }
});

test("D2: taking a map item commits a map:babel fact that reveals the region graph", () => {
  const run = createDefaultSoloRun({ now: "2026-07-19T00:00:00Z" });
  run.world.variant = "babel"; // map:babel reveals the whole known graph for this variant
  run.currentLocationId = "second_location";
  // seed the (already-revealed) map item onto a real committed location
  run.locations.second_location.searchDetails = [
    { ...babel.locations.loc_ranger_station_9.searchDetails[0], revealed: true }
  ];
  // before: no map knowledge → nothing revealed
  assert.equal(mapKnowledgeReveals(run).size, 0, "no reveal before the pickup");
  const res = resolveTakeAction(run, { type: "take", detailId: "rs9_pinned_maps", targetLocationId: "second_location" }, { now: "2026-07-19T00:00:01Z", idFactory: (p) => `${p}_1` });
  assert.ok(res.ok, `the take resolves (${JSON.stringify(res.errors || [])})`);
  const nrun = res.run;
  assert.ok(Object.values(nrun.inventory).some((it) => /map/i.test(it.name || "")), "map item granted to inventory");
  const mapFact = nrun.memoryFacts.find((f) => Array.isArray(f.tags) && f.tags.includes("map:babel"));
  assert.ok(mapFact, "a map:babel knowledge fact is committed on pickup");
  const revealed = mapKnowledgeReveals(nrun);
  assert.ok(revealed.size >= 3, `the region nodes are revealed after the pickup (${revealed.size})`);
});

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
