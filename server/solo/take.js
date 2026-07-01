import crypto from "node:crypto";
import { validateSoloRun } from "./schema.js";
import { grantItemToRun } from "./search.js";

// ---------------------------------------------------------------------------
// TAKE mechanic (per-verb detectX -> resolveX, sibling to search/movement).
//
// Free-text "take the crate" / "pocket the relic" arrived as a generic `attempt`,
// so the GM narrated a pickup while inventory never changed (prose-ahead-of-state).
// This commits the acquisition: a PRESENT, DISCOVERED, TAKEABLE object (a revealed
// searchDetail carrying a grantItem identity) is moved into inventory and the source
// object is marked taken. Server-owns-truth: the item enters state, THEN the GM
// narrates it — never the reverse.
//
// COHERENCE FIREWALL: detectTakeIntent fires ONLY when the intent resolves to a real
// takeable object present at the current location. Taking something that isn't here /
// has no item identity returns null (falls through to the normal attempt path, which
// honestly declines) — the layer NEVER mints an item from thin air. This keeps the
// firewall intact without widening the interpreter's ALLOWED_EFFECT_TYPES.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromOption(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) {
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

// A pickup verb. Intentionally excludes bare "carry"/"move" (those read as travel),
// "claim" (a goal/authority declaration — "I claim this place as my own" belongs to
// detectPlayerGoal, never a pickup), and bare "lift" ("lift the curse"). "carry
// off/away" is included as an unambiguous acquisition.
const TAKE_VERB_RE =
  /\b(?:take|takes|taking|pick up|pick it up|pick them up|pick that up|pocket|pockets|grab|grabs|snatch|scoop up|scoop it up|loot|help myself to|pry (?:it |them )?(?:free|loose|out)|dig (?:it |them )?up|carry off|carry away|make off with|retrieve|collect|nab|swipe)\b/i;

// Generic object words that, when exactly ONE takeable object is present, are enough
// to bind "grab it" / "take the thing" to that object without a label match.
const GENERIC_OBJECT_RE =
  /\b(?:it|this|that|them|these|those|everything|thing|things|item|items|object|box|crate|parcel|package|relic|loot|goods|cargo|prize|find|stuff)\b/i;

const LABEL_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "at", "some", "half", "buried",
  "old", "ancient", "small", "large", "sealed", "hidden", "your", "his", "her"
]);

// Significant lowercase tokens from a detail's label (nouns worth matching on),
// merged with any authored takeKeywords[]. "A Sealed Crate" -> ["crate"] (+ authored).
function detailMatchTokens(detail) {
  const fromLabel = String(detail?.label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length >= 3 && !LABEL_STOPWORDS.has(word));
  const authored = Array.isArray(detail?.takeKeywords)
    ? detail.takeKeywords.map((k) => String(k || "").toLowerCase()).filter(Boolean)
    : [];
  return [...new Set([...fromLabel, ...authored])];
}

function presentNpcNamesLc(run) {
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  return npcs
    .filter((npc) => npc && npc.currentLocationId === run?.currentLocationId && npc.status !== "gone")
    .map((npc) => (isString(npc.displayName) ? npc.displayName.toLowerCase() : ""))
    .filter(Boolean);
}

/**
 * The takeable objects present at the current location: revealed searchDetails that
 * carry `takeable: true`, a grantItem identity, and have not yet been taken.
 * @param {object} run
 * @param {{ locationId?: string }} [options]
 * @returns {Array<{ detailId, label, index, grantItem, tokens: string[] }>}
 */
export function getTakeableDetails(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.locations) || !isString(run.currentLocationId)) {
    return [];
  }
  const locationId = options.locationId || run.currentLocationId;
  const location = run.locations[locationId];
  if (!isPlainObject(location) || !Array.isArray(location.searchDetails)) {
    return [];
  }
  return location.searchDetails
    .map((detail, index) => ({ detail, index }))
    .filter(({ detail }) =>
      isPlainObject(detail) &&
      detail.takeable === true &&
      detail.taken !== true &&
      detail.revealed === true &&
      isPlainObject(detail.grantItem)
    )
    .map(({ detail, index }) => ({
      detailId: detail.detailId,
      label: detail.label,
      index,
      grantItem: detail.grantItem,
      tokens: detailMatchTokens(detail)
    }));
}

/**
 * Classifies a free-text intent as taking a PRESENT, DISCOVERED, TAKEABLE object.
 * Returns { take: true, detailId, locationId } or null. Fires only when a real
 * takeable object is present AND the intent references it (by label/keyword token,
 * or a generic object word when exactly one takeable is present). A take aimed at a
 * present NPC ("take the guard's coin") is not an object pickup and returns null.
 * @param {object} run
 * @param {string} intent
 */
