// PLAYER GOALS (player-goals-law) — capture, honor pipeline, narrator contract,
// and the goal-ignored auditor. A GOAL is a committed server record (what, scale,
// stakes, state, provenance), an equal citizen with quests. This module owns the
// three capture doors' shared record type, the DECLARED door detector, the Task
// honor pipeline (a goal-relevant success commits a goal-linked artifact with
// builder provenance), the prompt directive, and the ignored-goal detector.
//
// Fences: reads threads/reputation/economy, mutates only run.goals + goal-linked
// objectStates + player conditions/XP through the existing helpers. The D.5
// threads engine is read-only this pass — Projects/Ambitions register AS thread
// sources in a follow-up (canon-code-gaps.md).

import { GOAL_SCALES } from "./schema.js";
import { applyCondition } from "./conditions.js";
import { awardXp } from "./progression.js";

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// PROVISIONAL caps (player-goals-law): 3 active Ambitions, 5 Projects, Tasks
// uncapped. Awaiting owner confirm.
export const GOAL_CAPS = { ambition: 3, project: 5, task: Infinity };
// PROVISIONAL goal XP (committed-event XP law applied to achieved goals).
export const GOAL_XP = { task: 10, project: 40, ambition: 120 };

// ── token helpers ────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "my", "your", "his", "her", "their", "our",
  "for", "with", "into", "onto", "before", "after", "this", "that", "some", "any", "it",
  "i", "im", "ill", "am", "is", "are", "be", "will", "want", "going", "gonna", "plan",
  "intend", "aim", "hope", "trying", "need", "would", "like", "goal", "make", "get",
  "them", "then", "here", "there", "out", "up", "down", "on", "in", "at", "so", "as"
]);
function contentTokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((t) => t.replace(/[^a-z']/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// ── DECLARED DOOR ────────────────────────────────────────────────────────────
// Strong markers capture on any objective; medium markers capture only with a
// sustained-objective verb or a scope marker (so "I want to open the door" — a
// one-shot — does not become a standing goal, while "I want to build a shelter"
// does). Idle musing and questions never capture.
const MUSING_RE = /\b(i wonder|maybe|perhaps|i suppose|i guess|might i|possibly|i could just)\b/i;
const QUESTION_LEAD_RE = /^\s*(do|does|can|could|should|would|what|how|why|where|when|who|is|are|am)\b/i;
const STRONG_MARKER_RE = /\b(?:my (?:goal|aim|plan|mission|purpose|dream) is(?: to)?|i vow(?: to)?|i swear(?: to)?|i'?m determined to|i'?m resolved to|i dedicate myself to|i devote myself to|i pledge to|i set out to|i'?m setting out to|i'?m working toward|i'?ll make it my (?:mission|purpose|goal) to)\s+/i;
const MEDIUM_MARKER_RE = /\b(?:i want to|i'?m going to|i am going to|i'?m gonna|i plan to|i mean to|i'?d like to|i would like to|i intend to|i aim to|i hope to|i'?m trying to|i will|i need to)\s+/i;
const SUSTAINED_VERB_RE = /\b(build|construct|erect|raise|find|seek|reach|become|win|earn|master|learn|protect|defend|guard|avenge|restore|rebuild|reclaim|establish|found|gather|collect|save|overthrow|unite|explore|map|hunt|track|clear|secure|survive|escape|free|rescue|cure|heal|destroy|claim|conquer|rule|lead|uncover|solve|expose|deliver|repay|settle|cross|climb|tame|forge|make camp|set up camp)\b/i;
const SCOPE_RE = /\b(before the storm|before nightfall|before dark|before dawn|someday|one day|eventually|for good|once and for all|no matter what|whatever it takes|for the rest of my|my whole life|my entire life)\b/i;

// AMBITION / PROJECT scale signals (else Task).
const AMBITION_RE = /\b(become|overthrow|unite|avenge|conquer|rule|reign|throne|empire|kingdom|legend|legendary|greatest|guild ?master|the crown|for the rest of my life|my whole life|master the|destroy the|found (?:a|an|the) (?:guild|order|house|dynasty))\b/i;
const PROJECT_RE = /\b(build (?:a|an|the) (?:house|home|keep|fort|fortress|wall|bridge|ship|boat|farm|settlement|base|camp|workshop|forge|mill|tower)|establish|found (?:a|an|the)|gather enough|save up|track down|clear the|restore the|reclaim the|secure the|rescue)\b/i;

export function inferGoalScale(objective) {
  const text = String(objective || "");
  if (AMBITION_RE.test(text)) return "ambition";
  if (PROJECT_RE.test(text)) return "project";
  return "task";
}

// Returns { summary, scale, matchTokens } for an intention-shaped declaration, or
// null. Pure.
export function detectGoalDeclaration(intent) {
  const raw = String(intent || "").trim();
  if (!raw) return null;
  // Questions and idle musing never declare a goal.
  if (raw.includes("?") || QUESTION_LEAD_RE.test(raw) || MUSING_RE.test(raw)) {
    return null;
  }
  let objective = null;
  const strong = STRONG_MARKER_RE.exec(raw);
  if (strong) {
    objective = raw.slice(strong.index + strong[0].length);
  } else {
    const medium = MEDIUM_MARKER_RE.exec(raw);
    if (medium) {
      const rest = raw.slice(medium.index + medium[0].length);
      if (SUSTAINED_VERB_RE.test(rest) || SCOPE_RE.test(rest)) {
        objective = rest;
      }
    }
  }
  if (!isNonEmptyString(objective)) return null;
  // Trim to the objective clause (drop a trailing sentence after the goal).
  const summary = objective.replace(/[.!].*$/s, "").trim().replace(/\s+/g, " ");
  // matchTokens key on the CORE objective — strip a trailing scope/temporal
  // clause ("before the storm hits", "someday") so relevance keys on "build
  // shelter", not on ambient scope words that a steering narration might echo.
  const core = summary
    .replace(/\s+\b(?:before|after|until|by nightfall|by dawn|by dusk|by dark|someday|one day|eventually|for good|once and for all|no matter what|whatever it takes)\b.*$/i, "")
    .trim();
  const tokens = contentTokens(core || summary);
  if (!summary || tokens.length === 0) return null;
  return { summary, scale: inferGoalScale(summary), matchTokens: tokens };
}

// ── records + capture ────────────────────────────────────────────────────────
function goalId(run) {
  const n = isPlainObject(run.goals) ? Object.keys(run.goals).length : 0;
  const base = `goal_${n + 1}`;
  let id = base;
  let k = 2;
  while (run.goals && run.goals[id]) {
    id = `${base}_${k++}`;
  }
  return id;
}

export function activeGoals(run) {
  return isPlainObject(run?.goals) ? Object.values(run.goals).filter((g) => isPlainObject(g) && g.state === "active") : [];
}

function activeCountByScale(run, scale) {
  return activeGoals(run).filter((g) => g.scale === scale).length;
}

// Token overlap: does this intent pursue this goal?
export function goalMatchesIntent(goal, intent) {
  if (!isPlainObject(goal) || !Array.isArray(goal.matchTokens)) return false;
  const it = new Set(contentTokens(intent));
  let hits = 0;
  for (const t of goal.matchTokens) {
    if (it.has(t)) hits += 1;
  }
  // Require at least two shared content tokens, or one when the goal is single-token.
  return hits >= Math.min(2, goal.matchTokens.length);
}

// DECLARED capture. Commits a goal when the intent is intention-shaped, not a
// duplicate of an active goal, and within the scale cap. Returns the committed
// goal or null (no capture / capped / duplicate). Mutates run.goals.
export function captureDeclaredGoal(run, intent, { nowMinutes = 0, turn = 0 } = {}) {
  const decl = detectGoalDeclaration(intent);
  if (!decl) return null;
  if (!isPlainObject(run.goals)) run.goals = {};
  // Duplicate guard: an active goal already covering this objective.
  if (activeGoals(run).some((g) => goalMatchesIntent(g, decl.summary))) {
    return null;
  }
  // Cap guard (Tasks uncapped): a capped scale silently declines capture at that
  // scale (the pursuit still resolves as a normal attempt).
  if (activeCountByScale(run, decl.scale) >= GOAL_CAPS[decl.scale]) {
    return null;
  }
  const id = goalId(run);
  const goal = {
    goalId: id,
    summary: decl.summary,
    scale: decl.scale,
    state: "active",
    door: "declared",
    matchTokens: decl.matchTokens,
    linkedObjectIds: [],
    stages: [],
    createdTurn: Number.isFinite(turn) ? turn : 0,
    createdAtMinutes: Number.isFinite(nowMinutes) ? nowMinutes : 0,
    achievedAtMinutes: null,
    provenance: `declared: "${String(intent).trim().slice(0, 120)}"`,
    flags: {}
  };
  run.goals[id] = goal;
  return goal;
}

// ── HONOR PIPELINE (Tasks — the shelter path) ────────────────────────────────
// A goal-relevant success commits a goal-linked artifact so the world OWNS what
// the player did. This pass implements the BUILD class (the founding case);
// other doing-classes (find/gather) already commit through search/take.
const BUILD_INTENT_RE = /\b(build|construct|erect|raise|put up|set up|rig|assemble|fashion|make|pitch|throw up)\b/i;
const BUILD_NOUN_RE = /\b(shelter|lean-?to|tent|camp|cover|hut|shack|shanty|refuge|windbreak|fire|campfire|raft|bridge|wall|barricade|fort|trap|snare|shed|canopy|roof)\b/i;

function buildNoun(text) {
  const m = BUILD_NOUN_RE.exec(String(text || ""));
  return m ? m[1].toLowerCase().replace(/-/g, "") : null;
}

function isBuildDoing(intent, goal) {
  const hay = `${intent || ""} ${goal?.summary || ""}`;
  return BUILD_INTENT_RE.test(hay) && BUILD_NOUN_RE.test(hay);
}

// Is a sky-family storm hazard active at the player's location?
function activeStorm(run) {
  const os = run?.locations?.[run?.currentLocationId]?.flags?.objectStates?.["the-sky"];
  return isPlainObject(os) && /storm|rain|snow|gale|tempest/i.test(String(os.state || "")) ? os : null;
}

// Honor active goals against a resolved attempt. On a goal-relevant build success
// (or success-at-cost), commit a shelter/structure objectState with builder
// provenance + quality-from-band, grant a Sheltered condition when a storm is
// active (the storm-condition interaction), mark a single-stage Task achieved,
// and award goal XP. Returns [{ goalId, summary, objectId, band, achieved }].
export function honorGoalsOnAttempt(run, { intent, attemptResult, nowMinutes = 0 } = {}) {
  if (!isPlainObject(attemptResult)) return [];
  const band = attemptResult.band;
  // Success family: a rolled clean success, a success at a cost, OR a no-stakes
  // action that just happens ("automatic"). Only a "failure" band commits nothing.
  const success = band === "success" || band === "success_at_cost" || band === "automatic";
  if (!success) return [];
  const location = run?.locations?.[run?.currentLocationId];
  if (!isPlainObject(location)) return [];

  const honored = [];
  for (const goal of activeGoals(run)) {
    // Match: this attempt pursues the goal (or the goal was just declared and the
    // intent is its own doing).
    if (!goalMatchesIntent(goal, intent)) continue;
    if (goal.scale !== "task") continue; // Projects/Ambitions track differently (follow-up)
    if (!isBuildDoing(intent, goal)) continue;

    const noun = buildNoun(intent) || buildNoun(goal.summary) || "structure";
    // Quality from band: a clean/no-stakes success is sturdy; a success at a cost
    // is makeshift (the player got it, but rough).
    const quality = band === "success_at_cost" ? "makeshift" : "sturdy";
    const objectId = `goal-${goal.goalId}-${noun}`;
    if (!isPlainObject(location.flags)) location.flags = {};
    if (!isPlainObject(location.flags.objectStates)) location.flags.objectStates = {};
    location.flags.objectStates[objectId] = {
      objectId,
      label: goal.summary,
      state: `built-${quality}`,
      retryEffect: "none",
      reason: `built by the player pursuing goal ${goal.goalId}`,
      matchTokens: [noun, ...goal.matchTokens].filter(Boolean),
      targetId: null,
      sourceIntent: String(intent || "").slice(0, 120),
      since: new Date().toISOString(),
      setBy: "player-goal",
      goalId: goal.goalId
    };
    if (!Array.isArray(goal.linkedObjectIds)) goal.linkedObjectIds = [];
    goal.linkedObjectIds.push(objectId);

    // STORM-CONDITION INTERACTION: a shelter under an active storm grants cover
    // (offsets the storm's exposure). Player-side condition; the hazard thread is
    // untouched (read-only fence).
    let sheltered = false;
    if (noun === "shelter" || noun === "leanto" || noun === "tent" || noun === "hut" || noun === "camp") {
      if (activeStorm(run)) {
        applyCondition(
          run,
          { name: "Sheltered", effect: "Under cover from the storm — its exposure no longer bites.", kind: "boon", durationMinutes: 240 },
          nowMinutes
        );
        sheltered = true;
      }
    }

    // Single-stage Task → achieved. (Multi-stage advances instead; none minted yet.)
    goal.state = "achieved";
    goal.achievedAtMinutes = Number.isFinite(nowMinutes) ? nowMinutes : 0;
    goal.flags = { ...(goal.flags || {}), achievedBand: band, sheltered };
    const xp = awardXp(run, GOAL_XP.task, { reason: `goal achieved: ${goal.summary}` });

    honored.push({ goalId: goal.goalId, summary: goal.summary, objectId, band, achieved: true, sheltered, xp: xp?.awarded ?? 0 });
  }
  return honored;
}

// ── NARRATOR CONTRACT ────────────────────────────────────────────────────────
// Active goals ride every prompt as committed directives (acknowledge, advance,
// or lawfully obstruct — never ignore or redirect away). Recently-achieved goals
// with a committed artifact ride too, so the next turn's narration references the
// thing the player made. "" when the run carries no goals.
export function buildGoalsDirective(run) {
  const goals = isPlainObject(run?.goals) ? Object.values(run.goals) : [];
  const active = goals.filter((g) => isPlainObject(g) && g.state === "active");
  const achieved = goals.filter((g) => isPlainObject(g) && g.state === "achieved" && Array.isArray(g.linkedObjectIds) && g.linkedObjectIds.length > 0);
  if (!active.length && !achieved.length) return "";
  let out = "";
  if (active.length) {
    const list = active.map((g) => `${g.summary} (${g.scale})`).join("; ");
    out += ` ACTIVE PLAYER GOALS (committed, server-owned — ACKNOWLEDGE, ADVANCE, or LAWFULLY OBSTRUCT each; you may NOT ignore one the player is pursuing or redirect them away from it. Lawful obstruction = a gate, a price, or a rival, stated in-fiction with its reason; flat refusal only for genuine world-law impossibility): ${list}.`;
  }
  if (achieved.length) {
    const list = achieved.map((g) => g.summary).join("; ");
    out += ` COMMITTED PLAYER ACHIEVEMENTS (real, on the ground — reference them as existing, never contradict): ${list}.`;
  }
  return out;
}

// ── GOAL-IGNORED AUDITOR ─────────────────────────────────────────────────────
// The player pursued a committed goal this turn (the intent matches an active
// goal, or a goal was just captured). If the narration NEITHER engages the goal
// (names its objective/artifact tokens or the doing) NOR lawfully obstructs it
// (gate / price / rival / stated impossibility), it stiff-armed the player — flag.
// Log-only, same severity family as narrated-state drift.
const OBSTRUCTION_RE = /\b(can'?t|cannot|impossible|no (?:way|use|good)|too (?:dangerous|dark|late|steep|strong)|won'?t (?:hold|work|budge)|need|requires?|first|unless|until|blocked|refuse|price|cost|coin|pay|toll|guard|locked|forbidden|not (?:while|until|without))\b/i;

export function detectGoalIgnored(narrationText, run, { intent, attemptResult } = {}) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  const active = activeGoals(run);
  if (!active.length) return [];
  const out = [];
  const lower = text.toLowerCase();
  for (const goal of active) {
    // Only audit goals the player is actually pursuing THIS turn.
    if (!goalMatchesIntent(goal, intent)) continue;
    const tokens = Array.isArray(goal.matchTokens) ? goal.matchTokens : [];
    const engaged = tokens.some((t) => lower.includes(t));
    const obstructed = OBSTRUCTION_RE.test(text);
    if (!engaged && !obstructed) {
      out.push({
        goalId: goal.goalId,
        summary: goal.summary,
        band: attemptResult?.band || null,
        excerpt: text.replace(/\s+/g, " ").slice(0, 160)
      });
    }
  }
  return out;
}

// Exposed for callers/tests that want the scale vocabulary.
export const SCALES = GOAL_SCALES;
