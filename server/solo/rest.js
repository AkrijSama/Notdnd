import crypto from "node:crypto";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";
import { advanceClock } from "./worldClock.js";
import { tickConditions } from "./conditions.js";

const REST_TYPES = new Set(["short", "long"]);
// WORLD CLOCK (#14): rest's legacy `timeAdvanced` is in HOURS (short=1, long=8);
// convert to real minutes so a long rest actually rolls the day into night/morning.
const REST_HOUR_MINUTES = 60;

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

function appendPrefixedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function defaultRestMetadata(location, run) {
  return {
    allowed: location?.rest?.allowed !== false,
    safety: location?.rest?.safety || "safe",
    availableTypes: Array.isArray(location?.rest?.availableTypes) ? location.rest.availableTypes : ["short"],
    contentTags: location?.rest?.contentTags || [],
    edition: location?.rest?.edition ?? location?.edition ?? run?.edition,
    policyProfileId: location?.rest?.policyProfileId ?? location?.policyProfileId ?? run?.policyProfileId
  };
}

function locationRestAllowed(run, location) {
  const policyProfile = policyProfileForRun(run);
  const rest = defaultRestMetadata(location, run);
  const policyValidation = validateEntityAgainstPolicy(rest, policyProfile);
  return {
    rest,
    policyValidation
  };
}

function recoverGauge(gauge, amount = null) {
  if (!isPlainObject(gauge) || typeof gauge.current !== "number" || typeof gauge.max !== "number") {
    return null;
  }
  const before = gauge.current;
  const next = amount === null ? gauge.max : Math.min(gauge.max, gauge.current + amount);
  gauge.current = next;
  if (next <= before) {
    return null;
  }
  return {
    resourceId: null,
    before,
    after: next,
    amount: next - before
  };
}

export function getAvailableRestTypes(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.locations) || !isString(run.currentLocationId)) {
    return [];
  }
  const locationId = options.locationId || run.currentLocationId;
  const location = run.locations[locationId];
  if (!isPlainObject(location)) {
    return [];
  }
  const { rest, policyValidation } = locationRestAllowed(run, location);
  if (rest.allowed !== true || !policyValidation.ok) {
    return [];
  }
  return rest.availableTypes.filter((restType) => REST_TYPES.has(restType));
}

export function validateRestAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }
  if (action.type !== "rest") {
    push(errors, "action.type", "Expected rest");
  }

  const restType = action.restType || "short";
  if (!REST_TYPES.has(restType)) {
    push(errors, "action.restType", "Expected one of: short, long");
  }

  if (!isPlainObject(run) || !isPlainObject(run.locations)) {
    return result(errors);
  }

  const targetLocationId = action.targetLocationId ?? run.currentLocationId;
  if (!isString(targetLocationId)) {
    push(errors, "action.targetLocationId", "Expected non-empty string");
    return result(errors);
  }
  if (targetLocationId !== run.currentLocationId) {
    push(errors, "action.targetLocationId", "Only the current location can be rested in");
  }

  const location = run.locations[targetLocationId];
  if (!isPlainObject(location)) {
    push(errors, "action.targetLocationId", "Target location does not exist");
    return result(errors);
  }

  return result(errors);
}

export function createRestTimelineEvent(run, action, restResult, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  return {
    eventId: idFactory("event_rest"),
    type: "rest",
    title: restResult.restType === "long" ? "Long Rest" : "Short Rest",
    summary: restResult.summary,
    createdAt: now,
    locationId: restResult.locationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", restResult.locationId])],
    memoryFactIds: [],
    tags: ["system", "rest"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: {
      actorId: action.actorId ?? "player",
      restType: restResult.restType,
      timeAdvanced: restResult.timeAdvanced,
      resourcesRecovered: restResult.resourcesRecovered
    }
  };
}

export function resolveRestAction(run, action, options = {}) {
  const validation = validateRestAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const restType = action.restType || "short";
  const targetLocationId = action.targetLocationId ?? updatedRun.currentLocationId;
  const location = updatedRun.locations[targetLocationId];
  const { rest, policyValidation } = locationRestAllowed(updatedRun, location);
  const timeAdvanced = restType === "long" ? 8 : 1;
  const resourcesRecovered = [];

  if (rest.allowed !== true || !policyValidation.ok || !rest.availableTypes.includes(restType)) {
    return {
      ok: true,
      run: null,
      event: null,
      memoryFact: null,
      restResult: {
        locationId: targetLocationId,
        restType,
        allowed: false,
        safety: rest.safety || "unsafe",
        timeAdvanced: 0,
        resourcesRecovered: [],
        summary: "You cannot rest here right now.",
        warningCodes: [
          rest.allowed !== true ? "REST_NOT_ALLOWED" : null,
          !policyValidation.ok ? "REST_POLICY_BLOCKED" : null,
          !rest.availableTypes.includes(restType) ? "REST_TYPE_UNAVAILABLE" : null
        ].filter(Boolean)
      },
      errors: []
    };
  }

  if (updatedRun.world?.time && typeof updatedRun.world.time.tick === "number") {
    updatedRun.world.time.tick += timeAdvanced;
    updatedRun.world.time.lastAdvancedAt = now;
  }
  // WORLD CLOCK (#14): advance the real minutes clock by the rest's hours so the
  // day/night phase moves (a long rest passes 8h; short passes 1h). Bounded by the
  // per-advance cap in advanceClock, so a long rest lands as a large-but-sane jump.
  advanceClock(updatedRun, timeAdvanced * REST_HOUR_MINUTES, { now, fallback: timeAdvanced * REST_HOUR_MINUTES });
  // CONDITIONS (#26): a rest passes hours — shed every timed condition it outlasts
  // (a long rest clears most afflictions; a short rest clears the brief ones).
  tickConditions(updatedRun, updatedRun.world?.time?.minutes);

  const resources = updatedRun.player?.resources || {};
  if (restType === "short") {
    const staminaRecovery = recoverGauge(resources.stamina, 2);
    if (staminaRecovery) {
      resourcesRecovered.push({ ...staminaRecovery, resourceId: "stamina" });
    }
  } else {
    const staminaRecovery = recoverGauge(resources.stamina, null);
    if (staminaRecovery) {
      resourcesRecovered.push({ ...staminaRecovery, resourceId: "stamina" });
    }
    const hpRecovery = recoverGauge(resources.hitPoints, null);
    if (hpRecovery) {
      resourcesRecovered.push({ ...hpRecovery, resourceId: "hitPoints" });
    }
  }

  const restResult = {
    locationId: targetLocationId,
    restType,
    allowed: true,
    safety: rest.safety,
    timeAdvanced,
    resourcesRecovered,
    summary: restType === "long" ? "Time passes as you rest." : "You take a moment to recover.",
    warningCodes: []
  };
  const timelineEvent = createRestTimelineEvent(updatedRun, action, restResult, { now, idFactory });

  updatedRun.updatedAt = now;
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
    memoryFact: null,
    restResult,
    errors: []
  };
}
