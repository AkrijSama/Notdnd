import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  getAvailableRestTypes,
  resolveRestAction,
  validateRestAction
} from "../server/solo/rest.js";

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

function restAction(overrides = {}) {
  return {
    type: "rest",
    actorId: "player",
    restType: "short",
    ...overrides
  };
}

test("validates rest action", () => {
  const run = createDefaultSoloRun({ runId: "rest_validate" });

  const validation = validateRestAction(run, restAction());

  assert.equal(validation.ok, true);
});

test("rest action defaults target to current location", () => {
  const run = createDefaultSoloRun({ runId: "rest_default_target" });

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.restResult.locationId, "start_location");
});

test("rest rejects non-current location", () => {
  const run = createDefaultSoloRun({ runId: "rest_wrong_target" });

  const validation = validateRestAction(run, restAction({ targetLocationId: "second_location" }));

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "action.targetLocationId"));
});

test("rest rejects invalid restType", () => {
  const run = createDefaultSoloRun({ runId: "rest_invalid_type" });

  const validation = validateRestAction(run, restAction({ restType: "camp" }));

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "action.restType"));
});

test("rest denies when location disallows it without mutation", () => {
  const run = createDefaultSoloRun({ runId: "rest_denied" });
  run.locations.start_location.rest.allowed = false;
  const before = clone(run);

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.run, null);
  assert.equal(resolved.restResult.allowed, false);
  assert.ok(resolved.restResult.warningCodes.includes("REST_NOT_ALLOWED"));
  assert.deepEqual(run, before);
});

test("short rest advances time by 1", () => {
  const run = createDefaultSoloRun({ runId: "rest_short_time" });

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.restResult.timeAdvanced, 1);
  assert.equal(resolved.run.world.time.tick, 1);
  assert.equal(resolved.run.world.time.lastAdvancedAt, TEST_NOW);
});

test("long rest advances time by 8", () => {
  const run = createDefaultSoloRun({ runId: "rest_long_time" });
  run.locations.start_location.rest.availableTypes = ["short", "long"];

  const resolved = resolveRestAction(run, restAction({ restType: "long" }), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.restResult.timeAdvanced, 8);
  assert.equal(resolved.run.world.time.tick, 8);
});

test("short rest recovers stamina if present", () => {
  const run = createDefaultSoloRun({ runId: "rest_short_stamina" });
  run.player.resources.stamina.current = 3;

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.run.player.resources.stamina.current, 5);
  assert.deepEqual(resolved.restResult.resourcesRecovered.map((entry) => entry.resourceId), ["stamina"]);
});

test("long rest recovers stamina and hitPoints if present", () => {
  const run = createDefaultSoloRun({ runId: "rest_long_resources" });
  run.locations.start_location.rest.availableTypes = ["short", "long"];
  run.player.resources.stamina.current = 2;
  run.player.resources.hitPoints.current = 4;

  const resolved = resolveRestAction(run, restAction({ restType: "long" }), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.run.player.resources.stamina.current, 6);
  assert.equal(resolved.run.player.resources.hitPoints.current, 10);
  assert.deepEqual(resolved.restResult.resourcesRecovered.map((entry) => entry.resourceId).sort(), ["hitPoints", "stamina"]);
});

test("rest creates timeline event on successful rest", () => {
  const run = createDefaultSoloRun({ runId: "rest_event" });

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.event.type, "rest");
  assert.equal(resolved.run.timeline.at(-1).eventId, resolved.event.eventId);
});

test("rest does not create memory fact by default", () => {
  const run = createDefaultSoloRun({ runId: "rest_no_memory" });

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.memoryFact, null);
  assert.equal(resolved.run.memoryFacts.filter((fact) => fact.type === "rest").length, 0);
});

test("rest validates final run", () => {
  const run = createDefaultSoloRun({ runId: "rest_valid_final" });

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(validateSoloRun(resolved.run).ok, true);
});

test("rest does not call GM provider or invent entities items or exits", () => {
  const run = createDefaultSoloRun({ runId: "rest_no_provider" });
  const before = clone(run);

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.deepEqual(Object.keys(resolved.run.npcs), Object.keys(before.npcs));
  assert.deepEqual(Object.keys(resolved.run.inventory), Object.keys(before.inventory));
  assert.deepEqual(resolved.run.locations.start_location.connectedLocationIds, before.locations.start_location.connectedLocationIds);
  assert.equal(resolved.gmNarration, undefined);
});

test("mainline rest blocks blocked rest metadata", () => {
  const run = createDefaultSoloRun({ runId: "rest_policy_block" });
  run.locations.start_location.rest.contentTags = ["explicit_sexual_content"];

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.restResult.allowed, false);
  assert.ok(resolved.restResult.warningCodes.includes("REST_POLICY_BLOCKED"));
});

test("forbidden lane can allow forbidden-lane rest metadata", () => {
  const run = createDefaultSoloRun({ runId: "rest_forbidden_allowed" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.start_location.edition = "forbidden";
  run.locations.start_location.policyProfileId = "forbidden_default";
  run.locations.start_location.rest.edition = "forbidden";
  run.locations.start_location.rest.policyProfileId = "forbidden_default";
  run.locations.start_location.rest.contentTags = ["adult_themes"];

  const resolved = resolveRestAction(run, restAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.restResult.allowed, true);
});

test("getAvailableRestTypes returns policy-allowed types only", () => {
  const run = createDefaultSoloRun({ runId: "rest_available_types" });
  run.locations.start_location.rest.availableTypes = ["short", "long"];

  assert.deepEqual(getAvailableRestTypes(run), ["short", "long"]);

  run.locations.start_location.rest.contentTags = ["explicit_sexual_content"];
  assert.deepEqual(getAvailableRestTypes(run), []);
});
