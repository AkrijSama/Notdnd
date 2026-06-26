import {
  getAvailableMoves,
  resolveMovementAction,
  validateMovementAction
} from "./movement.js";
import {
  createEntityDetailPayload,
  getVisibleEntities
} from "./entities.js";
import {
  resolveSearchAction,
  validateSearchAction
} from "./search.js";
import {
  getTalkableNpcs,
  resolveTalkAction,
  validateTalkAction
} from "./talk.js";
import {
  getAvailableRestTypes,
  resolveRestAction,
  validateRestAction
} from "./rest.js";
import {
  getUsableInventoryItems,
  resolveUseItemAction,
  validateUseItemAction
} from "./useItem.js";
import {
  resolveAttemptAction,
  validateAttemptAction
} from "./attempt.js";
import { advanceQuests } from "./quests.js";

const IMPLEMENTED_ACTION_TYPES = new Set(["move", "inspect", "search", "talk", "rest", "use_item", "attempt"]);
const FUTURE_ACTION_TYPES = new Set(["interact", "enter", "exit"]);
const RECOGNIZED_ACTION_TYPES = new Set([...IMPLEMENTED_ACTION_TYPES, ...FUTURE_ACTION_TYPES]);

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

function notImplemented(actionType) {
  return {
    ok: false,
    code: "ACTION_NOT_IMPLEMENTED",
    actionType,
    errors: [
      {
        path: "action.type",
        message: `Action type ${actionType} is recognized but not implemented yet.`
      }
    ]
  };
}

export function normalizeSoloAction(action) {
  if (!isPlainObject(action)) {
    return action;
  }

  const normalized = {
    ...action,
    type: typeof action.type === "string" ? action.type.trim().toLowerCase() : action.type
  };

  if (normalized.actorId === undefined || normalized.actorId === null || normalized.actorId === "") {
    normalized.actorId = "player";
  }

  return normalized;
}

export function validateSoloAction(run, action) {
  const normalized = normalizeSoloAction(action);
  const errors = [];

  if (!isPlainObject(normalized)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }

  if (!isString(normalized.type)) {
    push(errors, "action.type", "Expected non-empty string");
    return result(errors);
  }

  if (!RECOGNIZED_ACTION_TYPES.has(normalized.type)) {
    push(errors, "action.type", `Unknown action type: ${normalized.type}`);
    return result(errors);
  }

  if (normalized.type === "move") {
    return validateMovementAction(run, normalized);
  }
  if (normalized.type === "inspect") {
    if (!isString(normalized.entityId)) {
      push(errors, "action.entityId", "Expected non-empty string");
    }
    const detail = createEntityDetailPayload(run, normalized.entityId);
    if (!detail.ok) {
      for (const error of detail.errors) {
        push(errors, `action.${error.path}`, error.message);
      }
    }
    return result(errors);
  }
  if (normalized.type === "search") {
    return validateSearchAction(run, normalized);
  }
  if (normalized.type === "talk") {
    return validateTalkAction(run, normalized);
  }
  if (normalized.type === "rest") {
    return validateRestAction(run, normalized);
  }
  if (normalized.type === "use_item") {
    return validateUseItemAction(run, normalized);
  }
  if (normalized.type === "attempt") {
    return validateAttemptAction(run, normalized);
  }

  return notImplemented(normalized.type);
}

export function getAvailableSoloActions(run, options = {}) {
  const includePlaceholders = options.includePlaceholders !== false;
  const movementActions = getAvailableMoves(run).map((move) => ({
    type: "move",
    label: `Move to ${move.name}`,
    toLocationId: move.locationId,
    direction: move.direction,
    imageAssetId: move.imageAssetId,
    edition: move.edition,
    policyProfileId: move.policyProfileId,
    enabled: true
  }));
  const inspectActions = getVisibleEntities(run)
    .filter((entity) => entity.inspectable)
    .map((entity) => ({
      type: "inspect",
      label: `Inspect ${entity.displayName}`,
      entityId: entity.entityId,
      entityType: entity.entityType,
      imageAssetId: entity.imageAssetId,
      enabled: true
    }));
  const talkActions = getTalkableNpcs(run)
    .map(({ npc, entity }) => ({
      type: "talk",
      label: `Talk to ${npc.displayName}`,
      targetEntityId: entity.entityId,
      npcId: npc.npcId,
      enabled: true
    }));
  const restActions = getAvailableRestTypes(run).map((restType) => ({
    type: "rest",
    label: restType === "long" ? "Long Rest" : "Short Rest",
    restType,
    enabled: true
  }));
  const itemActions = getUsableInventoryItems(run).map((item) => ({
    type: "use_item",
    label: `Use ${item.name}`,
    itemId: item.itemId,
    itemName: item.name,
    consumable: item.consumable,
    quantity: item.quantity,
    enabled: true
  }));

  if (!includePlaceholders) {
    return [...movementActions, ...inspectActions, ...talkActions, ...restActions, ...itemActions];
  }

  return [
    ...movementActions,
    ...inspectActions,
    ...talkActions,
    ...restActions,
    ...itemActions,
    {
      type: "search",
      label: "Search area",
      enabled: true
    },
    {
      type: "attempt",
      label: "Attempt",
      enabled: true
    }
  ];
}

