import {
  getAvailableMoves,
  detectMoveIntent,
  resolveMovementAction,
  validateMovementAction
} from "./movement.js";
import {
  createEntityDetailPayload,
  getVisibleEntities
} from "./entities.js";
import {
  resolveSearchAction,
  detectSearchIntent,
  validateSearchAction
} from "./search.js";
import {
  detectTakeIntent,
  resolveTakeAction
} from "./take.js";
import {
  detectQuestAcceptIntent,
  resolveQuestAccept
} from "./questFlow.js";
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
import { advanceQuests, capturePlayerObjective } from "./quests.js";
import { advanceMomentum } from "./momentum.js";
import { createDefaultVnState, validateSoloRun } from "./schema.js";
import {
  applyDamage,
  attemptRevive,
  isDead,
  isDying,
  rollDeathSave
} from "./death.js";
import { awardXp, XP_AWARDS } from "./progression.js";

const IMPLEMENTED_ACTION_TYPES = new Set(["move", "inspect", "search", "talk", "rest", "use_item", "attempt"]);
const FUTURE_ACTION_TYPES = new Set(["interact", "enter", "exit"]);
// System/test action types for driving the lethality spine deterministically over
// the HTTP API (applying damage, rolling a dying-turn save, reviving, granting an
// item). They are NOT part of the normal player surface (never listed in
// getAvailableSoloActions) and are recognized only when test hooks are enabled
// (dev / NOTDND_TEST_HOOKS=true) — never in production. They are the only way the
// self-play harness can prove "the player can actually die" end-to-end through
// real HTTP, since real play rolls are non-deterministic.
const TEST_HOOK_ACTION_TYPES = new Set(["damage", "death_save", "revive", "grant_item"]);
const RECOGNIZED_ACTION_TYPES = new Set([...IMPLEMENTED_ACTION_TYPES, ...FUTURE_ACTION_TYPES]);

export function testHooksEnabled(env = process.env) {
  if (String(env.NOTDND_TEST_HOOKS || "").trim().toLowerCase() === "true") {
    return true;
  }
  return String(env.NODE_ENV || "").trim().toLowerCase() !== "production";
}

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

// Verbs that mark a freeform "attempt" as an explicit address to an NPC. The
// deterministic VN trigger below fires only when one of these is present, so
// non-conversational attempts (climb, force, search…) stay ambient.
const VN_SPEAK_INTENT_RE = /\b(speak|talk|address|approach|greet|converse|chat|ask)\b/i;

// NPCs physically present in the run's current location (mirrors the server's
// presentNpcsForVn). Grounds the freeform speak trigger against real, co-located
// NPCs so an off-screen name never opens the overlay.
function presentNpcsAtLocation(run) {
  const npcs = run && run.npcs && typeof run.npcs === "object" ? Object.values(run.npcs) : [];
  return npcs.filter((npc) => npc && npc.currentLocationId === run.currentLocationId && npc.status !== "gone");
}

function vnNpcName(npc) {
  if (!npc || typeof npc !== "object") {
    return "";
  }
  if (isString(npc.generatedName)) {
    return npc.generatedName.trim();
  }
  return isString(npc.displayName) ? npc.displayName.trim() : "";
}

