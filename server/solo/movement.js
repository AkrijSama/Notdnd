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

// --- Move-INTENT detection (M.1 fix) -----------------------------------------
// A suggested/free-text action like "Head toward Grayveil Market" arrives as a
// generic `attempt` (free-text intent), so it was resolved as narrative flavor —
// the GM narrated arriving while run.currentLocationId never changed (prose
// claiming state that didn't happen). detectMoveIntent lets the SERVER recognize
// a directed move and route it to resolveMovementAction so the position actually
// COMMITS. Same server-owns-truth doctrine as the authority gate: a move narrated
// as success must correspond to a real committed position change.
const MOVE_VERB =
  "(?:head(?:ing)?|go(?:ing)?|move|moving|travel(?:l?ing)?|walk(?:ing)?|journey(?:ing)?|proceed(?:ing)?|venture|set (?:out|off)|make (?:my|your|our) way|depart|press on|continue on|march|ride|make for|set (?:my|your|our) sights)";
// Requires a directional preposition, so "search here" / "look around" / "climb
// the wall" never false-trigger — only a DIRECTED move. Kept broad (down/back/
// onward/along/…) because free-text players phrase moves many ways; this is SAFE
// because detectMoveIntent only reroutes to a commit when a real reachable exit
// NAME actually matches — otherwise it falls through to a normal attempt.
const MOVE_PREP =
  "(?:to|toward|towards|for|into|onto|over to|on to|out (?:to|toward|towards)|down|up|back|onward|onwards|ahead|further|along|through|past|across|over|out)";
const MOVE_INTENT_RE = new RegExp(`\\b${MOVE_VERB}\\b[^.?!]*?\\b${MOVE_PREP}\\b`, "i");
const LOCATION_STOPWORDS = new Set(["the", "a", "an", "of", "and", "to", "at", "in", "on", "near", "old", "new"]);

function locationNameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !LOCATION_STOPWORDS.has(token));
}
// Fraction of a location's distinctive name tokens that appear in the intent.
function nameMatchScore(intentLc, name) {
  const tokens = locationNameTokens(name);
  if (!tokens.length) {
    return 0;
  }
  const hits = tokens.filter((token) => intentLc.includes(token)).length;
  return hits / tokens.length;
}

/**
 * Classifies a free-text intent as a move and resolves its destination against
 * server-owned run state. Returns:
 *   { reachable:true, toLocationId, name }              -> commit a move there
 *   { reachable:false, knownUnreachable:true, name }    -> a KNOWN place not
 *        connected from here: refuse (don't narrate a false arrival)
 *   { reachable:false }                                 -> move-ish but no
 *        identifiable destination -> let it resolve as a normal attempt
 *   null                                                -> not a move intent
 * The reachable match must be UNAMBIGUOUS (a single clear best), so a name shared
 * across two exits never silently commits the wrong one.
 * @param {object} run
 * @param {string} intent
 */
export function detectMoveIntent(run, intent) {
  const text = String(intent || "").toLowerCase();
  if (!text || !MOVE_INTENT_RE.test(text)) {
    return null;
  }
  const moves = getAvailableMoves(run);
  const scored = moves
    .map((move) => ({ move, score: nameMatchScore(text, move.name) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    const best = scored[0];
    const ambiguous = scored.length > 1 && scored[1].score === best.score;
    if (!ambiguous) {
      return { reachable: true, toLocationId: best.move.locationId, name: best.move.name };
    }
  }
  // Move intent naming a KNOWN location that is NOT reachable from here.
  if (isPlainObject(run?.locations)) {
    for (const [id, location] of Object.entries(run.locations)) {
      if (id === run.currentLocationId || !isPlainObject(location)) {
        continue;
      }
      if (nameMatchScore(text, location.name) >= 0.75) {
        return { reachable: false, knownUnreachable: true, name: location.name };
      }
    }
  }
  return { reachable: false };
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
    .map((location) => {
      // M.2 — geo-knowledge gate: an UNDISCOVERED adjacent location is an unnamed
      // path (you can see a way leads out, not where it goes). Its real name is
      // never exposed until a reveal event (arrival / told-of / map) sets
      // state.discovered. This keeps the LLM from "revealing geography by narrating
      // it" — the name lives in server state, not in prose. The move still commits
      // (locationId is intact); arrival flips discovered and names it.
      const discovered = location.state?.discovered === true || location.state?.visited === true;
      return {
        locationId: location.locationId,
        name: discovered ? location.name : "An unexplored path",
        discovered,
        direction: null,
        imageAssetId: discovered ? location.imageAssetId ?? null : null,
        edition: location.edition ?? null,
        policyProfileId: location.policyProfileId ?? null
      };
    });
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
