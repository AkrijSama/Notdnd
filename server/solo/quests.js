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

import { grantItemToRun, consumeItemFromRun } from "./search.js";

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
    case "deliver":
      // DELIVER-GATED stage: completes only when the player is AT the target
      // location AND still carries the item — a real committed delivery, not a
      // narrated one. Reward + hand-over (item consumption) fire on completion.
      return (
        isString(completion.itemId) &&
        isString(completion.targetLocationId) &&
        playerHasItem(run, completion.itemId) &&
        run.currentLocationId === completion.targetLocationId
      );
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
 * @returns {{ updated: boolean, wonQuest: object | null, completed: object[], advanced: object[], failed: object[], rewarded: object[] }}
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
  const rewarded = [];

  const sandbox = isSandbox(run);
  for (const quest of Object.values(run.quests)) {
    if (!isPlainObject(quest) || quest.status !== "active") {
      continue;
    }
    // Sandbox suppresses the procedural spine entirely — it cannot advance, win,
    // or fail (it's hidden in getQuestPayload too). Player-authored goals still run.
    if (sandbox && isProceduralSpine(quest)) {
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
      // REWARD ON COMPLETION — the missing lifecycle piece. A quest carrying a
      // `reward` grants it into tracked state the moment it completes: hand over
      // the delivered item (consumeItemId — so "you delivered it" is TRUE in the
      // bag, not just narrated), grant a payout item, and record xp for the
      // resolver to award. Quests with no `reward` field are unaffected.
      if (isPlainObject(quest.reward)) {
        const entry = { questId: quest.questId, grantedItem: null, consumed: null, xp: 0 };
        if (isString(quest.reward.consumeItemId)) {
          entry.consumed = consumeItemFromRun(run, quest.reward.consumeItemId, 1);
        }
        if (isPlainObject(quest.reward.item)) {
          entry.grantedItem = grantItemToRun(run, quest.reward.item);
        }
        if (Number.isFinite(Number(quest.reward.xp)) && Number(quest.reward.xp) > 0) {
          entry.xp = Number(quest.reward.xp);
        }
        quest.flags = isPlainObject(quest.flags) ? quest.flags : {};
        quest.flags.rewardGranted = true;
        rewarded.push(entry);
      }
      if (quest.isMain && !wonQuest) {
        wonQuest = quest;
      }
    }
  }

  return { updated, wonQuest, completed, advanced, failed, rewarded };
}

/**
 * Scene-payload slice: the active quest list and the main quest (or null).
 * @param {object} run
 * @returns {{ activeQuests: object[], mainQuest: object | null }}
 */
export function getQuestPayload(run) {
  const sandbox = isSandbox(run);
  const quests = isPlainObject(run?.quests) ? Object.values(run.quests) : [];
  // In a SANDBOX (open world, no spine) the procedurally-injected directed main
  // quest is suppressed: it contradicts the open-world framing ("no one holds
  // this ground, make it yours") with an assigned quarry the player never chose.
  // Player-AUTHORED objectives (isMain:false, authoredBy:"player") still surface —
  // the open world reacts to what the player actually declares (see Track A,
  // capturePlayerObjective). Campaign runs are unchanged.
  const visible = sandbox ? quests.filter((quest) => !isProceduralSpine(quest)) : quests;
  const activeQuests = visible.filter((quest) => isPlainObject(quest) && quest.status === "active");
  const mainQuest = visible.find((quest) => isPlainObject(quest) && quest.isMain === true) || null;
  return { activeQuests, mainQuest };
}

// ---------------------------------------------------------------------------
// Track A — STATE owns NARRATIVE truth, not just mechanical truth.
//
// (1) Sandbox runs do not carry a directed objective: the procedural spine is
//     suppressed at the quest layer so open-world prose isn't contradicted by an
//     assigned quarry. (2) When the player DECLARES a durable goal and the world
//     AGREES (a real success — not a refusal/gate), the SERVER instantiates that
//     intent as a tracked, player-authored objective. The authority gate refuses
//     illegitimate fiat; this CAPTURES legitimate authorship. Server owns it.
// ---------------------------------------------------------------------------

// A run is "sandbox" (open world, no quest spine) vs "campaign" (default).
function isSandbox(run) {
  return isPlainObject(run) && run.mode === "sandbox";
}

// The procedurally-injected directed main quest (createMainQuest / onboarding):
// isMain with no player authorship. Distinguished from a player-authored goal so
// the latter is never suppressed.
function isProceduralSpine(quest) {
  return (
    isPlainObject(quest) &&
    quest.isMain === true &&
    quest.authoredBy !== "player" &&
    quest.flags?.playerAuthored !== true
  );
}

