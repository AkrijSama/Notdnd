import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  getSearchableDetails,
  resolveSearchAction,
  validateSearchAction,
  detectSearchIntent,
  detectObservationIntent
} from "../server/solo/search.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function searchAction(overrides = {}) {
  return {
    type: "search",
    actorId: "player",
    ...overrides
  };
}

function addSecondDetail(run) {
  run.locations.start_location.searchDetails.push({
    detailId: "start_location_small_landmark",
    label: "Small Landmark",
    description: "A small landmark helps orient the route.",
    revealed: false,
    contentTags: [],
    linkedEntityIds: ["start_location"],
    linkedMemoryFactIds: [],
    edition: "mainline",
    policyProfileId: "mainline_default"
  });
}

test("detectObservationIntent recognizes scene-perception, not idle waiting or NPC-directed", () => {
  const run = createDefaultSoloRun({ runId: "observe_detect" });
  // the 5/5-session offender — perceiving the SCENE, which today narrates into the void
  assert.deepEqual(detectObservationIntent(run, "wait by the door and watch the room for a long while"), { observe: true });
  assert.deepEqual(detectObservationIntent(run, "keep watch and observe the crowd"), { observe: true });
  assert.deepEqual(detectObservationIntent(run, "survey the area carefully"), { observe: true });
  // IDLE non-perception (no scene target) must STAY an attempt so momentum can
  // escalate a static scene — the "3 idle turns → the world moves" contract.
  assert.equal(detectObservationIntent(run, "wait and listen to the wind"), null);
  assert.equal(detectObservationIntent(run, "stand still and think about my next move"), null);
  assert.equal(detectObservationIntent(run, "hum a quiet tune to myself"), null);
  // a loot-search is handled by detectSearchIntent, not the observation path
  assert.equal(detectObservationIntent(run, "rummage through the crates for anything useful"), null);
  // a person-directed perception is a social beat, not area observation
  const withNpc = clone(run);
  withNpc.npcs = { npc_goran: { npcId: "npc_goran", displayName: "Goran", currentLocationId: run.currentLocationId, status: "present" } };
  assert.equal(detectObservationIntent(withNpc, "watch Goran in the room"), null);
});

test("detectSearchIntent routes OBJECT-directed searches (the baseline T8 void class)", () => {
  const run = createDefaultSoloRun({ runId: "search_object" });
  // the exact 2x baseline offender — object/fixture search with an articled "for a hidden…"
  assert.ok(detectSearchIntent(run, "search the door and its frame for a hidden catch or key"));
  assert.ok(detectSearchIntent(run, "check the hearth for a secret compartment"));
  assert.ok(detectSearchIntent(run, "rummage through the desk for anything useful"));
  // a person-search still stays out of the area path
  const withNpc = clone(run);
  withNpc.npcs = { npc_g: { npcId: "npc_g", displayName: "Goran", currentLocationId: run.currentLocationId, status: "present" } };
  assert.equal(detectSearchIntent(withNpc, "search Goran for weapons"), null);
});

test("detectSearchIntent and detectObservationIntent partition the passive-intent space", () => {
  const run = createDefaultSoloRun({ runId: "observe_partition" });
  // "search the area" is a search, not an observation reroute (search wins)
  assert.ok(detectSearchIntent(run, "search the area carefully for anything hidden"));
  // "watch the room" is an observation, and NOT a loot-search
  assert.equal(detectSearchIntent(run, "wait and watch the room for a while"), null);
  assert.deepEqual(detectObservationIntent(run, "wait and watch the room for a while"), { observe: true });
});

test("validates search action", () => {
  const run = createDefaultSoloRun({ runId: "search_validate" });

  const validation = validateSearchAction(run, searchAction());

  assert.equal(validation.ok, true);
});

test("search action defaults target to current location", () => {
  const run = createDefaultSoloRun({ runId: "search_default_target" });

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.locationId, "start_location");
});

test("search rejects non-current location", () => {
  const run = createDefaultSoloRun({ runId: "search_wrong_target" });

  const validation = validateSearchAction(run, searchAction({ targetLocationId: "second_location" }));

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "action.targetLocationId"));
});

test("search reveals first unrevealed searchable detail", () => {
  const run = createDefaultSoloRun({ runId: "search_reveal_first" });

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, true);
  assert.deepEqual(resolved.searchResult.revealedDetailIds, ["start_location_scuffed_mark"]);
  assert.equal(resolved.run.locations.start_location.searchDetails[0].revealed, true);
});

test("search detail without check still reveals deterministically", () => {
  const run = createDefaultSoloRun({ runId: "search_no_check" });

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 1 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, true);
  assert.equal(resolved.searchResult.checkResult, null);
});

test("search detail with check reveals on success", () => {
  const run = createDefaultSoloRun({ runId: "search_check_success" });
  run.player.abilities.intelligence = 14;
  run.player.skills.investigation = 2;
  run.locations.start_location.searchDetails[0].check = {
    ability: "intelligence",
    skill: "investigation",
    dc: 15
  };

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 12 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, true);
  assert.equal(resolved.searchResult.checkResult.success, true);
  assert.equal(resolved.searchResult.checkResult.total, 16);
  assert.equal(resolved.run.locations.start_location.searchDetails[0].revealed, true);
  assert.equal(resolved.memoryFact.type, "search_discovery");
  assert.equal(validateSoloRun(resolved.run).ok, true);
});

