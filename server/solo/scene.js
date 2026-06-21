import { getAvailableSoloActions } from "./actions.js";
import { getVisibleEntities, validateVisibleEntity } from "./entities.js";
import { getAvailableMoves } from "./movement.js";
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

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    push(errors, path, "Expected array");
    return;
  }
  value.forEach((entry, index) => {
    if (!isString(entry)) {
      push(errors, `${path}.${index}`, "Expected non-empty string");
    }
  });
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function policyAllows(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity, policyProfile).ok;
}

function locationPayload(location) {
  return {
    locationId: location.locationId,
    name: location.name,
    description: location.description,
    imageAssetId: location.imageAssetId ?? null,
    state: location.state || {},
    edition: location.edition ?? null,
    policyProfileId: location.policyProfileId ?? null,
    contentTags: location.contentTags || [],
    tags: location.tags || [],
    flags: location.flags || {},
    memoryFactIds: location.memoryFactIds || []
  };
}

function entityFactIds(entities) {
  const ids = new Set();
  for (const entity of entities) {
    for (const factId of entity.memoryFactIds || []) {
      ids.add(factId);
    }
  }
  return ids;
}

function entityRawIds(entities) {
  const ids = new Set();
  for (const entity of entities) {
    ids.add(entity.entityId);
    const rawId = entity.entityId.split(":").slice(1).join(":");
    if (rawId) {
      ids.add(rawId);
    }
  }
  return ids;
}

function appendNestedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

export function getRecentTimelineEvents(run, options = {}) {
  if (!Array.isArray(run?.timeline)) {
    return [];
  }

  const limit = Number.isInteger(options.limit) ? options.limit : 5;
  const policyProfile = options.policyProfile || policyProfileForRun(run);
  return run.timeline
    .filter((event) => policyAllows(event, policyProfile))
    .slice(-limit);
}

export function getRelevantMemoryFacts(run, options = {}) {
  if (!Array.isArray(run?.memoryFacts)) {
    return [];
  }

  const limit = Number.isInteger(options.limit) ? options.limit : 10;
  const location = run.locations?.[run.currentLocationId];
  const visibleEntities = options.visibleEntities || getVisibleEntities(run);
  const policyProfile = options.policyProfile || policyProfileForRun(run);
  const directFactIds = new Set(location?.memoryFactIds || []);
  const visibleFactIds = entityFactIds(visibleEntities);
  const visibleIds = entityRawIds(visibleEntities);

  const relevant = run.memoryFacts.filter((fact) => {
    if (!policyAllows(fact, policyProfile)) {
      return false;
    }
    if (directFactIds.has(fact.factId) || visibleFactIds.has(fact.factId)) {
      return true;
    }
    return (fact.entityIds || []).some((entityId) => visibleIds.has(entityId));
  });

  if (relevant.length > 0) {
    return relevant.slice(-limit);
  }

  return run.memoryFacts
    .filter((fact) => policyAllows(fact, policyProfile))
    .slice(-limit);
}