// Deterministic, GM-independent VN signal for the freeform "speak to X" path.
// The GM-narration classifier (gmProvider.classifyNarrationVn) can miss when
// live model output lacks quoted speech or names the NPC ambiguously, so an
// explicit attempt that addresses ONE present NPC — by targetId, else by name —
// opens the dialogue overlay on its own. Returns the speaker's raw npcId, or
// null when the action is not a clear single-target address (preserving ambient
// for every non-conversational action). Pure; never throws.
function vnSpeakerFromAttemptIntent(run, action) {
  if (!action || action.type !== "attempt" || !isString(action.intent)) {
    return null;
  }
  if (!VN_SPEAK_INTENT_RE.test(action.intent)) {
    return null;
  }
  const present = presentNpcsAtLocation(run);
  if (!present.length) {
    return null;
  }
  // A targetId naming a present NPC is the strongest, least ambiguous signal.
  const rawTarget = isString(action.targetId)
    ? (action.targetId.includes(":") ? action.targetId.split(":").slice(1).join(":") : action.targetId)
    : null;
  if (rawTarget) {
    const targeted = present.find((npc) => npc.npcId === rawTarget);
    if (targeted) {
      return targeted.npcId;
    }
  }
  // Otherwise require the intent to name EXACTLY one present NPC — several at
  // once is too ambiguous to attribute a single speaker, so stay ambient.
  const named = present.filter((npc) => {
    const name = vnNpcName(npc);
    if (name.length < 3) {
      return false;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(action.intent);
  });
  return named.length === 1 ? named[0].npcId : null;
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

  const isTestHookType = TEST_HOOK_ACTION_TYPES.has(normalized.type) && testHooksEnabled();
  if (!RECOGNIZED_ACTION_TYPES.has(normalized.type) && !isTestHookType) {
    push(errors, "action.type", `Unknown action type: ${normalized.type}`);
    return result(errors);
  }

  if (isTestHookType) {
    const runValidation = validateSoloRun(run);
    if (!runValidation.ok) {
      for (const error of runValidation.errors) {
        push(errors, `run.${error.path}`, error.message);
      }
    }
    if (normalized.type === "damage" && normalized.amount !== undefined && typeof normalized.amount !== "number") {
      push(errors, "action.amount", "Expected number");
    }
    if (normalized.type === "grant_item" && !isString(normalized.itemId) && !isPlainObject(normalized.item)) {
      push(errors, "action.item", "Expected item descriptor or itemId");
    }
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
function finalizeQuestProgress(originalRun, result, options = {}) {
  // Whether the action produced its own (cloned) run. inspect is read-only and
  // returns none, so we must never write scene state onto the shared input run.
  const actionProducedRun = Boolean(result.run);
  const activeRun = result.run || originalRun;

  // Dying-turn death save: if the player entered this turn dying (0 HP), spending
  // an ordinary turn rolls a death save on the post-action run. use_item is exempt
  // (playing a heal/revival is the alternative to bleeding out). If this save (or
  // its cascade) kills them, the run is now terminal — surface runDied and skip
  // the reward/quest bookkeeping below (a corpse advances nothing).
  if (actionProducedRun && result.run && isDying(originalRun) && result.action?.type !== "use_item") {
    if (isDying(result.run)) {
      result.deathSave = rollDeathSave(result.run, options);
    }
  }
  if (actionProducedRun && result.run && isDead(result.run)) {
    result.runDied = true;
    result.run.vn = createDefaultVnState();
    return result;
  }
  const { updated, wonQuest, completed, advanced, failed, rewarded } = advanceQuests(activeRun, result);
  if (updated) {
    result.run = activeRun; // persist the flipped quest status / stage
    if (Array.isArray(failed) && failed.length > 0) {
      result.questFailed = failed[0];
    }
    // Reward-on-completion (item + consumed hand-over) already committed inside
    // advanceQuests; surface it so the GM can name the payout in its narration.
    if (Array.isArray(rewarded) && rewarded.length > 0) {
      result.questReward = rewarded[0];
    }
    // The quest that moved this turn — the win, else a completed quest, else a
    // stage advance — so the GM can dramatize the progress in its narration.
    result.questJustAdvanced =
      wonQuest ||
      (Array.isArray(completed) ? completed[0] : null) ||
      (Array.isArray(advanced) ? advanced[0] : null) ||
      null;
  }
  if (wonQuest) {
    result.runWon = true;
    result.wonQuest = wonQuest;
  }

  // Track A — narrative truth becomes state: when the player DECLARES a durable
  // goal in an attempt and the world AGREED (a real success, not a refusal/gate),
  // the server instantiates it as a tracked, player-authored objective on the run.
  // Bounded by detectPlayerGoal (explicit establish/pursue intent, not flavor), so
  // a declared land-claim ("make this place my own") becomes a real objective the
  // GM and suggestions then reference — instead of a success paragraph with no state.
  if (actionProducedRun && result.run && result.action?.type === "attempt") {
    const captured = capturePlayerObjective(result.run, {
      intent: result.action?.intent,
      attemptResult: result.attemptResult
    });
    if (captured) {
      result.playerObjectiveCaptured = captured;
    }
  }

  // Consequence spine — XP rewards. Meaningful outcomes move the xp/level needle
  // on the (cloned, persisted) run: a contested success, a real discovery, every
  // quest stage advanced, and the main-quest win. awardXp no-ops on a dead run.
  if (actionProducedRun && result.run) {
    let xp = 0;
    if (result.attemptResult?.success === true && result.attemptResult?.needsCheck === true) {
      xp += XP_AWARDS.attempt_success;
    }
    if (result.searchResult?.found === true) {
      xp += XP_AWARDS.search_found;
    }
    const stagesAdvanced = Array.isArray(advanced) ? advanced.length : 0;
    if (stagesAdvanced > 0) {
      xp += XP_AWARDS.quest_stage * stagesAdvanced;
    }
    if (wonQuest) {
      xp += XP_AWARDS.quest_complete;
    }
    // Explicit per-quest reward xp (delivery payout etc.), granted on completion by
    // advanceQuests' reward lifecycle. Independent of the main-quest win award above.
    if (Array.isArray(rewarded) && rewarded.length > 0) {
      xp += rewarded.reduce((sum, entry) => sum + (Number.isFinite(Number(entry?.xp)) ? Number(entry.xp) : 0), 0);
    }
    if (xp > 0) {
      const xpResult = awardXp(result.run, xp);
      if (xpResult && xpResult.awarded > 0) {
        result.xpAwarded = xpResult.awarded;
        result.leveledUp = xpResult.leveledUp;
        result.playerLevel = xpResult.level;
      }
    }
  }

  // MOMENTUM — the world's own forward pressure (momentum.js). Every mutating
  // turn ticks the tension clock (quiet turns build it, progress bleeds it);
  // when it fires, the SERVER instantiates a real event — an arriving NPC, an
  // objectState change, a hook quest — COMMITTED to the post-action run before
  // a word is narrated. Skipped for read-only actions and terminal runs (a
  // corpse's world does not need to move).
  if (actionProducedRun && result.run && !result.runDied) {
    const momentum = advanceMomentum(result.run, result, options);
    if (momentum?.fired) {
      result.momentumEvent = momentum.fired;
    }
  }

  // VN scene state — the manual half of the ambient↔direct classifier. A talk
  // action is a direct, sustained exchange with a specific named NPC (VN mode,
  // focused on that speaker); every other action returns the scene to ambient
  // prose. The GM-driven half lives in gmProvider.deriveVnState; both write the
  // same { active, speakerId } shape the client reads off the scene payload.
  // Guarded on actionProducedRun so the read-only inspect path never mutates the
  // input run.
  if (actionProducedRun && result.run) {
    const talkSpeaker =
      result.talkResult && typeof result.talkResult.npcId === "string" && result.talkResult.npcId.trim()
        ? result.talkResult.npcId
        : null;
    // Secondary, GM-independent trigger: a freeform "speak to X" attempt that
    // addresses one present NPC opens VN even when the narration classifier
    // (run later, server-side) would miss. Non-talk / non-address actions return
    // null here and reset to ambient — so the ambient path is never overridden.
    const intentSpeaker = talkSpeaker ? null : vnSpeakerFromAttemptIntent(result.run, result.action);
    const speakerId = talkSpeaker || intentSpeaker;
    result.run.vn = speakerId ? { active: true, speakerId } : createDefaultVnState();
  }
  return result;
}

function cloneRun(run) {
  return JSON.parse(JSON.stringify(run));
}

// Resolves the gated system/test lethality actions. Mutates a clone, re-validates,
// and returns the standard resolver shape so the route persists + narrates it like
// any other action. Never reachable in production (validateSoloAction only admits
// these when testHooksEnabled()).
// Builds attempt options from a gated `testHook` rider on an attempt action so
// the self-play harness can drive a deterministic roll + GM consequence proposal.
// Returns `options` unchanged in production or when no rider is present.
function withScriptedAttemptOptions(normalized, options = {}) {
  const hook = normalized && isPlainObject(normalized.testHook) ? normalized.testHook : null;
  if (!hook || !testHooksEnabled()) {
    return options;
  }
  const merged = { ...options };
  if (typeof hook.fixedRoll === "number") {
    merged.fixedRoll = hook.fixedRoll;
  }
  if (isPlainObject(hook.providerOutput)) {
    const scripted = hook.providerOutput;
    merged.attemptProviderFn = () => scripted;
    // Mark the attempt scripted so the request layer keeps the scripted narration
    // (no live GM override) — see buildActionGmMessage. The flag lives on the
    // action, not persisted state.
    normalized.scriptedAttempt = true;
  }
  return merged;
}

function resolveTestHookAction(run, normalized, options = {}) {
  const updatedRun = cloneRun(run);
  const now = options.now instanceof Date ? options.now.toISOString() : (typeof options.now === "string" ? options.now : new Date().toISOString());
  let payload = {};

  if (normalized.type === "damage") {
    const amount = typeof normalized.amount === "number" ? normalized.amount : 1;
    const damage = applyDamage(updatedRun, amount, { crit: normalized.crit === true });
    payload = { damageResult: damage };
  } else if (normalized.type === "death_save") {
    const deathSave = rollDeathSave(updatedRun, options);
    payload = { deathSaveResult: deathSave };
  } else if (normalized.type === "revive") {
    const revive = attemptRevive(updatedRun, { hp: typeof normalized.hp === "number" ? normalized.hp : 1 });
    payload = { reviveResult: revive };
  } else if (normalized.type === "grant_item") {
    const descriptor = isPlainObject(normalized.item) ? normalized.item : { itemId: normalized.itemId };
    const itemId = isString(descriptor.itemId) ? descriptor.itemId : (isString(normalized.itemId) ? normalized.itemId : `item_${Math.random().toString(36).slice(2, 10)}`);
    const qty = typeof descriptor.qty === "number" ? descriptor.qty : (typeof descriptor.quantity === "number" ? descriptor.quantity : 1);
    const item = {
      itemId,
      name: isString(descriptor.name) ? descriptor.name : itemId,
      description: isString(descriptor.description) ? descriptor.description : "",
      quantity: qty,
      usable: descriptor.usable === true,
      consumable: descriptor.consumable !== false,
      tags: Array.isArray(descriptor.tags) ? descriptor.tags : [],
      flags: isPlainObject(descriptor.flags) ? descriptor.flags : {},
      use: isPlainObject(descriptor.use) ? descriptor.use : undefined
    };
    if (!isPlainObject(updatedRun.inventory)) {
      updatedRun.inventory = {};
    }
    updatedRun.inventory[itemId] = { ...(updatedRun.inventory[itemId] || {}), ...item };
    // Mirror into the state-contract player.inventory array (id/name/qty + extras).
    if (!Array.isArray(updatedRun.player.inventory)) {
      updatedRun.player.inventory = [];
    }
    const existing = updatedRun.player.inventory.find((entry) => isPlainObject(entry) && (entry.id === itemId || entry.itemId === itemId));
    if (existing) {
      existing.qty = (typeof existing.qty === "number" ? existing.qty : 0) + qty;
    } else {
      updatedRun.player.inventory.push({ id: itemId, name: item.name, qty });
    }
    payload = { grantResult: { itemId, quantity: updatedRun.inventory[itemId].quantity } };
  }

  updatedRun.updatedAt = now;
  const finalValidation = validateSoloRun(updatedRun);
  if (!finalValidation.ok) {
    return {
      ok: false,
      code: "ACTION_INVALID",
      actionType: normalized.type,
      errors: finalValidation.errors.map((error) => ({ path: `run.${error.path}`, message: error.message }))
    };
  }

  return {
    ok: true,
    action: normalized,
    run: updatedRun,
    runDied: isDead(updatedRun),
    availableMoves: getAvailableMoves(updatedRun),
    availableActions: getAvailableSoloActions(updatedRun),
    ...payload,
    errors: []
  };
}

// M.1 — a move-intent naming a KNOWN place that is NOT reachable from here is
// REFUSED, not narrated as an arrival. Shaped like an authority-gate refusal
// (gated:true, refused consequence, deterministic in-fiction line) so the request
// layer keeps the grounded refusal and never lets the GM narrate a move that
// couldn't happen. Read-only: run is untouched (result.run omitted).
function buildUnreachableMoveResult(run, normalized, moveIntent) {
  const here = isString(run?.locations?.[run.currentLocationId]?.name)
    ? run.locations[run.currentLocationId].name
    : "here";
  const place = isString(moveIntent?.name) ? moveIntent.name : "there";
  return {
    ok: true,
    action: normalized,
    attemptResult: {
      actorId: normalized.actorId ?? "player",
      intent: normalized.intent,
      success: false,
      needsCheck: false,
      checkResult: null,
      consequence: { type: "refused", applied: false, category: "unreachable_move", reason: "no known path from here" },
      foreclosed: false,
      unpossessed: false,
      gated: true,
      gateCategory: "unreachable_move",
      narration: `You can't simply cross to ${place} from ${here} — no path you know leads there yet.`,
      damage: null
    },
    availableMoves: getAvailableMoves(run),
    availableActions: getAvailableSoloActions(run),
    errors: []
  };
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

  // DEATH IS TERMINAL. A dead run is non-resumable — no further actions resolve.
  // The character is gone; only a death/review screen remains.
  if (isDead(run)) {
    return {
      ok: false,
      code: "RUN_TERMINAL",
      actionType: normalized.type,
      errors: [{ path: "run.status", message: "This character is dead. The run is over." }]
    };
  }

  // System/test lethality hooks (gated). Resolved before the normal branches so a
  // dying player can be acted on deterministically.
  if (TEST_HOOK_ACTION_TYPES.has(normalized.type)) {
    return resolveTestHookAction(run, normalized, options);
  }

  // The dying-turn loop (rolled in finalizeQuestProgress): while the player is at
  // 0 HP making death saves, ANY ordinary action spends their turn rolling a death
  // save. use_item is exempt — that is how a held heal/revival is played instead
  // of bleeding out. This is what makes 0 HP truly perilous: every turn is a
  // coin-flip toward death, not a safe pause.
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
    }, options);
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
    }, options);
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
    }, options);
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
    }, options);
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
    }, options);
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
    }, options);
  }

  if (normalized.type === "attempt") {
    // QUEST-ACCEPT COMMIT (delivery loop). Free-text acceptance of a present NPC's
    // job offer ("ok, I'll do it") instantiates a REAL tracked quest + places the
    // takeable item — instead of narrating "you take the job" while quests stays {}.
    // Fires only when a live offer is actually present (questFlow firewall).
    const acceptIntent = detectQuestAcceptIntent(run, normalized.intent);
    if (acceptIntent) {
      const acceptAction = { type: "quest_accept", actorId: normalized.actorId ?? "player", npcId: acceptIntent.npcId };
      const accepted = resolveQuestAccept(run, acceptAction, options);
      if (accepted.ok) {
        return finalizeQuestProgress(run, {
          ok: true,
          action: { ...acceptAction, intent: normalized.intent, acceptedViaIntent: true },
          run: accepted.run,
          event: accepted.event,
          memoryFact: accepted.memoryFact,
          questAccepted: accepted.questAccepted,
          availableMoves: getAvailableMoves(accepted.run),
          availableActions: getAvailableSoloActions(accepted.run),
          errors: []
        }, options);
      }
      // Accept failed validation — fall through to the normal attempt path.
    }
    // TAKE-INTENT COMMIT (delivery loop). Free-text "take the crate" grabs a PRESENT,
    // DISCOVERED, TAKEABLE object into inventory (committed via grantItemToRun) rather
    // than narrating a pickup that never mutates state. Fires only when the target
    // resolves to a real in-state takeable object (take.js firewall: never mints one).
    const takeIntent = detectTakeIntent(run, normalized.intent);
    if (takeIntent) {
      const takeAction = { type: "take", actorId: normalized.actorId ?? "player", detailId: takeIntent.detailId, targetLocationId: run.currentLocationId };
      const take = resolveTakeAction(run, takeAction, options);
      if (take.ok) {
        return finalizeQuestProgress(run, {
          ok: true,
          action: { ...takeAction, intent: normalized.intent, takenViaIntent: true },
          run: take.run,
          event: take.event,
          memoryFact: take.memoryFact,
          takeResult: take.takeResult,
          availableMoves: getAvailableMoves(take.run),
          availableActions: getAvailableSoloActions(take.run),
          errors: []
        }, options);
      }
      // Take failed validation — fall through to the normal attempt path.
    }
    // M.1 — MOVE-INTENT COMMIT. A directed move sent as free-text ("Head toward
    // The Gilded Kingdoms Watch") would otherwise resolve as narrative flavor: the
    // GM narrates arriving while run.currentLocationId never changes. Detect it and
    // ROUTE TO THE MOVE RESOLVER so the position actually commits (success on a move
    // = you moved). A move-intent naming a KNOWN but NOT-reachable place is refused
    // (no false-arrival prose). A non-move / unidentified-destination intent falls
    // through to the normal attempt path unchanged.
    const moveIntent = detectMoveIntent(run, normalized.intent);
    if (moveIntent?.reachable) {
      const moveAction = { type: "move", actorId: normalized.actorId ?? "player", toLocationId: moveIntent.toLocationId };
      const movement = resolveMovementAction(run, moveAction, options);
      if (movement.ok) {
        return finalizeQuestProgress(run, {
          ok: true,
          // Preserve the player's words + mark that a free-text intent committed a
          // move, so the GM narrates the ARRIVAL (now true) not a generic attempt.
          action: { ...moveAction, intent: normalized.intent, movedViaIntent: true },
          run: movement.run,
          event: movement.event,
          memoryFact: movement.memoryFact,
          moved: { fromLocationId: run.currentLocationId, toLocationId: moveIntent.toLocationId, name: moveIntent.name },
          availableMoves: getAvailableMoves(movement.run),
          availableActions: getAvailableSoloActions(movement.run),
          errors: []
        }, options);
      }
      // Movement failed validation (e.g. destination vanished) — fall through to
      // the normal attempt path rather than dropping the turn.
    } else if (moveIntent?.knownUnreachable) {
      return finalizeQuestProgress(run, buildUnreachableMoveResult(run, normalized, moveIntent), options);
    }
    // SEARCH-INTENT COMMIT (hollow-core fix). Free-text "search the ruins for
    // anything useful" would otherwise narrate "you find nothing of import" while
    // the location's PLACED features were never revealed. Route it to the real
    // search mechanic so a feature is actually revealed + committed to state (the
    // GM then narrates the REAL discovery). Only fires on a genuine area-search
    // intent; a non-search attempt falls through unchanged.
    if (detectSearchIntent(run, normalized.intent)) {
      const searchAction = { type: "search", actorId: normalized.actorId ?? "player", targetLocationId: run.currentLocationId };
      const search = resolveSearchAction(run, searchAction, options);
      if (search.ok) {
        return finalizeQuestProgress(run, {
          ok: true,
          action: { ...searchAction, intent: normalized.intent, searchedViaIntent: true },
          run: search.run,
          event: search.event,
          memoryFact: search.memoryFact,
          searchResult: search.searchResult,
          availableMoves: getAvailableMoves(search.run),
          availableActions: getAvailableSoloActions(search.run),
          errors: []
        }, options);
      }
      // Search failed validation — fall through to the normal attempt path.
    }
    // Deterministic test-hook injection (gated like the other test hooks): an
    // attempt may carry `testHook: { fixedRoll, providerOutput }` so the self-play
    // harness can drive a KNOWN roll + a KNOWN GM consequence proposal over real
    // HTTP and assert the server enforces it. Never honored in production. The
    // `testHook` field is otherwise ignored by validateAttemptAction (unknown
    // fields are tolerated), so it never reaches persisted state.
    const attemptOptions = withScriptedAttemptOptions(normalized, options);
    const attempt = resolveAttemptAction(run, normalized, attemptOptions);
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
    }, options);
  }

  return notImplemented(normalized.type);
}
