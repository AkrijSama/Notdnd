import crypto from "node:crypto";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";
import { resolveAbilityCheck } from "./rules.js";

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

function policyAllows(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity, policyProfile).ok;
}

function normalizeDetail(detail, location, index) {
  return {
    detailId: detail.detailId,
    label: detail.label,
    description: detail.description,
    revealed: detail.revealed === true,
    contentTags: detail.contentTags || [],
    linkedEntityIds: detail.linkedEntityIds || [],
    linkedMemoryFactIds: detail.linkedMemoryFactIds || [],
    check: detail.check || null,
    // Consequence spine: a search detail may award an item on reveal. Accepts a
    // `grantItem` (or legacy `reward`) descriptor; null when the detail is lore only.
    grantItem: isPlainObject(detail.grantItem) ? detail.grantItem : (isPlainObject(detail.reward) ? detail.reward : null),
    edition: detail.edition ?? location.edition ?? null,
    policyProfileId: detail.policyProfileId ?? location.policyProfileId ?? null,
    index
  };
}

// Adds a granted item into BOTH the run-level inventory object (keyed by itemId,
// what useItem reads) and the state-contract player.inventory array (what the UI
// renders). Idempotent on quantity: re-finding the same id stacks it.
// EXPORTED: the shared inventory-commit primitive reused by the take mechanic and
// the quest-reward lifecycle (a takeable object / a delivery payout both land here),
// so a picked-up object and a quest reward mutate state exactly like a search grant.
export function grantItemToRun(run, descriptor) {
  if (!isPlainObject(descriptor)) {
    return null;
  }
  const itemId = isString(descriptor.itemId) ? descriptor.itemId : (isString(descriptor.id) ? descriptor.id : null);
  if (!itemId) {
    return null;
  }
  const qty = typeof descriptor.qty === "number" ? descriptor.qty : (typeof descriptor.quantity === "number" ? descriptor.quantity : 1);
  const name = isString(descriptor.name) ? descriptor.name : itemId;
  if (!isPlainObject(run.inventory)) {
    run.inventory = {};
  }
  const existingRun = run.inventory[itemId];
  run.inventory[itemId] = {
    itemId,
    name,
    description: isString(descriptor.description) ? descriptor.description : (existingRun?.description || ""),
    quantity: (typeof existingRun?.quantity === "number" ? existingRun.quantity : 0) + qty,
    usable: descriptor.usable === true || existingRun?.usable === true,
    consumable: descriptor.consumable !== false,
    tags: Array.isArray(descriptor.tags) ? descriptor.tags : (existingRun?.tags || []),
    flags: isPlainObject(descriptor.flags) ? descriptor.flags : (existingRun?.flags || {}),
    use: isPlainObject(descriptor.use) ? descriptor.use : existingRun?.use
  };
  if (!Array.isArray(run.player?.inventory)) {
    if (!isPlainObject(run.player)) {
      run.player = {};
    }
    run.player.inventory = [];
  }
  const existingArr = run.player.inventory.find((entry) => isPlainObject(entry) && (entry.id === itemId || entry.itemId === itemId));
  if (existingArr) {
    existingArr.qty = (typeof existingArr.qty === "number" ? existingArr.qty : 0) + qty;
  } else {
    run.player.inventory.push({ id: itemId, name, qty });
  }
  return { itemId, name, quantity: run.inventory[itemId].quantity };
}

// Removes `qty` of an item from BOTH inventory mirrors (run.inventory object +
// player.inventory array). Deletes the entry when the count reaches zero. Returns
// { itemId, consumed } when something was removed, else null. Used by the quest
// lifecycle: handing over a delivered item on completion removes it from the bag,
// so "you delivered it" is true in state (the crate is gone), not just narrated.
export function consumeItemFromRun(run, itemId, qty = 1) {
  if (!isString(itemId)) {
    return null;
  }
  let removed = false;
  if (isPlainObject(run.inventory) && isPlainObject(run.inventory[itemId])) {
    const current = typeof run.inventory[itemId].quantity === "number" ? run.inventory[itemId].quantity : 0;
    const next = current - qty;
    if (next > 0) {
      run.inventory[itemId].quantity = next;
    } else {
      delete run.inventory[itemId];
    }
    removed = true;
  }
  if (Array.isArray(run.player?.inventory)) {
    const index = run.player.inventory.findIndex(
      (entry) => isPlainObject(entry) && (entry.id === itemId || entry.itemId === itemId)
    );
    if (index >= 0) {
      const entry = run.player.inventory[index];
      const current = typeof entry.qty === "number" ? entry.qty : 0;
      const next = current - qty;
      if (next > 0) {
        entry.qty = next;
      } else {
        run.player.inventory.splice(index, 1);
      }
      removed = true;
    }
  }
  return removed ? { itemId, consumed: qty } : null;
}