export function validateSoloScenePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    push(errors, "payload", "Expected object");
    return result(errors);
  }

  if (payload.ok !== true) {
    push(errors, "ok", "Expected true");
  }
  if (!isString(payload.runId)) {
    push(errors, "runId", "Expected non-empty string");
  }
  if (!isString(payload.edition)) {
    push(errors, "edition", "Expected non-empty string");
  }
  if (!isString(payload.policyProfileId)) {
    push(errors, "policyProfileId", "Expected non-empty string");
  }

  if (!isPlainObject(payload.location)) {
    push(errors, "location", "Expected object");
  } else {
    if (!isString(payload.location.locationId)) {
      push(errors, "location.locationId", "Expected non-empty string");
    }
    if (!isString(payload.location.name)) {
      push(errors, "location.name", "Expected non-empty string");
    }
    if (typeof payload.location.description !== "string") {
      push(errors, "location.description", "Expected string");
    }
    validateStringArray(payload.location.tags, "location.tags", errors);
    validateStringArray(payload.location.contentTags, "location.contentTags", errors);
    validateStringArray(payload.location.memoryFactIds, "location.memoryFactIds", errors);
  }

  if (!Array.isArray(payload.visibleEntities)) {
    push(errors, "visibleEntities", "Expected array");
  } else {
    payload.visibleEntities.forEach((entity, index) => appendNestedErrors(errors, `visibleEntities.${index}`, validateVisibleEntity(entity)));
  }
  if (!Array.isArray(payload.availableMoves)) {
    push(errors, "availableMoves", "Expected array");
  }
  if (!Array.isArray(payload.availableActions)) {
    push(errors, "availableActions", "Expected array");
  }
  if (!Array.isArray(payload.recentTimeline)) {
    push(errors, "recentTimeline", "Expected array");
  }
  if (!Array.isArray(payload.relevantMemoryFacts)) {
    push(errors, "relevantMemoryFacts", "Expected array");
  }

  if (!isPlainObject(payload.uiHints)) {
    push(errors, "uiHints", "Expected object");
  } else {
    if (payload.uiHints.layout !== "spatial_scene") {
      push(errors, "uiHints.layout", "Expected spatial_scene");
    }
    for (const key of ["showLocationImage", "showActionBar", "showEntityPanel", "showTimeline"]) {
      if (typeof payload.uiHints[key] !== "boolean") {
        push(errors, `uiHints.${key}`, "Expected boolean");
      }
    }
  }

  if (!Array.isArray(payload.errors)) {
    push(errors, "errors", "Expected array");
  }

  return result(errors);
}

export function summarizeSceneForUi(payload) {
  return {
    locationName: payload.location?.name || null,
    visibleEntityCount: Array.isArray(payload.visibleEntities) ? payload.visibleEntities.length : 0,
    availableMoveCount: Array.isArray(payload.availableMoves) ? payload.availableMoves.length : 0,
    availableActionCount: Array.isArray(payload.availableActions) ? payload.availableActions.length : 0
  };
}

export function buildSoloScenePayload(run, options = {}) {
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    return {
      ok: false,
      errors: runValidation.errors
    };
  }

  const currentLocation = run.locations[run.currentLocationId];
  if (!currentLocation) {
    return {
      ok: false,
      errors: [
        {
          path: "currentLocationId",
          message: "Location does not exist in locations"
        }
      ]
    };
  }

  const policyProfile = options.policyProfile || policyProfileForRun(run);
  if (!policyAllows(currentLocation, policyProfile)) {
    return {
      ok: false,
      errors: [
        {
          path: "location",
          message: "Current location is not allowed by policy profile"
        }
      ]
    };
  }

  const visibleEntities = getVisibleEntities(run, { policyProfile });
  const payload = {
    ok: true,
    runId: run.runId,
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    location: locationPayload(currentLocation),
    visibleEntities,
    availableMoves: getAvailableMoves(run).filter((move) => {
      const destination = run.locations[move.locationId];
      return destination ? policyAllows(destination, policyProfile) : false;
    }),
    availableActions: getAvailableSoloActions(run).filter((action) => {
      if (action.toLocationId) {
        const destination = run.locations[action.toLocationId];
        return destination ? policyAllows(destination, policyProfile) : false;
      }
      return true;
    }),
    recentTimeline: getRecentTimelineEvents(run, { policyProfile, limit: options.timelineLimit }),
    relevantMemoryFacts: getRelevantMemoryFacts(run, {
      policyProfile,
      visibleEntities,
      limit: options.memoryLimit
    }),
    uiHints: {
      layout: "spatial_scene",
      showLocationImage: true,
      showActionBar: true,
      showEntityPanel: true,
      showTimeline: true
    },
    errors: []
  };

  const payloadValidation = validateSoloScenePayload(payload);
  if (!payloadValidation.ok) {
    return {
      ok: false,
      errors: payloadValidation.errors
    };
  }

  return payload;
}