// After a resolver branch produces its success result, run the quest engine
// against the post-action run and surface a win. The mutating actions carry the
// updated run on result.run; read-only inspect has none, so fall back to the
// original run (it can never satisfy a predicate, so this is a no-op there).
function finalizeQuestProgress(originalRun, result) {
  const activeRun = result.run || originalRun;
  const { updated, wonQuest, completed } = advanceQuests(activeRun, result);
  if (updated) {
    result.run = activeRun; // persist the flipped quest status
    // The quest that just advanced this turn (the win, or the first completed
    // quest) so the GM can dramatize the progress in its narration.
    result.questJustAdvanced = wonQuest || (Array.isArray(completed) ? completed[0] : null) || null;
  }
  if (wonQuest) {
    result.runWon = true;
    result.wonQuest = wonQuest;
  }
  return result;
}

export function resolveSoloAction(run, action, options = {}) {
  const normalized = normalizeSoloAction(action);
  const validation = validateSoloAction(run, normalized);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code || (validation.actionType ? "ACTION_NOT_IMPLEMENTED" : "ACTION_INVALID"),
      actionType: validation.actionType || normalized?.type || null,
      errors: validation.errors
    };
  }

  if (normalized.type === "move") {
    const movement = resolveMovementAction(run, normalized, options);
    if (!movement.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "move",
        errors: movement.errors
      };
    }

    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: movement.run,
      event: movement.event,
      memoryFact: movement.memoryFact,
      availableMoves: getAvailableMoves(movement.run),
      availableActions: getAvailableSoloActions(movement.run),
      errors: []
    });
  }

  if (normalized.type === "inspect") {
    const detail = createEntityDetailPayload(run, normalized.entityId);
    if (!detail.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "inspect",
        errors: detail.errors.map((error) => ({
          path: `action.${error.path}`,
          message: error.message
        }))
      };
    }

    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      entity: detail.entity,
      details: detail.details,
      availableMoves: getAvailableMoves(run),
      availableActions: getAvailableSoloActions(run),
      errors: []
    });
  }

  if (normalized.type === "search") {
    const search = resolveSearchAction(run, normalized, options);
    if (!search.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "search",
        errors: search.errors
      };
    }

    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: search.run,
      event: search.event,
      memoryFact: search.memoryFact,
      searchResult: search.searchResult,
      availableMoves: getAvailableMoves(search.run),
      availableActions: getAvailableSoloActions(search.run),
      errors: []
    });
  }

  if (normalized.type === "talk") {
    const talk = resolveTalkAction(run, normalized, options);
    if (!talk.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "talk",
        errors: talk.errors
      };
    }

    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: talk.run,
      event: talk.event,
      memoryFact: talk.memoryFact,
      talkResult: talk.talkResult,
      availableMoves: getAvailableMoves(talk.run),
      availableActions: getAvailableSoloActions(talk.run),
      errors: []
    });
  }

  if (normalized.type === "rest") {
    const rest = resolveRestAction(run, normalized, options);
    if (!rest.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "rest",
        errors: rest.errors
      };
    }

    const actionRun = rest.run || run;
    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: rest.run,
      event: rest.event,
      memoryFact: rest.memoryFact,
      restResult: rest.restResult,
      availableMoves: getAvailableMoves(actionRun),
      availableActions: getAvailableSoloActions(actionRun),
      errors: []
    });
  }

  if (normalized.type === "use_item") {
    const useItem = resolveUseItemAction(run, normalized, options);
    if (!useItem.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "use_item",
        errors: useItem.errors
      };
    }

    const actionRun = useItem.run || run;
    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: useItem.run,
      event: useItem.event,
      memoryFact: useItem.memoryFact,
      useItemResult: useItem.useItemResult,
      availableMoves: getAvailableMoves(actionRun),
      availableActions: getAvailableSoloActions(actionRun),
      errors: []
    });
  }

  if (normalized.type === "attempt") {
    const attempt = resolveAttemptAction(run, normalized, options);
    if (!attempt.ok) {
      return {
        ok: false,
        code: "ACTION_INVALID",
        actionType: "attempt",
        errors: attempt.errors
      };
    }

    return finalizeQuestProgress(run, {
      ok: true,
      action: normalized,
      run: attempt.run,
      event: attempt.event,
      memoryFact: attempt.memoryFact,
      attemptResult: attempt.attemptResult,
      availableMoves: getAvailableMoves(attempt.run),
      availableActions: getAvailableSoloActions(attempt.run),
      errors: []
    });
  }

  return notImplemented(normalized.type);
}
