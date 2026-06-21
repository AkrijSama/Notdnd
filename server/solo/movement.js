import crypto from "node:crypto";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";

function result(errors) {
  return {
    ok: errors.length === 0,
    errors
  };
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isString(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromOption(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && isIsoTimestamp(value)) {
    return value;
  }
  return nowIso();
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function appendPrefixedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

function validateDestinationPolicy(run, destination, errors) {
  if (run.edition === "mainline" && destination.edition === "forbidden") {
    push(errors, "action.toLocationId", "Mainline runs cannot move into forbidden locations");
    return;
  }

  const profile = policyProfileForRun(run);
  const policyValidation = validateEntityAgainstPolicy(destination, profile);
  for (const error of policyValidation.errors) {
    push(errors, `destination.${error.path}`, error.message);
  }
}

export function getAvailableMoves(run) {
  if (!isPlainObject(run) || !isPlainObject(run.locations) || !isString(run.currentLocationId)) {
    return [];
  }

  const currentLocation = run.locations[run.currentLocationId];
  if (!isPlainObject(currentLocation) || !Array.isArray(currentLocation.connectedLocationIds)) {
    return [];
  }

  return currentLocation.connectedLocationIds
    .map((locationId) => run.locations[locationId])
    .filter((location) => isPlainObject(location))
    .map((location) => ({
      locationId: location.locationId,
      name: location.name,
      direction: null,
      imageAssetId: location.imageAssetId ?? null,
      edition: location.edition ?? null,
      policyProfileId: location.policyProfileId ?? null
    }));
}

export function validateMovementAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }

  if (action.type !== "move") {
    push(errors, "action.type", "Expected move");
  }

  if (!isString(action.toLocationId)) {
    push(errors, "action.toLocationId", "Expected non-empty string");
  }

  if (!isPlainObject(run) || !isPlainObject(run.locations)) {
    return result(errors);
  }

  if (!isString(run.currentLocationId)) {
    push(errors, "run.currentLocationId", "Expected non-empty string");
    return result(errors);
  }

  const currentLocation = run.locations[run.currentLocationId];
  if (!isPlainObject(currentLocation)) {
    push(errors, "run.currentLocationId", "Current location does not exist");
    return result(errors);
  }

  if (action.fromLocationId !== undefined && action.fromLocationId !== null && action.fromLocationId !== run.currentLocationId) {
    push(errors, "action.fromLocationId", "From location must match currentLocationId");
  }

  if (!Array.isArray(currentLocation.connectedLocationIds)) {
    push(errors, `run.locations.${run.currentLocationId}.connectedLocationIds`, "Expected array");
    return result(errors);
  }

  if (!isString(action.toLocationId)) {
    return result(errors);
  }

  const destination = run.locations[action.toLocationId];
  if (!isPlainObject(destination)) {
    push(errors, "action.toLocationId", "Destination location does not exist");
    return result(errors);
  }

  if (!currentLocation.connectedLocationIds.includes(action.toLocationId)) {
    push(errors, "action.toLocationId", "Destination is not connected to current location");
  }

  validateDestinationPolicy(run, destination, errors);

  return result(errors);
}

export function createMovementMemoryFact(run, action, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const fromLocationId = action.fromLocationId ?? run.currentLocationId;

  return {
    factId: idFactory("fact_movement"),
    entityIds: [run.runId, action.actorId ?? "player", fromLocationId, action.toLocationId],
    type: "location_movement",
    text: `Actor ${action.actorId ?? "player"} moved from ${fromLocationId} to ${action.toLocationId}.`,
    source: "system",
    createdAt: now,
    tags: ["system", "movement"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: []
  };
}

export function createMovementTimelineEvent(run, action, memoryFact, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const fromLocationId = action.fromLocationId ?? run.currentLocationId;

  return {
    eventId: idFactory("event_movement"),
    type: "movement",
    title: "Movement",
    summary: `Actor ${action.actorId ?? "player"} moved from ${fromLocationId} to ${action.toLocationId}.`,
    createdAt: now,
    locationId: action.toLocationId,
    entityIds: [run.runId, action.actorId ?? "player", fromLocationId, action.toLocationId],
    memoryFactIds: [memoryFact.factId],
    tags: ["system", "movement"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: {
      actorId: action.actorId ?? "player",
      fromLocationId,
      toLocationId: action.toLocationId,
      direction: action.direction ?? null
    }
  };
}

export function resolveMovementAction(run, action, options = {}) {
  const validation = validateMovementAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const fromLocationId = action.fromLocationId ?? updatedRun.currentLocationId;
  const memoryFact = createMovementMemoryFact(updatedRun, { ...action, fromLocationId }, { now, idFactory });
  const timelineEvent = createMovementTimelineEvent(updatedRun, { ...action, fromLocationId }, memoryFact, { now, idFactory });

  updatedRun.currentLocationId = action.toLocationId;
  updatedRun.updatedAt = now;

  if (updatedRun.locations[fromLocationId]?.state) {
    updatedRun.locations[fromLocationId].state.visited = true;
  }

  const destination = updatedRun.locations[action.toLocationId];
  destination.state = {
    ...destination.state,
    visited: true,
    discovered: true
  };
  destination.memoryFactIds = [...new Set([...(destination.memoryFactIds || []), memoryFact.factId])];

  if (updatedRun.world?.time && typeof updatedRun.world.time.tick === "number") {
    updatedRun.world.time.tick += 1;
  }

  updatedRun.memoryFacts = [...updatedRun.memoryFacts, memoryFact];
  updatedRun.timeline = [...updatedRun.timeline, timelineEvent];

  const updatedValidation = validateSoloRun(updatedRun);
  if (!updatedValidation.ok) {
    return {
      ok: false,
      errors: updatedValidation.errors
    };
  }

  return {
    ok: true,
    run: updatedRun,
    event: timelineEvent,
    memoryFact,
    errors: []
  };
}
