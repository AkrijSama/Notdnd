import crypto from "node:crypto";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";

const ITEM_EFFECT_TYPES = new Set(["message", "recover_resource", "reveal_note"]);

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

function normalizeItem(item, index = 0) {
  return {
    itemId: item.itemId,
    templateId: item.templateId ?? null,
    name: item.name,
    description: item.description || "",
    quantity: item.quantity,
    usable: item.usable === true,
    consumable: item.consumable === true,
    imageAssetId: item.imageAssetId ?? null,
    tags: item.tags || [],
    contentTags: item.contentTags || [],
    edition: item.edition ?? null,
    policyProfileId: item.policyProfileId ?? null,
    use: item.use || null,
    index
  };
}

function deniedResult(itemId, warningCode, summary = "You cannot use that item right now.") {
  return {
    itemId: itemId || null,
    itemName: null,
    effectType: null,
    used: false,
    consumed: false,
    quantityRemaining: null,
    resourcesRecovered: [],
    summary,
    revealedNote: null,
    warningCodes: [warningCode].filter(Boolean)
  };
}

function recoverResource(player, resourceId, amount) {
  const gauge = player?.resources?.[resourceId];
  if (!isPlainObject(gauge) || typeof gauge.current !== "number" || typeof gauge.max !== "number") {
    return null;
  }
  const before = gauge.current;
  const next = Math.min(gauge.max, before + Math.max(0, amount));
  gauge.current = next;
  if (next <= before) {
    return null;
  }
  return {
    resourceId,
    before,
    after: next,
    amount: next - before
  };
}

function itemFactExists(run, itemId) {
  return (run.memoryFacts || []).some((fact) => fact.type === "item_note_revealed" && fact.payload?.itemId === itemId);
}

export function getUsableInventoryItems(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.inventory)) {
    return [];
  }
  const policyProfile = options.policyProfile || policyProfileForRun(run);
  return Object.values(run.inventory)
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => item.quantity > 0 && item.usable === true && policyAllows(item, policyProfile))
    .map((item) => ({
      itemId: item.itemId,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      usable: item.usable,
      consumable: item.consumable,
      imageAssetId: item.imageAssetId,
      availableActions: ["use_item"],
      contentTags: item.contentTags,
      edition: item.edition,
      policyProfileId: item.policyProfileId
    }));
}

export function validateUseItemAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }
  if (action.type !== "use_item") {
    push(errors, "action.type", "Expected use_item");
  }
  if (!isString(action.itemId)) {
    push(errors, "action.itemId", "Expected non-empty string");
    return result(errors);
  }

  if (!isPlainObject(run) || !isPlainObject(run.inventory)) {
    return result(errors);
  }

  const item = run.inventory[action.itemId];
  if (!isPlainObject(item)) {
    push(errors, "action.itemId", "Item does not exist in inventory");
    return result(errors);
  }
  if (typeof item.quantity !== "number" || item.quantity <= 0) {
    push(errors, "action.itemId", "Item quantity must be greater than zero");
  }
  if (item.usable !== true) {
    push(errors, "action.itemId", "Item is not usable");
  }
  if (!isPlainObject(item.use) || !ITEM_EFFECT_TYPES.has(item.use.effectType)) {
    push(errors, "item.use.effectType", "Item use effect is invalid");
  }

  return result(errors);
}

