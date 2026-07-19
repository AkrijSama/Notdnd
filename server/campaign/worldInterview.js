// THE WORLD INTERVIEW — the Babel question set, generalized and productized.
//
// This is a CONVERSATION, not a form (the UX law). The AI asks a fixed, cozy set of
// questions one at a time. Every question is SKIPPABLE ("let the world decide" mints a
// default), and a "just build it" button at ANY point completes the rest from the spark
// in a single draft call. The interview never blocks play — the worst case is a world
// drafted entirely from the one-sentence spark.
//
// Pure + serializable: interview state is a plain object so it is trivially RESUMABLE
// (persist it, hand it back to `resumeInterview`). No provider, no I/O here — the draft
// engine (server/campaign/worldDraft.js) consumes `interviewAnswers(state)`.
//
// The questions ARE the UX. Copy is owner-reviewed; keep the register warm and plain.

export const WORLD_INTERVIEW_VERSION = 1;

// The generalized Babel question set. `feeds` names the draft section an answer informs.
// `skipLabel` is the "let the world decide" affordance for that question.
export const INTERVIEW_QUESTIONS = Object.freeze([
  {
    id: "landmark",
    prompt: "Every world has one thing everyone's heard of. What's the landmark of yours — the thing people point to on the horizon?",
    help: "A tower that shouldn't exist, a wound in the sky, a drowned city, a mountain that hums…",
    placeholder: "e.g. a hundred-floor tower at the south pole, leaking something into the green",
    skipLabel: "Let the world decide",
    feeds: "pois"
  },
  {
    id: "remnant",
    prompt: "Something came before. What did the old world leave behind that people still live with?",
    help: "Ruins, a broken law, a debt, a machine still running, a promise nobody kept…",
    placeholder: "e.g. the licences — you can make money off the corruption, you just can't cure it",
    skipLabel: "Let the world decide",
    feeds: "cosmology"
  },
  {
    id: "temptation",
    prompt: "People with sense stay home. What's the temptation that makes your adventurers risk it anyway?",
    help: "Money, a cure, a person, an answer, a way back…",
    placeholder: "e.g. salvage rights worth a fortune, if you're licensed and fast",
    skipLabel: "Let the world decide",
    feeds: "fronts"
  },
  {
    id: "threats",
    prompt: "What's out there, weakest to worst? Give me a few rungs of the danger ladder.",
    help: "Four to six rungs is plenty — from the everyday nuisance up to the thing nobody walks away from.",
    placeholder: "e.g. stray wildlife → desperate salvagers → chaos-touched things → the demons",
    skipLabel: "Let the world decide",
    feeds: "threatLadder"
  },
  {
    id: "signature",
    prompt: "What's the one danger this world is known for — its signature, the thing players will tell stories about?",
    help: "The trademark. In Babel it's getting turned around in woods that rearrange themselves.",
    placeholder: "e.g. the Green Static — the corruption that eats your sense of direction",
    skipLabel: "Let the world decide",
    feeds: "bestiary"
  },
  {
    id: "powers",
    prompt: "Who holds power here? Name three or four factions pulling the strings.",
    help: "Guilds, gangs, churches, corporations, crowns, cults — whoever people owe or fear.",
    placeholder: "e.g. the Charter, the Root Shrine keepers, the Hollow Congregation",
    skipLabel: "Let the world decide",
    feeds: "factions"
  },
  {
    id: "region",
    prompt: "Last thing — what's this first region called? Or I can name it for you.",
    help: "Just the corner of the world you'll start in. You can leave it to me.",
    placeholder: "e.g. the Verdance",
    skipLabel: "Name it for me",
    feeds: "identity"
  }
]);

const QUESTION_BY_ID = new Map(INTERVIEW_QUESTIONS.map((q) => [q.id, q]));
export function interviewQuestionById(id) { return QUESTION_BY_ID.get(id) || null; }

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }

/**
 * Begin an interview from a spark (the one-sentence world description). Returns a plain,
 * serializable state object. `answers[id]` = { value } for a real answer or
 * { skipped: true } for "let the world decide".
 */
