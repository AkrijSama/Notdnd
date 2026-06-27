import { generateUtility } from "../ai/openrouter.js";
import { getAvailableMoves } from "./movement.js";

// ---------------------------------------------------------------------------
// Contextual "what could I do next?" suggestions. Three short, concrete,
// editable action prompts surfaced on every GM turn so the player never faces a
// blank box. Backed by the cheap utility model with a hard timeout, and a
// deterministic, scene-aware fallback so a sensible set of 3 is ALWAYS produced
// (offline, in tests, or when the LLM is slow/unavailable). Suggestions are pure
// scaffolding — the player can always ignore them and type their own action.
// ---------------------------------------------------------------------------

const SUGGESTION_TIMEOUT_MS = 7000;
const MAX_SUGGESTION_LEN = 90;

// Guards against firing duplicate LLM calls for the same scene while one is
// already in flight (the scene route polls; without this every poll would spawn
// a generation). Keyed by `${runId}:${sceneKey}`.
const inFlight = new Set();

function isStr(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUGGESTION_LEN);
}

// Scene "version": changes when the player moves (location) and on every action
// (the timeline grows). New scene -> stale cache -> regenerate; same scene across
// polls -> served from cache.
export function sceneSuggestionsKey(run) {
  const loc = isStr(run?.currentLocationId) ? run.currentLocationId : "";
  const ver = Array.isArray(run?.timeline) ? run.timeline.length : 0;
  return `${loc}:${ver}`;
}

function presentNpcs(run) {
  const npcs = run?.npcs && typeof run.npcs === "object" ? Object.values(run.npcs) : [];
  return npcs.filter((npc) => npc && npc.currentLocationId === run?.currentLocationId && npc.status !== "gone");
}

function availableMoveNames(run) {
  try {
    return (getAvailableMoves(run) || []).map((move) => move?.name).filter(isStr);
  } catch {
    return [];
  }
}

function activeObjective(run) {
  const stages = run?.quests?.quest_main?.stages;
  if (!Array.isArray(stages)) {
    return "";
  }
  const stage = stages.find((entry) => entry && entry.status !== "complete") || stages[0];
  return stage && isStr(stage.objective) ? clip(stage.objective) : "";
}

// Deterministic, scene-aware fallback: always exactly 3, varied across
// investigate / talk / move so the player sees the breadth of options.
export function buildFallbackSuggestions(run) {
  const location = run?.locations?.[run?.currentLocationId] || {};
  const locName = isStr(location.name) ? location.name : "the area";
  const npcs = presentNpcs(run);
  const moves = availableMoveNames(run);

  const investigate = `Search ${locName} for anything useful`;
  const talk = npcs.length && isStr(npcs[0].displayName)
    ? `Approach ${npcs[0].displayName} and speak`
    : "Call out and see who answers";
  const move = moves.length
    ? `Head toward ${moves[0]}`
    : "Press on and explore further";

  return [investigate, talk, move].map(clip);
}

function buildMessages(run) {
  const location = run?.locations?.[run?.currentLocationId] || {};
  const player = run?.player || {};
  const npcNames = presentNpcs(run).map((npc) => npc.displayName).filter(isStr);
  const moves = availableMoveNames(run);
  const objective = activeObjective(run);
  const recent = Array.isArray(run?.timeline)
    ? run.timeline.slice(-3).map((event) => event?.summary || event?.type).filter(isStr)
    : [];

  const context = [
    `Location: ${isStr(location.name) ? location.name : "Unknown"}${isStr(location.description) ? ` — ${clip(location.description)}` : ""}`,
    `Character: ${isStr(player.displayName) ? player.displayName : "the adventurer"}${isStr(player.className) ? `, ${player.className}` : ""}`,
    objective ? `Current goal: ${objective}` : "",
    npcNames.length ? `People present: ${npcNames.join(", ")}` : "",
    moves.length ? `Ways onward: ${moves.join(", ")}` : "",
    recent.length ? `Recently: ${recent.join("; ")}` : "",
    isStr(run?.narration) ? `Scene: ${clip(run.narration)}` : ""
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content:
        "You suggest exactly 3 next actions for a player in a solo tabletop RPG. " +
        "Each is a short imperative phrase (4 to 9 words), concrete and specific to THIS scene. " +
        "The three must vary in approach: one to investigate or examine something here, one to talk to " +
        "or interact with someone present, and one to move or advance toward the goal. " +
        "No numbering, no quotes, no commentary. " +
        'Reply ONLY with a compact JSON array of 3 strings, e.g. ["Search the stalls","Approach the warden","Head for the gate"].'
    },
    { role: "user", content: context || "A quiet, featureless scene with no clear features yet." }
  ];
}

function parseSuggestions(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        const cleaned = arr.map(clip).filter(isStr);
        if (cleaned.length >= 3) {
          return cleaned.slice(0, 3);
        }
      }
    } catch {
      // fall through to line parsing
    }
  }
  // Line fallback — only for an explicitly itemized list (bulleted or numbered).
  // We deliberately do NOT accept arbitrary prose lines: a model that returns
  // narration instead of a list should fall through to the deterministic
  // suggestions, not have its sentences mistaken for actions.
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line))
    .map((line) => clip(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["']|["']$/g, "")))
    .filter(isStr);
  return lines.length >= 3 ? lines.slice(0, 3) : null;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("suggestion timeout")), ms))
  ]);
}

// LLM-backed; ALWAYS resolves to exactly 3 strings (deterministic fallback on any
// failure or timeout). Never throws.
export async function generateSuggestions(run) {
  try {
    const result = await withTimeout(
      generateUtility(buildMessages(run), run?.campaignId || "global", {
        temperature: 0.85,
        maxResponseTokens: 160
      }),
      SUGGESTION_TIMEOUT_MS
    );
    const parsed = parseSuggestions(result?.content);
    if (parsed) {
      return parsed;
    }
  } catch {
    // fall through to fallback
  }
  return buildFallbackSuggestions(run);
}

/**
 * Awaitable, guarded refresh of a run's cached suggestions for its current scene.
 * Skips work when the cache is already fresh; otherwise generates (LLM + fallback)
 * and persists via the injected writer. Safe to call fire-and-forget from a poll
 * path and to await in the action loop. Never throws.
 * @param {object} run
 * @param {(runId: string, sceneKey: string, actions: string[]) => unknown} [persist]
 * @returns {Promise<string[]>}
 */
export async function refreshSceneSuggestions(run, persist) {
  try {
    if (!run || !isStr(run.runId)) {
      return [];
    }
    const key = sceneSuggestionsKey(run);
    if (run.suggestedActionsKey === key && Array.isArray(run.suggestedActions) && run.suggestedActions.length >= 3) {
      return run.suggestedActions.slice(0, 3);
    }
    const guard = `${run.runId}:${key}`;
    if (inFlight.has(guard)) {
      return Array.isArray(run.suggestedActions) && run.suggestedActions.length
        ? run.suggestedActions.slice(0, 3)
        : buildFallbackSuggestions(run);
    }
    inFlight.add(guard);
    try {
      const actions = await generateSuggestions(run);
      if (typeof persist === "function") {
        persist(run.runId, key, actions);
      }
      return actions;
    } finally {
      inFlight.delete(guard);
    }
  } catch {
    return buildFallbackSuggestions(run);
  }
}