function detailFactExists(run, detailId) {
  return (run.memoryFacts || []).some((fact) => fact.type === "search_discovery" && fact.payload?.detailId === detailId);
}

// --- Search-INTENT detection (hollow-core fix, Part 2) -----------------------
// Free-text "search the ruins for anything useful" arrives as a generic `attempt`,
// so it was resolved as narrative flavor: a winning roll narrated "you find
// nothing of import" while the location's PLACED searchDetails (the ruins hall,
// the well, the cache) were never revealed — discoveredDetails stayed 0 across a
// whole session. detectSearchIntent recognizes an AREA search and routes it to
// resolveSearchAction so a placed feature is actually revealed and COMMITTED to
// state (same server-owns-truth doctrine as the move fix: advancement is
// committed by the mechanic, then narrated — never asserted in prose alone).
const SEARCH_VERB_RE =
  /\b(?:search|scour|comb|rummage|forage|sift|ransack|rifle|scavenge|dig (?:through|around|into)|poke around|look (?:for|around|about|through)|hunt (?:for|around|through)|explore\b[^.?!]*\bfor\b|check\b[^.?!]*\bfor\b)\b/i;
// Marks an AREA search (vs "search the guard's pockets"): a place/generic target,
// or a "for <loot/clues/…>" clause. Keeps a person-search out of the location path.
const SEARCH_AREA_RE =
  /\b(?:area|room|ruins?|surroundings?|walls?|floor|rubble|debris|place|here|around|nearby|ground|corner|chamber|hall|passage|everything|for (?:anything|something|clues?|loot|valuables?|supplies|useful|hidden|secrets?|traps?|treasure))\b/i;

function presentNpcNamesLc(run) {
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  return npcs
    .filter((npc) => npc && npc.currentLocationId === run?.currentLocationId && npc.status !== "gone")
    .map((npc) => (isString(npc.displayName) ? npc.displayName.toLowerCase() : ""))
    .filter(Boolean);
}

/**
 * Classifies a free-text intent as an AREA search of the current location.
 * Returns { search: true } to route to resolveSearchAction, or null. A search that
 * names a present NPC (searching a person) is NOT an area search and returns null.
 * @param {object} run
 * @param {string} intent
 */
export function detectSearchIntent(run, intent) {
  const text = String(intent || "").toLowerCase();
  if (!isString(text) || !SEARCH_VERB_RE.test(text) || !SEARCH_AREA_RE.test(text)) {
    return null;
  }
  if (presentNpcNamesLc(run).some((name) => text.includes(name))) {
    return null;
  }
  return { search: true };
}

export function getSearchableDetails(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.locations) || !isString(run.currentLocationId)) {
    return [];
  }

  const locationId = options.locationId || run.currentLocationId;
  const location = run.locations[locationId];
  if (!isPlainObject(location) || !Array.isArray(location.searchDetails)) {
    return [];
  }

  const policyProfile = options.policyProfile || policyProfileForRun(run);
  return location.searchDetails
    .map((detail, index) => normalizeDetail(detail, location, index))
    .filter((detail) => policyAllows(detail, policyProfile));
}

export function validateSearchAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }

  if (action.type !== "search") {
    push(errors, "action.type", "Expected search");
  }

  if (!isPlainObject(run) || !isPlainObject(run.locations)) {
    return result(errors);
  }

  if (!isString(run.currentLocationId)) {
    push(errors, "run.currentLocationId", "Expected non-empty string");
    return result(errors);
  }

  const targetLocationId = action.targetLocationId ?? run.currentLocationId;
  if (!isString(targetLocationId)) {
    push(errors, "action.targetLocationId", "Expected non-empty string");
    return result(errors);
  }

  if (targetLocationId !== run.currentLocationId) {
    push(errors, "action.targetLocationId", "Only the current location can be searched");
  }

  const location = run.locations[targetLocationId];
  if (!isPlainObject(location)) {
    push(errors, "action.targetLocationId", "Target location does not exist");
    return result(errors);
  }

  if (run.edition === "mainline" && location.edition === "forbidden") {
    push(errors, "action.targetLocationId", "Mainline runs cannot search forbidden locations");
  }

  const profile = policyProfileForRun(run);
  const policyValidation = validateEntityAgainstPolicy(location, profile);
  for (const error of policyValidation.errors) {
    push(errors, `location.${error.path}`, error.message);
  }

  if (location.searchDetails !== undefined && !Array.isArray(location.searchDetails)) {
    push(errors, `run.locations.${targetLocationId}.searchDetails`, "Expected array");
  }

  return result(errors);
}