export function detectTakeIntent(run, intent) {
  const text = String(intent || "").toLowerCase();
  if (!isString(text) || !TAKE_VERB_RE.test(text)) {
    return null;
  }
  const takeables = getTakeableDetails(run);
  if (takeables.length === 0) {
    return null; // nothing here to take — never mint an item from thin air.
  }
  // Don't hijack "take the <npc>'s ..." — a person target is not an area object.
  if (presentNpcNamesLc(run).some((name) => name && text.includes(name))) {
    return null;
  }
  // 1) Prefer an explicit token match against a specific takeable.
  const byToken = takeables.find((t) => t.tokens.some((token) => text.includes(token)));
  if (byToken) {
    return { take: true, detailId: byToken.detailId, locationId: run.currentLocationId };
  }
  // 2) Exactly one takeable present + a generic object word ("grab it") -> bind it.
  if (takeables.length === 1 && GENERIC_OBJECT_RE.test(text)) {
    return { take: true, detailId: takeables[0].detailId, locationId: run.currentLocationId };
  }
  return null;
}

export function validateTakeAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    runValidation.errors.forEach((error) => errors.push({ path: `run.${error.path}`, message: error.message }));
  }
  if (!isPlainObject(action)) {
    errors.push({ path: "action", message: "Expected object" });
    return { ok: errors.length === 0, errors };
  }
  if (action.type !== "take") {
    errors.push({ path: "action.type", message: "Expected take" });
  }
  if (!isString(action.detailId)) {
    errors.push({ path: "action.detailId", message: "Expected non-empty string" });
  }
  return { ok: errors.length === 0, errors };
}

function createTakeMemoryFact(run, action, detail, granted, options) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const locationId = action.targetLocationId ?? run.currentLocationId;
  return {
    factId: idFactory("fact_take"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", locationId])],
    type: "item_taken",
    text: `You took ${granted.name}.`,
    source: "system",
    createdAt: now,
    tags: ["system", "take"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: detail.contentTags || [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: { detailId: detail.detailId, itemId: granted.itemId, locationId }
  };
}

function createTakeTimelineEvent(run, action, detail, granted, memoryFact, options) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const locationId = action.targetLocationId ?? run.currentLocationId;
  return {
    eventId: idFactory("event_take"),
    type: "take",
    title: "Item Taken",
    summary: `You take ${granted.name}.`,
    createdAt: now,
    locationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", locationId])],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "take"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: detail.contentTags || [],
    payload: { actorId: action.actorId ?? "player", locationId, detailId: detail.detailId, itemId: granted.itemId }
  };
}

/**
 * Commits a take: moves a present takeable object's item into inventory (via the
 * shared grantItemToRun primitive) and marks the source searchDetail taken so it
 * cannot be re-taken. Refuses (ok:false) when the target is absent, already taken,
 * or carries no item identity — the take never commits unless there is a real object.
 * @param {object} run
 * @param {{ type:"take", detailId:string, actorId?:string, targetLocationId?:string }} action
 * @param {object} [options]
 */
export function resolveTakeAction(run, action, options = {}) {
  const validation = validateTakeAction(run, action);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const locationId = action.targetLocationId ?? updatedRun.currentLocationId;
  const location = updatedRun.locations?.[locationId];
  if (!isPlainObject(location) || !Array.isArray(location.searchDetails)) {
    return { ok: false, errors: [{ path: "action.targetLocationId", message: "No takeable object here" }] };
  }
  const index = location.searchDetails.findIndex(
    (detail) =>
      isPlainObject(detail) &&
      detail.detailId === action.detailId &&
      detail.takeable === true &&
      detail.taken !== true &&
      detail.revealed === true &&
      isPlainObject(detail.grantItem)
  );
  if (index < 0) {
    return { ok: false, errors: [{ path: "action.detailId", message: "Nothing here to take" }] };
  }
  const detail = location.searchDetails[index];
  const granted = grantItemToRun(updatedRun, detail.grantItem);
  if (!granted) {
    return { ok: false, errors: [{ path: "detail.grantItem", message: "Takeable object has no item identity" }] };
  }
  // Mark the source object taken (stays revealed so its lore persists, but it can
  // no longer be picked up — no duplicate grabs).
  location.searchDetails[index] = { ...detail, taken: true };

  const memoryFact = createTakeMemoryFact(updatedRun, action, detail, granted, { now, idFactory });
  const timelineEvent = createTakeTimelineEvent(updatedRun, action, detail, granted, memoryFact, { now, idFactory });
  updatedRun.memoryFacts = [...(updatedRun.memoryFacts || []), memoryFact];
  location.memoryFactIds = [...new Set([...(location.memoryFactIds || []), memoryFact.factId])];
  updatedRun.timeline = [...(updatedRun.timeline || []), timelineEvent];
  updatedRun.updatedAt = now;

  const finalValidation = validateSoloRun(updatedRun);
  if (!finalValidation.ok) {
    return { ok: false, errors: finalValidation.errors };
  }

  return {
    ok: true,
    run: updatedRun,
    event: timelineEvent,
    memoryFact,
    takeResult: {
      taken: true,
      detailId: detail.detailId,
      label: detail.label,
      itemId: granted.itemId,
      name: granted.name,
      quantity: granted.quantity
    },
    errors: []
  };
}