// First-person declaration of a DURABLE intent to establish/pursue something. The
// lead alone (i / my goal) is not enough — "I climb the wall" is not a goal; the
// intent must pair with a strong establish/pursue verb so flavor stays flavor.
const GOAL_FIRST_PERSON = /\b(?:i|i'?m|i'?ll|my)\b/i;
const GOAL_ESTABLISH = /\b(?:claim|establish|found|settle|colon(?:ize|ise)|build|rebuild|restore|reclaim|retake|take over|rule|reign|conquer|liberate|avenge|master this|hold this (?:place|ground|keep|land)|defend this (?:place|land|ground|keep)|protect this (?:place|land|ground)|make (?:this|that|the|it)\b[^,.;]*\b(?:mine|my own|my home|my base|my stronghold|a home|a base)|become (?:the|a|lord|master|ruler|king|queen)\b|forge (?:a|an|my)\b|raise (?:an?|my)\b)\b/i;

/**
 * Detects an explicit, durable player goal in an attempt's intent text. Bounded:
 * requires a first-person declaration AND a strong establish/pursue verb. Returns
 * { description } (objective text, 2nd person) or null for flavor/ordinary actions.
 * @param {string} intent
 * @returns {{ description: string } | null}
 */
export function detectPlayerGoal(intent) {
  const s = String(intent || "").toLowerCase();
  if (!isString(s)) {
    return null;
  }
  if (!GOAL_FIRST_PERSON.test(s) || !GOAL_ESTABLISH.test(s)) {
    return null;
  }
  const description = phraseObjectiveFromIntent(intent);
  return isString(description) ? { description } : null;
}

// Rewrites a first-person goal declaration into a clean 2nd-person objective line,
// dropping the intent frame ("I want to ...") and any trailing flavor clause.
function phraseObjectiveFromIntent(intent) {
  let s = String(intent || "").trim();
  // Drop a "my goal is to …" frame, then a leading first-person intent frame
  // ("I want to", "I intend to", "I will", "I'm going to"), then a bare leading
  // "I". This collapses "I will claim X" and "I claim X" to the same objective.
  s = s.replace(/^\s*my\s+(?:goal|aim|plan|purpose|mission|intent|intention|dream|ambition)\s+(?:is|will be)\s+to\s+/i, "");
  s = s.replace(
    /^\s*(?:from now on,?\s+)?i(?:'ll|'m)?\s+(?:want to|intend to|mean to|plan to|aim to|wish to|hope to|vow to|resolve to|swear to|am going to|going to|set out to|would like to|decide to|choose to|will|shall|going)\s+/i,
    ""
  );
  s = s.replace(/^\s*i\s+/i, "");
  // Keep only the goal clause — trailing "..., meditate on what it would take" is flavor.
  s = s.split(/[,;.]/)[0].trim();
  // 2nd-person voice (objectives read "Travel to ...", "Find ...").
  s = s
    .replace(/\bmy own\b/gi, "your own")
    .replace(/\bmine\b/gi, "yours")
    .replace(/\bmyself\b/gi, "yourself")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bme\b/gi, "you")
    .replace(/\bi\b/gi, "you")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) {
    return "Pursue your declared aim.";
  }
  return s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");
}

function normalizeDesc(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Player-authored objective capture. When an ATTEMPT declares a durable goal and
 * the world AGREED (a real mechanical success — not a refusal/gate/unpossessed/
 * foreclosed), instantiates a tracked, player-authored objective on run.quests and
 * returns it. No-ops (returns null) for flavor, refused fiat, or a duplicate. The
 * record carries no auto-completion predicate (predicateMet returns false on a
 * null completion), so it persists as an open objective the GM/player resolve.
 * Mutates run.quests in place (the resolver runs on a per-action run clone).
 * @param {object} run
 * @param {{ intent?: string, attemptResult?: object }} ctx
 * @returns {object|null} the created quest, or null
 */
export function capturePlayerObjective(run, { intent, attemptResult } = {}) {
  if (!isPlainObject(run)) {
    return null;
  }
  const ar = isPlainObject(attemptResult) ? attemptResult : {};
  // The world must have AGREED. A refusal/gate/unpossessed-claim/foreclosure is the
  // authority gate's domain — declaring an illegitimate fiat is not authorship.
  if (ar.success !== true || ar.gated === true || ar.unpossessed === true || ar.foreclosed === true) {
    return null;
  }
  if (isPlainObject(ar.consequence) && ar.consequence.type === "refused") {
    return null;
  }
  const goal = detectPlayerGoal(intent);
  if (!goal) {
    return null;
  }
  run.quests = isPlainObject(run.quests) ? run.quests : {};
  // De-dupe: don't re-capture the same active goal the player already declared.
  const target = normalizeDesc(goal.description);
  const dup = Object.values(run.quests).some(
    (q) => isPlainObject(q) && q.authoredBy === "player" && q.status === "active" && normalizeDesc(q.objective) === target
  );
  if (dup) {
    return null;
  }
  const n = Object.keys(run.quests).filter((k) => k.startsWith("quest_player_")).length + 1;
  const questId = `quest_player_${n}`;
  const quest = {
    questId,
    status: "active",
    isMain: false,
    authoredBy: "player",
    title: goal.description,
    description: goal.description,
    stages: [{ objective: goal.description, completion: null }],
    stage: 0,
    objective: goal.description,
    completion: null,
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: { playerAuthored: true }
  };
  run.quests[questId] = quest;
  return quest;
}
