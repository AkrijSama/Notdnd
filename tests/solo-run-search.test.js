import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  getSearchableDetails,
  resolveSearchAction,
  validateSearchAction
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