export function createUseItemMemoryFact(run, action, item, useItemResult, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  return {
    factId: idFactory("fact_item"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", item.itemId])],
    type: "item_note_revealed",
    text: useItemResult.revealedNote,
    source: "system",
    createdAt: now,
    tags: ["system", "item"],
    edition: item.edition ?? run.edition,
    policyProfileId: item.policyProfileId ?? run.policyProfileId,
    contentTags: item.contentTags || [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: {
      itemId: item.itemId,
      effectType: useItemResult.effectType
    }
  };
}

export function createUseItemTimelineEvent(run, action, useItemResult, memoryFact, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  return {
    eventId: idFactory("event_item"),
    type: "use_item",
    title: useItemResult.used ? "Item Used" : "Item Use Failed",
    summary: useItemResult.summary,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", run.currentLocationId, useItemResult.itemId].filter(Boolean))],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "item"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: {
      actorId: action.actorId ?? "player",
      itemId: useItemResult.itemId,
      effectType: useItemResult.effectType,
      used: useItemResult.used,
      consumed: useItemResult.consumed,
      resourcesRecovered: useItemResult.resourcesRecovered || []
    }
  };
}

export function resolveUseItemAction(run, action, options = {}) {
  const validation = validateUseItemAction(run, action);
  if (!validation.ok) {
    const item = run?.inventory?.[action?.itemId];
    const policyValidation = isPlainObject(item) ? validateEntityAgainstPolicy(item, policyProfileForRun(run)) : { ok: true };
    if (isPlainObject(item) && !policyValidation.ok) {
      return {
        ok: true,
        run: null,
        event: null,
        memoryFact: null,
        useItemResult: deniedResult(action.itemId, "ITEM_BLOCKED_BY_POLICY", "You cannot use that item here."),
        errors: []
      };
    }
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const item = updatedRun.inventory[action.itemId];
  const policyValidation = validateEntityAgainstPolicy(item, policyProfileForRun(updatedRun));
  if (!policyValidation.ok) {
    return {
      ok: true,
      run: null,
      event: null,
      memoryFact: null,
      useItemResult: deniedResult(action.itemId, "ITEM_BLOCKED_BY_POLICY", "You cannot use that item here."),
      errors: []
    };
  }

  const effect = item.use || {};
  const effectType = effect.effectType;
  const resourcesRecovered = [];
  let memoryFact = null;
  let revealedNote = null;
  let summary = effect.summary || `${item.name} is used.`;

  if (effectType === "recover_resource") {
    const recovered = recoverResource(updatedRun.player, effect.resource, Number(effect.amount || 0));
    if (recovered) {
      resourcesRecovered.push(recovered);
    }
    summary = effect.summary || (recovered ? `${item.name} helps recover ${recovered.resourceId}.` : `${item.name} has no additional effect right now.`);
  } else if (effectType === "reveal_note") {
    revealedNote = effect.note || null;
    summary = effect.summary || revealedNote || `${item.name} reveals a note.`;
  } else if (effectType === "message") {
    summary = effect.summary || `${item.name} is used.`;
  } else {
    return {
      ok: true,
      run: null,
      event: null,
      memoryFact: null,
      useItemResult: deniedResult(action.itemId, "ITEM_EFFECT_INVALID", "That item has no valid use effect."),
      errors: []
    };
  }

  let consumed = false;
  if (item.consumable === true) {
    item.quantity = Math.max(0, item.quantity - 1);
    consumed = true;
  }

  const useItemResult = {
    itemId: item.itemId,
    itemName: item.name,
    effectType,
    used: true,
    consumed,
    quantityRemaining: item.quantity,
    resourcesRecovered,
    summary,
    revealedNote,
    warningCodes: []
  };

  if (effectType === "reveal_note" && revealedNote && !itemFactExists(updatedRun, item.itemId)) {
    memoryFact = createUseItemMemoryFact(updatedRun, action, item, useItemResult, options);
    updatedRun.memoryFacts.push(memoryFact);
  }

  const event = createUseItemTimelineEvent(updatedRun, action, useItemResult, memoryFact, options);
  updatedRun.timeline.push(event);
  updatedRun.updatedAt = isoFromOption(options.now ?? action.createdAt);

  const finalValidation = validateSoloRun(updatedRun);
  if (!finalValidation.ok) {
    return {
      ok: false,
      errors: finalValidation.errors.map((error) => ({
        path: `run.${error.path}`,
        message: error.message
      }))
    };
  }

  return {
    ok: true,
    run: updatedRun,
    event,
    memoryFact,
    useItemResult,
    errors: []
  };
}