export function createInterview(spark = "", { version = WORLD_INTERVIEW_VERSION } = {}) {
  return {
    version,
    spark: String(spark || "").trim(),
    order: INTERVIEW_QUESTIONS.map((q) => q.id),
    answers: {},
    cursor: 0,
    status: "asking" // asking → ready ("just build" or all questions resolved)
  };
}

// The question currently in front of the user (or null when the interview is resolved).
export function currentQuestion(state) {
  if (!state || state.status === "ready") return null;
  const id = state.order?.[state.cursor];
  return id ? interviewQuestionById(id) : null;
}

// Advance the cursor to the next question that has neither been answered nor skipped.
function advanceCursor(state) {
  let cursor = state.cursor;
  while (cursor < state.order.length && state.answers[state.order[cursor]]) cursor += 1;
  const status = cursor >= state.order.length ? "ready" : state.status;
  return { ...state, cursor, status };
}

/** Record a real answer to a question (defaults to the current one). Pure. */
export function answerQuestion(state, arg) {
  const id = typeof arg === "string" ? currentQuestion(state)?.id : arg?.id ?? currentQuestion(state)?.id;
  const value = typeof arg === "string" ? arg : arg?.answer ?? arg?.value;
  if (!id || !QUESTION_BY_ID.has(id)) return state;
  if (!isNonEmptyString(value)) return skipQuestion(state, { id }); // empty submit = skip
  const answers = { ...state.answers, [id]: { value: String(value).trim() } };
  return advanceCursor({ ...state, answers });
}

/** Skip a question — "let the world decide" mints its default at draft time. Pure. */
export function skipQuestion(state, arg = {}) {
  const id = typeof arg === "string" ? arg : arg?.id ?? currentQuestion(state)?.id;
  if (!id || !QUESTION_BY_ID.has(id)) return state;
  const answers = { ...state.answers, [id]: { skipped: true } };
  return advanceCursor({ ...state, answers });
}

/**
 * "Just build it" — defer every UNresolved question (they'll be minted from the spark by
 * the draft engine) and mark the interview ready. Pure. Callable at any point.
 */
export function justBuild(state) {
  const answers = { ...state.answers };
  for (const id of state.order) {
    if (!answers[id]) answers[id] = { skipped: true, deferred: true };
  }
  return { ...state, answers, cursor: state.order.length, status: "ready" };
}

export function isComplete(state) {
  if (!state) return false;
  if (state.status === "ready") return true;
  return state.order.every((id) => Boolean(state.answers[id]));
}

// Counts for the progress affordance ("3 of 7").
export function interviewProgress(state) {
  const total = state?.order?.length || 0;
  const answered = state?.order?.filter((id) => state.answers[id] && !state.answers[id].skipped).length || 0;
  const resolved = state?.order?.filter((id) => Boolean(state?.answers?.[id])).length || 0;
  return { total, answered, resolved, remaining: total - resolved };
}

/**
 * The draft-engine view of the interview: spark + a per-section answer map. Skipped /
 * deferred questions surface as null so the draft prompt knows to invent them.
 */
export function interviewAnswers(state) {
  const out = { spark: state?.spark || "", byId: {}, byFeed: {} };
  for (const q of INTERVIEW_QUESTIONS) {
    const a = state?.answers?.[q.id];
    const value = a && !a.skipped && isNonEmptyString(a.value) ? a.value.trim() : null;
    out.byId[q.id] = value;
    out.byFeed[q.feeds] = value;
  }
  return out;
}

/**
 * Rehydrate a persisted interview, tolerating partial/foreign shapes (resume-safety).
 * Unknown question ids are dropped; missing structure is rebuilt from the current set.
 */
export function resumeInterview(saved = {}) {
  const base = createInterview(saved.spark || "", { version: saved.version });
  const answers = {};
  if (saved.answers && typeof saved.answers === "object") {
    for (const id of base.order) {
      const a = saved.answers[id];
      if (!a) continue;
      if (a.skipped) answers[id] = { skipped: true, ...(a.deferred ? { deferred: true } : {}) };
      else if (isNonEmptyString(a.value)) answers[id] = { value: a.value.trim() };
    }
  }
  const state = advanceCursor({ ...base, answers });
  return saved.status === "ready" ? { ...state, cursor: state.order.length, status: "ready" } : state;
}
