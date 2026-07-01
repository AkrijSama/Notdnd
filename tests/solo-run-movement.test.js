import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSoloRun,
  validateSoloRun
} from "../server/solo/schema.js";
import {
  getAvailableMoves,
  resolveMovementAction,
  validateMovementAction
} from "../server/solo/movement.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function legalMove(overrides = {}) {
  return {
    type: "move",
    actorId: "player",
    fromLocationId: "start_location",
    toLocationId: "second_location",
    direction: "east",
    ...overrides
  };
}

test("getAvailableMoves gates an UNDISCOVERED connection's name (M.2 geo-fog)", () => {
  const run = createDefaultSoloRun({ runId: "run_moves" });
  run.locations.second_location.imageAssetId = "image_second_location";
  // Default: the adjacent location is undiscovered -> an unnamed path, no name/art leaked.
  const moves = getAvailableMoves(run);
  assert.deepEqual(moves, [
    {
      locationId: "second_location",
      name: "An unexplored path",
      discovered: false,
      direction: null,
      imageAssetId: null,
      edition: "mainline",
      policyProfileId: "mainline_default"
    }
  ]);
});

test("getAvailableMoves exposes the real name once the connection is DISCOVERED", () => {
  const run = createDefaultSoloRun({ runId: "run_moves_known" });
  run.locations.second_location.imageAssetId = "image_second_location";
  run.locations.second_location.state.discovered = true; // a reveal event happened
  const moves = getAvailableMoves(run);
  assert.deepEqual(moves, [
    {
      locationId: "second_location",
      name: "Ashenmoor Market Square",
      discovered: true,
      direction: null,
      imageAssetId: "image_second_location",
      edition: "mainline",
      policyProfileId: "mainline_default"
    }
  ]);
});

test("validateMovementAction accepts legal connected move", () => {
  const run = createDefaultSoloRun({ runId: "run_valid_move" });

  const result = validateMovementAction(run, legalMove());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateMovementAction rejects missing toLocationId", () => {
  const run = createDefaultSoloRun({ runId: "run_missing_to" });
  const action = legalMove();
  delete action.toLocationId;

  const result = validateMovementAction(run, action);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.toLocationId"));
});

test("validateMovementAction rejects destination that does not exist", () => {
  const run = createDefaultSoloRun({ runId: "run_missing_destination" });

  const result = validateMovementAction(run, legalMove({ toLocationId: "missing_location" }));
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.toLocationId"));
});

test("validateMovementAction rejects destination not connected", () => {
  const run = createDefaultSoloRun({ runId: "run_unconnected_destination" });

  const result = validateMovementAction(run, legalMove({ toLocationId: "third_location" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "action.toLocationId" && /not connected/.test(error.message)));
});

test("validateMovementAction rejects fromLocationId mismatch", () => {
  const run = createDefaultSoloRun({ runId: "run_bad_from" });

  const result = validateMovementAction(run, legalMove({ fromLocationId: "third_location" }));
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.fromLocationId"));
});

test("resolveMovementAction updates currentLocationId", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_location" });

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.currentLocationId, "second_location");
});

test("resolveMovementAction marks destination visited and discovered", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_visit" });

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.locations.second_location.state.visited, true);
  assert.equal(result.run.locations.second_location.state.discovered, true);
});

test("resolveMovementAction appends timeline event", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_event" });
  const originalLength = run.timeline.length;

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.timeline.length, originalLength + 1);
  assert.equal(result.event.type, "movement");
  assert.equal(result.event.locationId, "second_location");
  assert.equal(result.event.createdAt, TEST_NOW);
});

test("resolveMovementAction appends memory fact", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_fact" });
  const originalLength = run.memoryFacts.length;

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.memoryFacts.length, originalLength + 1);
  assert.equal(result.memoryFact.type, "location_movement");
  assert.equal(result.memoryFact.source, "system");
  assert.equal(result.memoryFact.canonical, true);
});

test("resolveMovementAction links movement memory fact to destination location", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_link" });

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.ok(result.run.locations.second_location.memoryFactIds.includes(result.memoryFact.factId));
  assert.deepEqual(result.event.memoryFactIds, [result.memoryFact.factId]);
});

test("resolveMovementAction increments world.time.tick if present", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_tick" });
  run.world.time.tick = 7;

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.world.time.tick, 8);
});

test("resolveMovementAction updates updatedAt deterministically", () => {
  const run = createDefaultSoloRun({ runId: "run_resolve_time" });

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.updatedAt, TEST_NOW);
});

test("resolveMovementAction does not mutate original run", () => {
  const run = createDefaultSoloRun({ runId: "run_no_mutation" });
  const before = clone(run);

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.deepEqual(run, before);
  assert.notDeepEqual(result.run, before);
});

test("mainline run cannot move into forbidden location", () => {
  const run = createDefaultSoloRun({ runId: "run_mainline_forbidden_block" });
  run.locations.second_location.edition = "forbidden";
  run.locations.second_location.policyProfileId = "forbidden_default";
  run.locations.second_location.contentTags = ["adult_themes"];

  const result = validateMovementAction(run, legalMove());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "action.toLocationId" && /forbidden/.test(error.message)));
});

test("forbidden run can move into forbidden location if policy allows", () => {
  const run = createDefaultSoloRun({ runId: "run_forbidden_allowed" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.second_location.edition = "forbidden";
  run.locations.second_location.policyProfileId = "forbidden_default";
  run.locations.second_location.contentTags = ["adult_themes"];

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.currentLocationId, "second_location");
});

test("blocked contentTags are rejected by mainline policy", () => {
  const run = createDefaultSoloRun({ runId: "run_blocked_tags" });
  run.locations.second_location.contentTags = ["dark_fantasy", "explicit_sexual_content"];

  const result = validateMovementAction(run, legalMove());
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("destination.contentTags.1"));
});

test("location imageAssetId is preserved through movement", () => {
  const run = createDefaultSoloRun({ runId: "run_image_preserved" });
  run.locations.second_location.imageAssetId = "image_second_location";

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.locations.second_location.imageAssetId, "image_second_location");
});

test("resulting run validates after movement", () => {
  const run = createDefaultSoloRun({ runId: "run_valid_after_move" });

  const result = resolveMovementAction(run, legalMove(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(validateSoloRun(result.run).ok, true);
});

test("useful path values appear in validation errors", () => {
  const run = createDefaultSoloRun({ runId: "run_error_paths" });
  run.locations.start_location.connectedLocationIds = "second_location";

  const result = validateMovementAction(run, legalMove({ toLocationId: "" }));
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.toLocationId"));
  assert.ok(errorPaths(result).includes("run.locations.start_location.connectedLocationIds"));
});