test("search detail with check does not reveal on failure", () => {
  const run = createDefaultSoloRun({ runId: "search_check_failure" });
  run.locations.start_location.searchDetails[0].check = {
    ability: "intelligence",
    skill: "investigation",
    dc: 18
  };

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 9 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, false);
  assert.equal(resolved.searchResult.checkResult.success, false);
  assert.equal(resolved.run.locations.start_location.searchDetails[0].revealed, false);
  assert.equal(resolved.memoryFact, null);
  assert.equal(resolved.event.type, "search");
  assert.ok(resolved.searchResult.warningCodes.includes("SEARCH_CHECK_FAILED"));
});

test("repeated search reveals next detail if present", () => {
  const run = createDefaultSoloRun({ runId: "search_reveal_next" });
  addSecondDetail(run);

  const first = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveSearchAction(first.run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(first.searchResult.revealedDetailIds[0], "start_location_scuffed_mark");
  assert.equal(second.searchResult.found, true);
  assert.deepEqual(second.searchResult.revealedDetailIds, ["start_location_small_landmark"]);
});

test("repeated search with no details returns found false", () => {
  const run = createDefaultSoloRun({ runId: "search_none_left" });

  const first = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveSearchAction(first.run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(second.ok, true);
  assert.equal(second.searchResult.found, false);
  assert.equal(second.memoryFact, null);
  assert.ok(second.searchResult.warningCodes.includes("SEARCH_NOTHING_NEW"));
});

test("search creates timeline event", () => {
  const run = createDefaultSoloRun({ runId: "search_event" });

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.event.type, "search");
  assert.equal(resolved.run.timeline.at(-1).eventId, resolved.event.eventId);
});

test("search creates memory fact only for new discovery", () => {
  const run = createDefaultSoloRun({ runId: "search_memory_once" });

  const first = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveSearchAction(first.run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(first.memoryFact.type, "search_discovery");
  assert.equal(second.memoryFact, null);
  assert.equal(second.run.memoryFacts.filter((fact) => fact.type === "search_discovery").length, 1);
});

test("successful checked search creates memory", () => {
  const run = createDefaultSoloRun({ runId: "search_checked_memory" });
  run.locations.start_location.searchDetails[0].check = {
    ability: "wisdom",
    skill: "perception",
    dc: 8
  };

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 12 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.memoryFact.type, "search_discovery");
  assert.equal(resolved.run.memoryFacts.filter((fact) => fact.type === "search_discovery").length, 1);
});

test("search respects mainline blocked tags", () => {
  const run = createDefaultSoloRun({ runId: "search_policy_block" });
  run.locations.start_location.searchDetails = [
    {
      detailId: "blocked_detail",
      label: "Blocked Detail",
      description: "Blocked placeholder detail.",
      revealed: false,
      contentTags: ["explicit_sexual_content"],
      linkedEntityIds: ["start_location"],
      linkedMemoryFactIds: [],
      edition: "mainline",
      policyProfileId: "mainline_default"
    }
  ];

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, false);
  assert.equal(resolved.run.locations.start_location.searchDetails[0].revealed, false);
});

test("forbidden lane can reveal allowed forbidden-lane detail", () => {
  const run = createDefaultSoloRun({ runId: "search_forbidden_allowed" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.start_location.edition = "forbidden";
  run.locations.start_location.policyProfileId = "forbidden_default";
  run.locations.start_location.searchDetails = [
    {
      detailId: "forbidden_safe_detail",
      label: "Forbidden Lane Placeholder",
      description: "A mature-lane placeholder detail is available here.",
      revealed: false,
      contentTags: ["adult_themes"],
      linkedEntityIds: ["start_location"],
      linkedMemoryFactIds: [],
      edition: "forbidden",
      policyProfileId: "forbidden_default"
    }
  ];

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, true);
  assert.equal(resolved.memoryFact.edition, "forbidden");
  assert.deepEqual(resolved.memoryFact.contentTags, ["adult_themes"]);
});

test("search validates final run", () => {
  const run = createDefaultSoloRun({ runId: "search_valid_final" });

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(validateSoloRun(resolved.run).ok, true);
});

test("search does not mutate original run or invent entities items or exits", () => {
  const run = createDefaultSoloRun({ runId: "search_no_mutation" });
  const before = clone(run);

  const resolved = resolveSearchAction(run, searchAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.deepEqual(run, before);
  assert.deepEqual(Object.keys(resolved.run.npcs), Object.keys(run.npcs));
  assert.deepEqual(Object.keys(resolved.run.inventory), Object.keys(run.inventory));
  assert.deepEqual(resolved.run.locations.start_location.connectedLocationIds, run.locations.start_location.connectedLocationIds);
});

test("getSearchableDetails returns policy-allowed details only", () => {
  const run = createDefaultSoloRun({ runId: "searchable_details" });
  run.locations.start_location.searchDetails.push({
    detailId: "blocked_detail",
    label: "Blocked Detail",
    description: "Blocked placeholder detail.",
    revealed: false,
    contentTags: ["explicit_sexual_content"],
    linkedEntityIds: ["start_location"],
    linkedMemoryFactIds: [],
    edition: "mainline",
    policyProfileId: "mainline_default"
  });

  const details = getSearchableDetails(run);

  assert.equal(details.length, 1);
  assert.equal(details[0].detailId, "start_location_scuffed_mark");
});
