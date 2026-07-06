import { generateUtility } from "../ai/openrouter.js";
import { getAvailableMoves } from "./movement.js";
import { getQuestPayload } from "./quests.js";

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

export function activeObjective(run) {
  // Sandbox-aware: getQuestPayload suppresses the procedural spine in a sandbox, so
  // suggestions don't feed the contradictory "trail of your quarry" objective into
  // an open world. Player-authored objectives DO surface here.
  try {
    const { activeQuests, mainQuest } = getQuestPayload(run);
    const quests = Array.isArray(activeQuests) ? activeQuests : [];
    // Ordering: an undertaking the player EXPLICITLY took on (an accepted job, a
    // declared goal) outranks the ambient main spine — otherwise an in-flight
    // delivery never reaches the chips while quest_main is active. Seeded side
    // content (no player choice) does not jump the queue.
    const chosen = quests.find(
      (q) => q && (q.flags?.playerAccepted === true || q.flags?.playerAuthored === true || q.authoredBy === "player")
    );
    const quest = chosen || mainQuest || quests[0] || null;
    if (!quest) {
      return "";
    }
    const stages = Array.isArray(quest.stages) ? quest.stages : null;
    // Progress is tracked by the quest.stage INDEX (advanceQuests) — stages carry
    // no per-stage status field, so the old `find(status !== "complete")` always
    // returned stage 0 and the chips kept suggesting an already-done objective.
    const stage = stages ? stages[Number.isInteger(quest.stage) ? quest.stage : 0] || stages[0] : null;
    const objective = (stage && stage.objective) || quest.objective;
    return isStr(objective) ? clip(objective) : "";
  } catch {
    return "";
  }
}

// ── MOTIVATION LAYER (the "why it matters") ───────────────────────────────────
// Suggestions must be MOTIVATED, not just possible: grounded in committed state AND
// connected to why an action matters to THIS character. That "why" comes from two
// sources this module reads (distinct from the scene-context lines — location/
// people/ways-onward — that describe what's HERE): the character's situation
// (their origin / what they've become) and the ACTIVE PRESSURES carried by the D.5
// thread layer (the seeded fronts — "meaning across time"). Without these the GM is
// an announcer listing possible moves; with them it offers reasons to act.

// The character's standing — who they are NOW — as a one-line motivation anchor.
// For an authored-origin world (Babel: "The Beckoned") this is the champion premise
// the opening set up; it persists after run.narration is overwritten by action
// prose, so motivation survives across turns.
function characterSituation(run) {
  const p = run?.player || {};
  const bits = [];
  if (isStr(p.origin)) bits.push(p.origin);
  if (isStr(p.className) && !isStr(p.origin)) bits.push(p.className);
  return bits.join("; ");
}

// Active pressures from the thread layer, at a PLAYER-APPROPRIATE reveal level: a
// revealed thread contributes its agenda; a rumored thread only its title (its
// agenda stays hidden until revealed). A hidden thread NEVER surfaces here — the
// same reveal discipline the scene payload's thread summary uses. These are the
// stakes an action can be motivated toward.
function activePressures(run) {
  const threads = run?.threads && typeof run.threads === "object" ? Object.values(run.threads) : [];
  const out = [];
  for (const t of threads) {
    if (!t || typeof t !== "object") continue;
    if (t.status === "resolved" || t.status === "expired" || t.status === "abandoned") continue;
    const reveal = t.revealState || "hidden";
    if (reveal === "hidden") continue;
    const title = isStr(t.title) ? t.title : null;
    if (reveal === "revealed") {
      const agenda = isStr(t.agenda) ? t.agenda : "";
      out.push(clip([title, agenda].filter(Boolean).join(" — ")));
    } else if (title) {
      out.push(clip(`${title} (stirring nearby)`));
    }
  }
  return out.filter(Boolean).slice(0, 3);
}

// Deterministic, scene-aware fallback: always exactly 3, varied across
// investigate / talk-or-orient / move — and MOTIVATED (tied to pursuing the goal,
// learning what's here, or getting your bearings) rather than the bare "call out
// and see who answers" that reads as disconnected when the player is alone.
export function buildFallbackSuggestions(run) {
  const location = run?.locations?.[run?.currentLocationId] || {};
  const locName = isStr(location.name) ? location.name : "the area";
  const npcs = presentNpcs(run);
  const moves = availableMoveNames(run);
  const objective = activeObjective(run);

  const investigate = `Search ${locName} for anything that tells you what you're dealing with`;
  const talk = npcs.length && isStr(npcs[0].displayName)
    ? `Seek out ${npcs[0].displayName} — they may know more than they show`
    : "Take stock of yourself and this place before you commit to a path";
  const move = moves.length
    ? (isStr(objective) ? `Set out toward ${moves[0]} and pursue what you came for` : `Set out toward ${moves[0]} and see where it leads`)
    : "Press deeper and find out what this place is hiding";

  return [investigate, talk, move].map(clip);
}

