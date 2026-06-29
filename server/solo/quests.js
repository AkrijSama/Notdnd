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

// Deterministic non-negative hash for template selection when no seed is given.
function hashSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Tone-keyed main-quest templates. Each is a two-stage arc that only uses the
// reach_location and talk_beat predicates (no new engine work). Stage targetIds
// are symbolic; createMainQuest resolves them to the run's real ids by kind
// (reach_location -> the second location, talk_beat -> the destination NPC).
// Objective/title/description support {world}, {place}, {start} interpolation.
// ---------------------------------------------------------------------------
export const QUEST_TEMPLATES = [
  {
    tones: ["dark fantasy", "grimdark"],
    title: "Blood Debt",
    description:
      "A debt written in blood goes unpaid across {world}. The one who wronged you was last seen near {place} — go, and settle it.",
    stages: [
      {
        objective: "Travel to {place} on the trail of your quarry.",
        completion: { kind: "reach_location", targetId: "second_location" }
      },
      {
        objective: "Confront the figure waiting at {place} and collect what you are owed.",
        completion: { kind: "talk_beat", targetId: "npc_quest_giver" }
      }
    ]
  },
  {
    tones: ["high fantasy"],
    title: "The Last Beacon",
    description:
      "The old lights of {world} are failing one by one. Reach {place} and rekindle the last beacon before the dark closes over everything.",
    stages: [
      {
        objective: "Journey to {place}, where the last beacon still stands.",
        completion: { kind: "reach_location", targetId: "second_location" }
      },
      {
        objective: "Find the beacon's keeper at {place} and learn how to make it burn again.",
        completion: { kind: "talk_beat", targetId: "npc_quest_giver" }
      }
    ]
  },
  {
    tones: ["cosmic horror"],
    title: "The Drowned Signal",
    description:
      "Something beneath {world} is calling, and the signal is loudest at {place}. Go. Listen. Try to come back as yourself.",
    stages: [
      {
        objective: "Trace the drowned signal to {place}.",
        completion: { kind: "reach_location", targetId: "second_location" }
      },
      {
        objective: "Find the one at {place} who has heard it longest, and learn what it wants.",
        completion: { kind: "talk_beat", targetId: "npc_quest_giver" }
      }
    ]
  },
  {
    tones: ["post-apocalyptic"],
    title: "The Broken Road",
    description:
      "Nothing comes easy in {world}. Word is there's shelter still standing at {place} — if it hasn't fallen too.",
    stages: [
      {
        objective: "Cross the broken road to {place}.",
        completion: { kind: "reach_location", targetId: "second_location" }
      },
      {
        objective: "Find whoever holds {place} and bargain your way inside.",
        completion: { kind: "talk_beat", targetId: "npc_quest_giver" }
      }
    ]
  },
  {
    // Default fallback (empty tones) — the mystery arc for any unmatched tone.
    tones: [],
    title: "The Missing Shipment",
    description:
      "A shipment vanished on the roads of {world}, and the trail leads to {place}. Someone there knows more than they are saying.",
    stages: [
      {
        objective: "Follow the trail to {place}.",
        completion: { kind: "reach_location", targetId: "second_location" }
      },
      {
        objective: "Question the figure at {place} about the missing shipment.",
        completion: { kind: "talk_beat", targetId: "npc_quest_giver" }
      }
    ]
  }
];

/**
 * Selects a quest template by world tone (matches tones[], case-insensitive).
 * Unmatched tones fall back to the empty-tones default template. The seed makes
 * selection deterministic if a tone ever maps to multiple templates.
 * @param {string} tone
 * @param {number} [seed]
 * @returns {object} a QUEST_TEMPLATES entry
 */
export function pickQuestTemplate(tone, seed = 0) {
  const key = String(tone || "").trim().toLowerCase();
  const matches = QUEST_TEMPLATES.filter(
    (template) => Array.isArray(template.tones) && template.tones.some((t) => String(t).toLowerCase() === key)
  );
  if (matches.length > 0) {
    const index = Math.abs(Math.trunc(Number(seed) || 0)) % matches.length;
    return matches[index];
  }
  return (
    QUEST_TEMPLATES.find((template) => Array.isArray(template.tones) && template.tones.length === 0) ||
    QUEST_TEMPLATES[QUEST_TEMPLATES.length - 1]
  );
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

  // Tone-keyed template supplies the title/description/objective text; the engine
  // still drives completion via the resolved run ids below.
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : hashSeed(`${name}|${tone}`);
  const template = pickQuestTemplate(tone, seed);

  const fill = (text) =>
    String(text || "")
      .replace(/\{world\}/g, name)
      .replace(/\{place\}/g, secondLocationName)
      .replace(/\{start\}/g, startName);

  // Resolve each template stage's symbolic completion to the run's real targets:
  // reach_location -> the second location; talk_beat -> the destination NPC
  // (with a safe reach fallback when no NPC was seeded).
  const stages = template.stages.map((stage) => {
    const kind = stage.completion?.kind === "talk_beat" ? "talk_beat" : "reach_location";
    let completion;
    if (kind === "talk_beat") {
      completion = firstNpcId
        ? { kind: "talk_beat", targetId: firstNpcId }
        : { kind: "reach_location", targetId: secondLocationId };
    } else {
      completion = { kind: "reach_location", targetId: secondLocationId };
    }
    return { objective: fill(stage.objective), completion };
  });

  const stageZero = stages[0];

  return {
    questId: MAIN_QUEST_ID,
    status: "active",
    isMain: true,
    title: fill(template.title),
    description: fill(template.description),
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

// The d20 check resolved by THIS action (a contested attempt or a gated search),
// or null when the action rolled no check. Lets quest stages gate on — and FAIL
// on — the same roll the player just made.
function actionCheckResult(actionResult) {
  const cr = actionResult?.attemptResult?.checkResult ?? actionResult?.searchResult?.checkResult ?? null;
  return isPlainObject(cr) ? cr : null;
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
    case "check": {
      // CHECK-GATED stage — advances only when the player's roll this turn SUCCEEDS.
      // A failed check does NOT advance (and, if failOnMiss, fails the quest below),
      // so the player can genuinely lose a quest rather than grind it out.
      const cr = actionCheckResult(actionResult);
      return Boolean(cr) && cr.success === true;
    }
    default:
      return false;
  }
}

// A check-gated, failable stage fails the quest when the player rolls and MISSES.
// This is the teeth on the quest spine: not every objective is achievable, and a
// botched check can end the line.
function questFailedThisTurn(quest, actionResult) {
  const stage = quest.stages?.[quest.stage] ?? quest;
  const completion = stage?.completion;
  if (!isPlainObject(completion) || completion.kind !== "check" || stage.failOnMiss !== true) {
    return false;
  }
  const cr = actionCheckResult(actionResult);
  return Boolean(cr) && cr.success === false;
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
  const failed = [];

  for (const quest of Object.values(run.quests)) {
    if (!isPlainObject(quest) || quest.status !== "active") {
      continue;
    }
    // Failure first: a missed failable check ends the quest in defeat.
    if (questFailedThisTurn(quest, actionResult)) {
      quest.status = "failed";
      updated = true;
      failed.push(quest);
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

  return { updated, wonQuest, completed, advanced, failed };
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
