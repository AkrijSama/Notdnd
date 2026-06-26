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
 * Builds the single main quest from a world definition using a template (no AI).
 * Title/objective/description derive from worldDef.name + tone +
 * startingLocationName. Completion defaults to reach_location at a second
 * location; when no second location is available it falls back to talk_beat
 * with the first NPC.
 *
 * @param {object} worldDef  resolved world ({ name, tone, startingLocationName, ... })
 * @param {object} [options] { secondLocationId, firstNpcId } from the run being built
 * @returns {object} quest record (shape matches validateQuestState + MVP fields)
 */
export function createMainQuest(worldDef = {}, options = {}) {
  const name = isString(worldDef.name) ? worldDef.name.trim() : "the world";
  const tone = isString(worldDef.tone) ? worldDef.tone.trim() : "uncertain";
  const startName = isString(worldDef.startingLocationName)
    ? worldDef.startingLocationName.trim()
    : "where you began";

  const secondLocationId = isString(options.secondLocationId) ? options.secondLocationId.trim() : null;
  const firstNpcId = isString(options.firstNpcId) ? options.firstNpcId.trim() : null;

  let completion;
  let objective;
  if (secondLocationId) {
    completion = { kind: "reach_location", targetId: secondLocationId };
    objective = `Leave ${startName} and press deeper into ${name}.`;
  } else if (firstNpcId) {
    completion = { kind: "talk_beat", targetId: firstNpcId };
    objective = `Find the one soul in ${startName} who knows what comes next.`;
  } else {
    // Safe default: the default graph always provides a second location.
    completion = { kind: "reach_location", targetId: DEFAULT_SECOND_LOCATION_ID };
    objective = `Leave ${startName} and press deeper into ${name}.`;
  }

  return {
    questId: MAIN_QUEST_ID,
    status: "active",
    isMain: true,
    title: `The ${titleCase(tone)} Road`,
    objective,
    description:
      `${name} is a ${tone} world, and ${startName} is only where your story opens. ` +
      `It does not end here — there is further to go.`,
    completion,
    stage: 0,
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
  const completion = isPlainObject(quest.completion) ? quest.completion : null;
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
 * @param {object} run         post-action run (carries run.quests + state)
 * @param {object} actionResult resolver result (may carry talkResult, etc.)
 * @returns {{ updated: boolean, wonQuest: object | null, completed: object[] }}
 */
export function advanceQuests(run, actionResult = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.quests)) {
    return { updated: false, wonQuest: null, completed: [] };
  }

  let updated = false;
  let wonQuest = null;
  const completed = [];

  for (const quest of Object.values(run.quests)) {
    if (!isPlainObject(quest) || quest.status !== "active") {
      continue;
    }
    if (predicateMet(run, quest, actionResult)) {
      quest.status = "completed";
      updated = true;
      completed.push(quest);
      if (quest.isMain && !wonQuest) {
        wonQuest = quest;
      }
    }
  }

  return { updated, wonQuest, completed };
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