function buildMessages(run) {
  const location = run?.locations?.[run?.currentLocationId] || {};
  const player = run?.player || {};
  const npcNames = presentNpcs(run).map((npc) => npc.displayName).filter(isStr);
  const moves = availableMoveNames(run);
  const objective = activeObjective(run);
  const situation = characterSituation(run);
  const pressures = activePressures(run);
  const recent = Array.isArray(run?.timeline)
    ? run.timeline.slice(-3).map((event) => event?.summary || event?.type).filter(isStr)
    : [];

  const context = [
    `Location: ${isStr(location.name) ? location.name : "Unknown"}${isStr(location.description) ? ` — ${clip(location.description)}` : ""}`,
    `Character: ${isStr(player.displayName) ? player.displayName : "the adventurer"}${isStr(player.className) ? `, ${player.className}` : ""}`,
    // MOTIVATION anchors (why an action matters to THIS character) — distinct from
    // the scene-context lines above (what is HERE). See characterSituation / activePressures.
    situation ? `Who you are: ${situation}` : "",
    objective ? `Current goal: ${objective}` : "",
    pressures.length ? `Pressures in play: ${pressures.join("; ")}` : "",
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
        "Each is a short imperative phrase (4 to 12 words), concrete and specific to THIS scene. " +
        "CRUCIAL: each action must be MOTIVATED, not merely possible — connect it to WHY it matters to " +
        "this character right now (their situation/goal, the pressures in play, or what the scene just set up), " +
        "so the player feels a reason to act, not just a list of things they are allowed to do. " +
        "The three must vary in approach: one to investigate or examine something here, one to talk to " +
        "or interact with someone present (or, if no one is here, to get oriented), and one to move or advance toward the goal. " +
        "Ground every action in what the context establishes; never invent people, places, or objects not present. " +
        "No numbering, no quotes, no commentary. " +
        'Reply ONLY with a compact JSON array of 3 strings, e.g. ["Search the drone wreck for salvage worth carrying","Ask Grace what a license actually buys","Take the north road to Hollow Pine while the trail is quiet"].'
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

// A suggested action that DIRECTS the player at a person — "approach the warden",
// "ask the merchant", "engage the curious locals" — presupposes that person is
// here. Exploratory calls into the unknown ("call out and see who answers") do NOT.
const PERSON_DIRECTED = /\b(?:talk to|speak (?:to|with)|ask|approach|greet|question|confront|engage|hail|persuade|bargain with|negotiate with|interrogate|address|consult|chat with|flag down|beckon|petition|plead with|interview)\b/i;
const PEOPLE_NOUN = /\b(?:locals?|villagers?|townsfolk|folk|crowd|guards?|soldiers?|strangers?|merchants?|patrons?|bystanders?|onlookers?|residents?|inhabitants?|the others?|companions?|allies|the party|the group|nearby (?:people|figures))\b/i;
const EXPLORATORY = /\b(?:call out|cry out|shout|listen|see who|look for|search for|wait for|whoever|who(?:'?s| is) (?:there|here)|anyone)\b/i;

// Validates ONE suggestion against current scene presence. The server already owns
// truth for attempts/possession — the same discipline applied to scaffolding:
// a chip that points the player at an NPC requires that NPC in the present cast.
function suggestionIsReachable(run, suggestion, presentNamesLc) {
  const lc = String(suggestion || "").toLowerCase();
  if (!isStr(lc)) {
    return false;
  }
  const namesPresentNpc = presentNamesLc.some((name) => name && lc.includes(name));
  if (namesPresentNpc) {
    return true; // explicitly references someone who is actually here
  }
  // Directs at / names a person or group that the scene does not contain, and is
  // not an exploratory call into the unknown -> a phantom entity. Suppress it.
  if ((PERSON_DIRECTED.test(lc) || PEOPLE_NOUN.test(lc)) && !EXPLORATORY.test(lc)) {
    return false;
  }
  return true;
}

/**
 * Filters LLM-proposed suggestions against scene state, dropping chips that invoke
 * entities the state says aren't here (the model can ignore the "People present"
 * context and invent NPCs). Rejected slots are backfilled from the deterministic,
 * scene-derived fallback so the player always sees exactly 3. Never throws.
 * @param {object} run
 * @param {string[]} list
 * @returns {string[]}
 */
export function validateSuggestions(run, list) {
  const presentNamesLc = presentNpcs(run)
    .map((npc) => (isStr(npc.displayName) ? npc.displayName.toLowerCase() : ""))
    .filter(Boolean);
  const kept = [];
  for (const suggestion of Array.isArray(list) ? list : []) {
    const cleaned = clip(suggestion);
    if (isStr(cleaned) && suggestionIsReachable(run, cleaned, presentNamesLc)) {
      kept.push(cleaned);
    }
  }
  if (kept.length < 3) {
    for (const fb of buildFallbackSuggestions(run)) {
      if (kept.length >= 3) {
        break;
      }
      if (!kept.some((k) => k.toLowerCase() === fb.toLowerCase())) {
        kept.push(fb);
      }
    }
  }
  return kept.slice(0, 3);
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
      // Server owns truth for scaffolding too: drop chips that reference NPCs/
      // entities not present in the scene; backfill from the scene-aware fallback.
      return validateSuggestions(run, parsed);
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