export function createSearchMemoryFact(run, action, detail, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const locationId = action.targetLocationId ?? run.currentLocationId;

  return {
    factId: idFactory("fact_search"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", locationId, ...(detail.linkedEntityIds || [])])],
    type: "search_discovery",
    text: detail.description,
    source: "system",
    createdAt: now,
    tags: ["system", "search"],
    edition: detail.edition ?? run.edition,
    policyProfileId: detail.policyProfileId ?? run.policyProfileId,
    contentTags: detail.contentTags || [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: {
      detailId: detail.detailId,
      locationId
    }
  };
}

export function createSearchTimelineEvent(run, action, searchResult, memoryFact, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const locationId = action.targetLocationId ?? run.currentLocationId;

  return {
    eventId: idFactory("event_search"),
    type: "search",
    title: searchResult.found ? "Area Searched" : "Search Completed",
    summary: searchResult.summary,
    createdAt: now,
    locationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", locationId, ...(searchResult.linkedEntityIds || [])])],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "search"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: searchResult.contentTags || [],
    payload: {
      actorId: action.actorId ?? "player",
      locationId,
      found: searchResult.found,
      revealedDetailIds: searchResult.revealedDetailIds || [],
      checkResult: searchResult.checkResult || null
    }
  };
}

export function resolveSearchAction(run, action, options = {}) {
  const validation = validateSearchAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const targetLocationId = action.targetLocationId ?? updatedRun.currentLocationId;
  const location = updatedRun.locations[targetLocationId];
  const details = getSearchableDetails(updatedRun, { locationId: targetLocationId });
  const reveal = details.find((detail) => detail.revealed !== true);
  const checkResult = reveal?.check ? resolveAbilityCheck(updatedRun, {
    checkId: reveal.check.checkId || `check_${reveal.detailId}`,
    rulesetId: reveal.check.rulesetId || updatedRun.rulesetId || updatedRun.player?.rulesetId || "notdnd_basic",
    ability: reveal.check.ability,
    skill: reveal.check.skill ?? null,
    dc: reveal.check.dc,
    advantage: reveal.check.advantage === true,
    disadvantage: reveal.check.disadvantage === true
  }, options) : null;

  if (checkResult && !checkResult.ok) {
    return {
      ok: false,
      errors: checkResult.errors.map((error) => ({
        path: `detail.check.${error.path}`,
        message: error.message
      }))
    };
  }

  const canReveal = Boolean(reveal) && (!checkResult || checkResult.success === true);
  let memoryFact = null;
  const searchResult = canReveal
    ? {
        locationId: targetLocationId,
        found: true,
        summary: reveal.description,
        revealedDetailIds: [reveal.detailId],
        linkedEntityIds: reveal.linkedEntityIds || [],
        linkedMemoryFactIds: reveal.linkedMemoryFactIds || [],
        contentTags: reveal.contentTags || [],
        checkResult,
        warningCodes: []
      }
    : {
        locationId: targetLocationId,
        found: false,
        summary: reveal && checkResult ? "You do not find anything new right now." : "You find nothing new right now.",
        revealedDetailIds: [],
        linkedEntityIds: [],
        linkedMemoryFactIds: [],
        contentTags: [],
        checkResult,
        warningCodes: reveal && checkResult ? ["SEARCH_CHECK_FAILED"] : ["SEARCH_NOTHING_NEW"]
      };

  if (canReveal) {
    location.searchDetails[reveal.index] = {
      ...location.searchDetails[reveal.index],
      revealed: true
    };
    if (!detailFactExists(updatedRun, reveal.detailId)) {
      memoryFact = createSearchMemoryFact(updatedRun, action, reveal, { now, idFactory });
    }
    // Consequence spine: a successful search that reveals an item-bearing detail
    // grants that item into the player's inventory (next turn the scene shows it).
    if (reveal.grantItem) {
      const granted = grantItemToRun(updatedRun, reveal.grantItem);
      if (granted) {
        searchResult.grantedItem = granted;
      }
    }
  }

  const timelineEvent = createSearchTimelineEvent(updatedRun, action, searchResult, memoryFact, { now, idFactory });

  updatedRun.updatedAt = now;
  updatedRun.timeline = [...updatedRun.timeline, timelineEvent];
  if (memoryFact) {
    updatedRun.memoryFacts = [...updatedRun.memoryFacts, memoryFact];
    location.memoryFactIds = [...new Set([...(location.memoryFactIds || []), memoryFact.factId])];
  }

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
    searchResult,
    errors: []
  };
}
