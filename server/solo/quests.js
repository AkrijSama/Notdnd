// ---------------------------------------------------------------------------
// MVP quest engine.
//
// One templated "main quest" per run (no AI — derived from the world
// definition), advanced by checking simple completion predicates after every
// action. Completing the main quest wins the run.
//
// Pure where it can be: createMainQuest / getQuestPayload return fresh data;
// advanceQuests mutates run.quests in place because the action resolver already
// works on a per-action run clone, and the route persists that clone.
// ---------------------------------------------------------------------------

export const MAIN_QUEST_ID = "quest_main";

// The default location graph (schema.createDefaultLocationGraph) always provides
// a "second_location", so reach_location can target it even before the world is
// fully fleshed out.
const DEFAULT_SECOND_LOCATION_ID = "second_location";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function titleCase(value) {
  const s = String(value || "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Builds the two-stage main quest from a world definition using a template
 * (no AI). The arc:
 *   Stage 0 — reach_location at the second location ("Travel to ...").
 *   Stage 1 — talk_beat with the destination NPC ("Find what awaits you
 *             there"), or, when no NPC is available, a safe reach fallback
 *             (the predicate switch only supports reach/talk/obtain, so a true
 *             "search reveal" stage would need its own seeded content + kind).
 *
 * The active stage's objective + completion are mirrored onto the top-level
 * quest fields for back-compat (older clients read quest.objective /
 * quest.completion directly). advanceQuests keeps that mirror current as the
 * stage changes.
 *
 * @param {object} worldDef  resolved world ({ name, tone, startingLocationName, ... })
 * @param {object} [options] { secondLocationId, secondLocationName, firstNpcId }
 * @returns {object} quest record (shape matches validateQuestState + MVP fields)
 */
export function createMainQuest(worldDef = {}, options = {}) {
  const name = isString(worldDef.name) ? worldDef.name.trim() : "the world";
  const tone = isString(worldDef.tone) ? worldDef.tone.trim() : "uncertain";
  const startName = isString(worldDef.startingLocationName)
    ? worldDef.startingLocationName.trim()
    : "where you began";

  const secondLocationId = isString(options.secondLocationId)
    ? options.secondLocationId.trim()
    : DEFAULT_SECOND_LOCATION_ID;
  const secondLocationName = isString(options.secondLocationName)
    ? options.secondLocationName.trim()
    : "the next waypoint";
  const firstNpcId = isString(options.firstNpcId) ? options.firstNpcId.trim() : null;

  const stageZero = {
    objective: `Travel to ${secondLocationName}.`,
    completion: { kind: "reach_location", targetId: secondLocationId }
  };

  const stageOne = firstNpcId
    ? {
        objective: "Find what awaits you there.",
        completion: { kind: "talk_beat", targetId: firstNpcId }
      }
    : {
        // No NPC to seed a quest beat on. The predicate switch has no
        // search-reveal kind, so fall back to a second reach of the same
        // destination — degenerate but always completable.
        objective: "Find what awaits you there.",
        completion: { kind: "reach_location", targetId: secondLocationId }
      };

  const stages = [stageZero, stageOne];

  return {
    questId: MAIN_QUEST_ID,
    status: "active",
    isMain: true,
    title: `The ${titleCase(tone)} Road`,
    description:
      `${name} is a ${tone} world. First, travel to ${secondLocationName}; ` +
      `then uncover what waits for you there. ${startName} is only where your story opens.`,
    stages,
    stage: 0,
    // Mirror of the active stage (stage 0) for back-compat.
    objective: stageZero.objective,
    completion: stageZero.completion,
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: {}
  };
}

function playerHasItem(run, itemId) {
  if (!isString(itemId)) {
    return false;
  }
  // Spec shape: run.player.inventory (array of ids or item objects).
  const playerInv = run?.player?.inventory;
  if (Array.isArray(playerInv)) {
    return playerInv.some(
      (entry) => entry === itemId || (isPlainObject(entry) && (entry.itemId === itemId || entry.id === itemId))
    );
  }
  if (isPlainObject(playerInv)) {
    return Object.prototype.hasOwnProperty.call(playerInv, itemId);
  }
  // Fall back to the run-level inventory record used elsewhere in the engine.
  const runInv = run?.inventory;
  if (isPlainObject(runInv)) {
    return Object.prototype.hasOwnProperty.call(runInv, itemId);
  }
  return false;
}

function predicateMet(run, quest, actionResult) {
  // Read the ACTIVE stage's completion (multi-stage quests), falling back to the
  // mirrored top-level completion for legacy single-predicate quests.
  const c = quest.stages?.[quest.stage]?.completion ?? quest.completion;
  const completion = isPlainObject(c) ? c : null;
  if (!completion) {
    return false;
  }
  switch (completion.kind) {
    case "reach_location":
      return isString(completion.targetId) && run.currentLocationId === completion.targetId;
    case "talk_beat": {
      const linked = actionResult?.talkResult?.linkedQuestIds;
      return Array.isArray(linked) && linked.includes(quest.questId);
    }
    case "obtain_item":
      return playerHasItem(run, completion.targetId);
    default:
      return false;
  }
}

/**
 * After an action resolves, checks every active quest's completion predicate
 * against the (post-action) run state + the action result. Flips matching
 * quests to "completed" (mutates run.quests in place). Completing the main quest
 * marks the run as won.
 *
 * On a match: if the quest has a later stage, advance to it (and re-mirror the
 * new stage's objective/completion onto the top-level fields); if it is on its
 * final stage, mark it completed. Advances at most one stage per action.
 *
 * @param {object} run         post-action run (carries run.quests + state)
 * @param {object} actionResult resolver result (may carry talkResult, etc.)
 * @returns {{ updated: boolean, wonQuest: object | null, completed: object[], advanced: object[] }}
 */
export function advanceQuests(run, actionResult = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.quests)) {
    return { updated: false, wonQuest: null, completed: [], advanced: [] };
  }

  let updated = false;
  let wonQuest = null;
  const completed = [];
  const advanced = [];

  for (const quest of Object.values(run.quests)) {
    if (!isPlainObject(quest) || quest.status !== "active") {
      continue;
    }
    if (!predicateMet(run, quest, actionResult)) {
      continue;
    }

    const stages = Array.isArray(quest.stages) ? quest.stages : null;
    const lastIndex = stages ? stages.length - 1 : 0;
    const currentStage = Number.isInteger(quest.stage) ? quest.stage : 0;

    if (stages && currentStage < lastIndex) {
      // Not the final stage — advance and re-mirror the new stage's fields.
      quest.stage = currentStage + 1;
      const next = stages[quest.stage];
      if (next) {
        quest.objective = next.objective;
        quest.completion = next.completion;
      }
      updated = true;
      advanced.push(quest);
    } else {
      // Final stage (or a legacy single-predicate quest) — complete it.
      quest.status = "completed";
      updated = true;
      completed.push(quest);
      if (quest.isMain && !wonQuest) {
        wonQuest = quest;
      }
    }
  }

  return { updated, wonQuest, completed, advanced };
}

/**
 * Scene-payload slice: the active quest list and the main quest (or null).
 * @param {object} run
 * @returns {{ activeQuests: object[], mainQuest: object | null }}
 */
export function getQuestPayload(run) {
  const quests = isPlainObject(run?.quests) ? Object.values(run.quests) : [];
  const activeQuests = quests.filter((quest) => isPlainObject(quest) && quest.status === "active");
  const mainQuest = quests.find((quest) => isPlainObject(quest) && quest.isMain === true) || null;
  return { activeQuests, mainQuest };
}
