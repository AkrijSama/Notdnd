// Harness-audit helpers: (1) corpus classification using the ENGINE'S OWN intent
// detectors against a rich standard fixture — the classes are what the engine
// itself would claim, not a parallel regex guess; (2) the narration-state
// contradiction auditor — crude NER over GM prose checked against committed
// state (WARN-grade: the phantom tally is the prose-integrity metric).
//
// Pure helpers, no engine changes; imported by scripts/selfplay.mjs,
// scripts/corpusExtract.mjs, and unit tests.
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { detectMoveIntent } from "../server/solo/movement.js";
import { detectSearchIntent } from "../server/solo/search.js";
import { detectTakeIntent } from "../server/solo/take.js";
import { detectQuestAcceptIntent } from "../server/solo/questFlow.js";
import { detectPlayerGoal } from "../server/solo/quests.js";
import { buildDeliveryOffer } from "../server/campaign/authoredQuests.js";

// A run where EVERY mechanic has something to claim: a live job offer, a
// revealed takeable crate, named + unexplored exits, unrevealed searchDetails.
// "In a context where everything is available, which mechanic claims this input?"
export function buildRichFixtureRun() {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.currentLocationId = "second_location";
  run.locations.second_location.state = { visited: true, discovered: true };
  run.locations.second_location.searchDetails = [
    { detailId: "fx_niche", label: "A Hidden Niche", description: "a niche behind loose stone", revealed: false },
    {
      detailId: "fx_crate",
      label: "A Sealed Crate",
      description: "a crate set down for carrying",
      revealed: true,
      takeable: true,
      taken: false,
      takeKeywords: ["crate", "box", "cargo", "strongbox", "chest", "case", "parcel", "package"],
      grantItem: { itemId: "fx_crate_item", name: "A Sealed Crate", qty: 1 }
    }
  ];
  const offer = buildDeliveryOffer(
    { tone: "dark fantasy", name: "Fixture" },
    { giverLocationName: "the crossing", destinationId: "third_location", destinationName: "the far edge" }
  );
  run.npcs = {
    npc_fixture_giver: {
      npcId: "npc_fixture_giver",
      displayName: "A waiting figure",
      role: "stranger",
      currentLocationId: "second_location",
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: [],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      questOffer: offer
    }
  };
  return run;
}

const QUESTION_RE = /(^\s*(?:are|is|am|was|were|does|do|did|can|could|how|what|where|when|who|whose|why|will|would|should|which)\b)|\?\s*$/i;

// Which single mechanic (in the engine's own dispatch order) claims this text?
function primaryMechanic(run, text) {
  if (detectQuestAcceptIntent(run, text)) return "accept";
  if (detectTakeIntent(run, text)) return "take";
  const move = detectMoveIntent(run, text);
  if (move?.reachable || move?.knownUnreachable) return "move";
  if (detectSearchIntent(run, text)) return "search";
  if (detectPlayerGoal(text)) return "goal";
  return null;
}

/**
 * Classifies a free-text input against the rich fixture:
 * accept | take | move | search | goal | question | compound | other.
 * COMPOUND = more than one mechanic claims a clause of the utterance (the class
 * that produced the owner's crash input: take AND carry AND open).
 */
export function classifyCorpusInput(run, text) {
  const whole = primaryMechanic(run, text);
  // Clause split: sentence bounds + coordinating joins players actually type.
  const clauses = String(text || "")
    .split(
      // Sentence bounds, "then", "and I/we/once/…", commas — plus bare "and"/
      // "then" ONLY when a committable verb follows ("…and pocket whatever…"),
      // so descriptive "and" ("useful and valuable") never splits.
      /[.;!?]|\band (?:then )?(?:i|we|once|after|when)\b|,\s*(?:then\s+)?(?:i\s+)?|\b(?:and|then)\s+(?=(?:i\s+)?(?:go|head|grab|take|pocket|pick|search|scour|rummage|loot|open|carry|move|walk|run|climb|accept|deliver|hand)\b)/i
    )
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);
  const clauseMechanics = new Set();
  for (const clause of clauses) {
    const m = primaryMechanic(run, clause);
    if (m && m !== "goal") clauseMechanics.add(m);
  }
  if (whole && clauseMechanics.size > 1) return "compound";
  if (!whole && clauseMechanics.size > 1) return "compound";
  if (whole) return whole;
  if (clauseMechanics.size === 1) return [...clauseMechanics][0];
  if (QUESTION_RE.test(text)) return "question";
  return "other";
}

/**
 * Surface-level question test, independent of what the engine claims. The
 * engine-mirror class and this flag DISAGREEING is itself a finding: a player
 * question that the dispatch layer would COMMIT as a mechanic (the
 * "How deep does this ruin go?" -> committed move class).
 */
export function looksLikeQuestion(text) {
  return QUESTION_RE.test(String(text || ""));
}

// ---------------------------------------------------------------------------
// Narration-state contradiction auditor (WARN-grade).
// ---------------------------------------------------------------------------

// Capitalized words that are prose furniture, not entities.
const PROSE_STOPWORDS = new Set([
  "the", "a", "an", "as", "and", "but", "or", "nor", "so", "yet", "for", "you",
  "your", "yours", "i", "it", "its", "they", "their", "them", "he", "she", "his",
  "her", "we", "our", "this", "that", "these", "those", "there", "here", "then",
  "now", "when", "where", "while", "with", "within", "without", "beyond", "before",
  "after", "above", "below", "beneath", "behind", "between", "into", "onto", "from",
  "each", "every", "some", "no", "not", "nothing", "none", "one", "two", "three",
  "if", "though", "although", "yet", "still", "even", "just", "only", "perhaps",
  "suddenly", "meanwhile", "finally", "at", "in", "on", "to", "of", "by", "up",
  "down", "out", "off", "let", "let's", "what", "whatever", "who", "how", "why",
  "gm", "hp", "xp", "dc", "npc", "ok", "yes", "no", "time", "something", "someone",
  "somewhere", "everything", "nowhere", "further", "beware", "careful", "welcome",
  "everywhere", "hushed", "muffled", "distant", "scattered", "faint", "silence",
  "night", "day", "dawn", "dusk", "morning", "evening", "north", "south", "east",
  "west", "stay", "go", "run", "look", "watch", "listen", "wait", "take", "keep",
  "move", "stop", "come", "turn", "remember", "know", "god", "gods", "fate", "death"
]);

// Candidate named entities: runs of Capitalized tokens. A single capitalized
// token counts only when it is NOT sentence-initial (sentence starts capitalize
// anything); multi-token runs count anywhere.
export function extractProperNouns(prose) {
  const text = String(prose || "");
  const out = [];
  const re = /(^|[\s"'(—–-])([A-Z][a-z']+(?:\s+(?:of|the|and)\s+[A-Z][a-z']+|\s+[A-Z][a-z']+)*)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const candidate = match[2].trim();
    const tokens = candidate.split(/\s+/);
    const firstLower = tokens[0].toLowerCase();
    if (PROSE_STOPWORDS.has(firstLower)) continue;
    // Sentence-initial single tokens are ambiguous (sentence starts capitalize
    // anything) — but phantom NPC names LOVE that position ("Garrick eyes you
    // warily", "Ilse's eyes narrowed"). Allow the sentence-initial case only on
    // the name-like patterns: a possessive, or a following speech/gesture verb.
    const before = text.slice(0, match.index + match[1].length);
    const sentenceInitial = /(^|[.!?]\s*|["'“]\s*)$/.test(before);
    if (tokens.length === 1 && sentenceInitial) {
      const rest = text.slice(match.index + match[1].length + candidate.length);
      const nameLike =
        /^'s\b/.test(rest) ||
        /^\s+(?:eyes|says|said|nods|smiles|mutters|drawls|watches|waits|turns|steps|grins|replies|whispers|growls|frowns|laughs|shrugs|leans|studies|gestures)\b/.test(rest);
      if (!nameLike) continue;
    }
    if (tokens.length === 1 && tokens[0].length < 4) continue;
    out.push(candidate);
  }
  return [...new Set(out)];
}

// Every name the committed state can vouch for, from the SCENE PAYLOAD.
export function knownNamesFromScene(scene = {}) {
  const names = new Set();
  const add = (value) => {
    const v = String(value || "").trim();
    if (v) names.add(v.toLowerCase());
  };
  add(scene.location?.name);
  add(scene.player?.displayName);
  add(scene.worldName);
  add(scene.world?.name);
  for (const m of scene.availableMoves || []) add(m.name);
  for (const p of scene.areaMap?.pois || []) add(p.name);
  for (const c of scene.cast || []) add(c.displayName);
  for (const v of scene.visibleEntities || []) add(v.displayName);
  for (const i of scene.playerInventory || []) add(i.name);
  for (const i of scene.player?.inventory || []) add(i.name);
  for (const d of scene.discoveredDetails || []) add(d.label);
  for (const q of scene.quests?.activeQuests || []) add(q.title);
  if (scene.quests?.mainQuest) add(scene.quests.mainQuest.title);
  const states = scene.location?.flags?.objectStates || {};
  for (const key of Object.keys(states)) {
    add(states[key]?.label);
    add(key.replace(/-/g, " "));
  }
  if (scene.recentDevelopment) add(scene.recentDevelopment.title);
  return names;
}

// A candidate is vouched when any known name contains it or it contains a known
// name (word-level containment either way — "The Gilded Kingdoms Watch" vouches
// "Gilded Kingdoms"). Comparison is case-insensitive.
function vouched(candidate, knownNames) {
  const c = candidate.toLowerCase().replace(/'s\b/g, "");
  for (const known of knownNames) {
    if (known.includes(c) || c.includes(known)) return true;
  }
  // Token-level: every content token of the candidate appears in some known name.
  const tokens = c.split(/\s+/).filter((t) => !PROSE_STOPWORDS.has(t));
  if (tokens.length === 0) return true;
  return tokens.every((token) => [...knownNames].some((known) => known.includes(token)));
}

/**
 * Audits one narration (or a suggestion label) against committed scene state.
 * Returns { checked, phantoms: [{ name, sentence }] } — phantom = a proper noun
 * the committed state cannot vouch for. WARN-grade by design (model-dependent).
 */
export function auditProseAgainstState(prose, scene) {
  const knownNames = knownNamesFromScene(scene);
  const phantoms = [];
  for (const candidate of extractProperNouns(prose)) {
    if (vouched(candidate, knownNames)) continue;
    const sentence =
      String(prose)
        .split(/(?<=[.!?])\s+/)
        .find((s) => s.includes(candidate)) || String(prose).slice(0, 140);
    phantoms.push({ name: candidate, sentence: sentence.trim().slice(0, 180) });
  }
  return { checked: true, phantoms };
}

// ---------------------------------------------------------------------------
// Invented-agent auditor (WARN-grade).
// ---------------------------------------------------------------------------
// The phantom check only catches PROPER NOUNS — a narration that invents "a
// maintenance drone" to fight, a scavenger, or an answering voice sails through
// with 0 phantoms (the oss-120b drone-fight cell in the 2026-07-03 prose
// ladder). This auditor flags AGENCY the committed state cannot vouch for:
//   agent     — a generic animate noun ACTING (verb of agency in the sentence)
//               with no corresponding cast/committed entity
//   dialogue  — quoted speech attributed to anyone other than the player, with
//               no committed entity to speak it
//   state_tag — emitted pseudo-state tags ([UPDATE_ENTITY...] class) leaking
//               into prose
// Crude and lexicon-based by design (model-dependent, WARN-grade): tallied per
// battery run alongside the phantom count, never a hard failure.

// Generic animate nouns a model reaches for when it invents an actor.
// PERSON nouns are legitimate paraphrases of ANY committed cast member ("a
// figure steps into view" narrating the committed watcher NPC), so they are
// vouched whenever the scene has cast; the rest must token-match a committed
// name — a drone/wolf can't be a paraphrase of a human watcher.
const PERSON_NOUNS = new Set(["figure", "stranger", "voice", "someone", "somebody"]);
const AGENT_NOUNS = [
  "figure", "stranger", "drone", "scavenger", "creature", "voice", "guard",
  "soldier", "sentry", "warden", "watcher", "merchant", "thief", "hunter",
  "raider", "bandit", "assailant", "attacker", "enemy", "foe", "rider",
  "beast", "wolf", "hound", "robot", "android", "automaton", "someone", "somebody"
];

// Verbs that make a noun an ACTOR rather than scenery.
const AGENCY_VERB_RE = new RegExp(
  "\\b(?:answers?|answered|replies|replied|responds?|responded|speaks?|spoke|says?|said|whispers?|calls?|called|shouts?|mutters?|growls?|hisses|crackles?|sputters?|" +
    "steps?|stepped|moves?|moved|emerges?|emerged|appears?|appeared|approaches|approached|arrives?|arrived|lunges?|lunged|attacks?|attacked|strikes?|struck|swings?|charges?|charged|" +
    "watches|watched|waits?|waited|turns?|turned|hovers?|hovered|slides?|slid|crawls?|scurries|leaps?|circles?|stalks?|follows?|followed|blocks?|blocked|grabs?|grabbed|reaches|swivels?|beckons?|nods?|smiles?|grins?|stares?|" +
    "shatters?|shattered|clatters?|clattered|crashes?|crashed|collapses?|collapsed|topples?|falls?|fell|flees?|fled|retreats?|screams?|screamed|roars?|snarls?|bites?|claws?|fires?|shoots?|shot|dies|drops?|dropped)\\b",
  "i"
);

const PSEUDO_STATE_TAG_RE = /\[(?:UPDATE_ENTITY|NEW_ENTITY|CHECK|DAMAGE|LOOT|INITIATIVE)\b[^\]]*\]/gi;

// Player-voiced speech is legitimate: "you call out, 'Hello?'".
const PLAYER_SPEECH_RE = /\b(?:you|your)\b[^"“]*(?:say|says|call|shout|whisper|mutter|demand|ask|reply|announce|voice)/i;

// Every token the committed state can vouch AS AN ACTOR (cast, visible
// entities, plus the full known-name pool so "the watcher" is vouched by
// npc_momentum_watcher wherever it surfaces in the payload).
function knownAgentTokens(scene = {}) {
  const tokens = new Set();
  for (const name of knownNamesFromScene(scene)) {
    for (const t of String(name).toLowerCase().split(/[\s-]+/)) {
      const clean = t.replace(/[^a-z']/g, "");
      if (clean.length >= 3) tokens.add(clean);
    }
  }
  return tokens;
}

// Actual committed NPC presence. visibleEntities is NOT a cast signal — it
// lists locations and the player too, which would vouch every invented voice.
function sceneHasCast(scene = {}) {
  return Array.isArray(scene.cast) && scene.cast.length > 0;
}

/**
 * Audits one narration for invented agents/agency against committed scene state.
 * Returns { checked, inventions: [{ kind, detail, sentence }] }.
 */
export function auditInventedAgents(prose, scene) {
  const text = String(prose || "");
  const inventions = [];
  const vouchedTokens = knownAgentTokens(scene);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

  for (const sentence of sentences) {
    // The player's own body/voice is never an invented agent ("your voice
    // announced", "my hand closes on nothing") — strip possessive-of-player
    // mentions before the noun scan.
    const lower = sentence.toLowerCase().replace(/\b(?:your|my)\s+(?:own\s+)?\w+/g, " ");

    // (a) Unvouched animate noun ACTING in the sentence. A NEGATED mention
    // ("no figure steps from the shadows") is honest absence, not invention.
    for (const noun of AGENT_NOUNS) {
      if (vouchedTokens.has(noun)) continue;
      if (PERSON_NOUNS.has(noun) && sceneHasCast(scene)) continue;
      const nounRe = new RegExp(`\\b${noun}s?\\b`, "i");
      const negatedRe = new RegExp(`\\b(?:no|not a|nor a|neither|without a|no other)\\s+(?:\\w+\\s+)?${noun}s?\\b`, "i");
      if (nounRe.test(lower) && !negatedRe.test(lower) && AGENCY_VERB_RE.test(sentence)) {
        inventions.push({ kind: "agent", detail: noun, sentence: sentence.trim().slice(0, 180) });
        break; // one agent finding per sentence is enough for the tally
      }
    }

    // (b) Quoted dialogue attributed to a non-player speaker with no committed
    // entity present to speak it.
    const hasQuote = /["“][^"”]{2,}["”]/.test(sentence);
    if (hasQuote && !PLAYER_SPEECH_RE.test(sentence) && !sceneHasCast(scene)) {
      inventions.push({ kind: "dialogue", detail: "speech with no committed speaker", sentence: sentence.trim().slice(0, 180) });
    }
  }

  // (c) Pseudo-state tags leaking into prose.
  for (const match of text.matchAll(PSEUDO_STATE_TAG_RE)) {
    inventions.push({ kind: "state_tag", detail: match[0].slice(0, 60), sentence: match[0].slice(0, 180) });
  }

  return { checked: true, inventions };
}

// ===========================================================================
// LETTER-GRADE SESSION SCORER (autoplay grade harness)
// ===========================================================================
// A grading LAYER on top of the existing selfplay drive + auditors. It consumes
// per-turn observations the runner collects (narration, attemptResult, scene
// before/after, model attribution) and emits, against the SAME five axes as the
// manual walkthrough grade (docs/design/grade-improvement-roadmap.md):
//   NARRATION, COHERENCE, DEPTH/TRACTION, MECHANICAL, PACING
// letter + numeric per axis, plus machine-actionable findings and a
// deepseek-vs-fallback turn count. Detection reuses this module's auditors
// (auditProseAgainstState = phantom NPC/lore #27/#41, auditInventedAgents =
// invented agents/dialogue/state-tag leaks) and adds the resolver-sweep gap
// classes. Pure — no engine or network — so it is unit-testable and the runner
// stays thin.

// The representative GM. A turn NOT served by this is a fallback (local 8b /
// gemini) and is EXCLUDED from the narration + coherence grades — fallback prose
// is not representative of the product.
export const REAL_GM_RE = /deepseek/i;
export function isRealGmModel(model) {
  return REAL_GM_RE.test(String(model || ""));
}

// Numeric → letter on the standard scale.
export function letterFor(numeric) {
  if (numeric == null) return "N/A";
  const n = Number(numeric);
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 93) return "A";
  if (n >= 90) return "A-";
  if (n >= 87) return "B+";
  if (n >= 83) return "B";
  if (n >= 80) return "B-";
  if (n >= 77) return "C+";
  if (n >= 73) return "C";
  if (n >= 70) return "C-";
  if (n >= 67) return "D+";
  if (n >= 63) return "D";
  if (n >= 60) return "D-";
  return "F";
}

// Severity → deduction points. Every deduction is a finding, so an axis grade is
// always traceable to the specific failures that produced it.
export const SEVERITY_WEIGHT = Object.freeze({ critical: 22, high: 13, medium: 7, low: 3 });
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const AXIS_BASE = 95; // a clean session with zero findings scores A.

const NARRATION_STOPWORDS = new Set([
  "the", "a", "an", "and", "but", "or", "you", "your", "with", "into", "onto",
  "from", "that", "this", "there", "here", "then", "over", "under", "around",
  "through", "against", "toward", "before", "after", "above", "below", "like",
  "still", "even", "just", "some", "more", "than", "them", "they", "have", "has",
  "was", "were", "been", "will", "would", "could", "their", "what", "when", "where"
]);

function contentWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !NARRATION_STOPWORDS.has(w));
}

// RECYCLED-LOOP narration (the T3–T9 "disorients you" dead-loop). The pathology
// is the model RECYCLING WHOLE NARRATIONS near-verbatim on repeated same-action
// failure — not merely sharing setting nouns (a stone tavern is legitimately
// described with "stone" every turn; that is consistency, not a loop). So the
// signal is WHOLE-NARRATION SIMILARITY: cluster turns whose content-word sets
// overlap past `threshold` (Jaccard); a cluster of >= minTurns is a recycled
// loop. Returns ONE { phrase, turns } per cluster (phrase = the shared words),
// so a loop is a single finding, not one per word. WARN-grade.
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
export function detectRecycledLoop(narrationsByTurn, { minTurns = 3, threshold = 0.5 } = {}) {
  const items = narrationsByTurn
    .map(({ n, narration }) => ({ n, set: new Set(contentWords(narration)) }))
    .filter((it) => it.set.size >= 4); // too-short narrations can't be judged similar
  const loops = [];
  const used = new Set();
  for (let i = 0; i < items.length; i += 1) {
    if (used.has(items[i].n)) continue;
    const cluster = [items[i]];
    for (let j = 0; j < items.length; j += 1) {
      if (i === j || used.has(items[j].n)) continue;
      if (jaccard(items[i].set, items[j].set) >= threshold) cluster.push(items[j]);
    }
    if (cluster.length >= minTurns) {
      let shared = null;
      for (const c of cluster) {
        shared = shared ? new Set([...shared].filter((x) => c.set.has(x))) : new Set(c.set);
      }
      const turns = cluster.map((c) => c.n).sort((a, b) => a - b);
      turns.forEach((t) => used.add(t));
      loops.push({ phrase: [...(shared || [])].slice(0, 6).join(" ") || "(recycled prose)", turns });
    }
  }
  return loops.sort((a, b) => b.turns.length - a.turns.length);
}

// BAND / LABEL / NARRATION desync (#28): the resolved outcome band must agree
// with the roll-vs-DC and with the human label. A sub-DC roll that reads as a
// win, or a label that contradicts the band, is a desync.
export function detectBandDesync(attemptResult) {
  const ar = attemptResult || {};
  const cr = ar.checkResult || null;
  const band = String(ar.band || ar.outcome || "").toLowerCase();
  const label = String(ar.outcomeLabel || "").toLowerCase();
  if (!cr || typeof cr.total !== "number" || typeof cr.dc !== "number") return null;
  const belowDc = cr.total < cr.dc;
  // A clean win band on a sub-DC roll (unless it is the explicit at-a-cost band).
  const bandSaysWin = band === "success" && !band.includes("cost");
  if (belowDc && bandSaysWin) {
    return { detail: `roll ${cr.total} < DC ${cr.dc} but band="${ar.band || ar.outcome}"`, total: cr.total, dc: cr.dc };
  }
  // A label that says plain "success" while the band is a failure/at-a-cost.
  if (label && label.includes("success") && !label.includes("cost") && (band.includes("fail") || band.includes("cost"))) {
    return { detail: `band="${ar.band || ar.outcome}" but label="${ar.outcomeLabel}"`, total: cr.total, dc: cr.dc };
  }
  return null;
}

const NIGHT_WORDS = /\b(?:night|nightfall|midnight|dusk|sundown|sunset|evening|moonlight|starlight|after dark|darkness falls)\b/i;
const DAY_WORDS = /\b(?:dawn|sunrise|daybreak|morning|midday|noon|afternoon|daylight|sunlight)\b/i;
const ELAPSED_WORDS = /\b(?:hours? (?:pass|passed|later|have passed)|by nightfall|long (?:since )?(?:passed|gone)|days? (?:pass|passed|later))\b/i;

// CLOCK DIVERGENCE (#14): narrated time-of-day / elapsed time that contradicts
// the committed world clock. WARN-grade heuristic.
export function detectClockDivergence(narration, worldTime) {
  const wt = worldTime || {};
  const text = String(narration || "");
  const min = typeof wt.minuteOfDay === "number" ? wt.minuteOfDay : null;
  const isNight = wt.isNight === true;
  const clock = wt.clock || (min != null ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}` : "?");
  // Narration says night, committed clock says day (daytime minutes, not night).
  if (NIGHT_WORDS.test(text) && min != null && isNight === false && min >= 6 * 60 && min < 17 * 60) {
    return { detail: `narration reads night ("${(text.match(NIGHT_WORDS) || [])[0]}") but committed clock=${clock} (day)` };
  }
  // Narration says dawn/morning, committed clock says night.
  if (DAY_WORDS.test(text) && isNight === true) {
    return { detail: `narration reads day ("${(text.match(DAY_WORDS) || [])[0]}") but committed clock=${clock} (night)` };
  }
  // Narration asserts significant elapsed time — flag when the clock never moved
  // (caller passes worldTime with `advanced:false` to signal a static clock).
  if (ELAPSED_WORDS.test(text) && wt.advanced === false) {
    return { detail: `narration asserts elapsed time ("${(text.match(ELAPSED_WORDS) || [])[0]}") but the committed clock did not advance` };
  }
  return null;
}

// CONDITIONS WITHOUT SHED (#26): a debuff count that only ever grows across the
// session and reaches a stack is the "4 debuffs stacked forever, no clearing"
// class. conditionCounts is the active-condition count per turn, in order.
export function detectConditionsWithoutShed(conditionCounts, { stackAt = 3 } = {}) {
  const counts = (conditionCounts || []).filter((c) => typeof c === "number");
  if (counts.length < 2) return null;
  const peak = Math.max(...counts);
  let everDropped = false;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] < counts[i - 1]) everDropped = true;
  }
  if (peak >= stackAt && !everDropped) {
    return { detail: `${peak} conditions stacked and never shed across ${counts.length} turns`, peak };
  }
  return null;
}

function pushFinding(findings, f) {
  findings.push({
    axis: f.axis,
    severity: f.severity,
    turns: Array.isArray(f.turns) ? f.turns : f.turns != null ? [f.turns] : [],
    failure: f.failure,
    rootCause: f.rootCause,
    fixTarget: f.fixTarget
  });
}

/**
 * Grade a session. `turns` is an array of per-turn observations:
 *   { n, intent, narration, model, latencyMs, fallback,
 *     attemptResult, scene, sceneBefore, sceneAfter, worldTime, conditionCount }
 * Returns { axes:{narration,coherence,depth,mechanical,pacing}, findings[],
 *           integrity:{total,real,fallback,excludedTurns,valid}, meta }.
 * NARRATION + COHERENCE are computed on REAL-GM turns only; a session that is
 * mostly fallback marks those two axes invalid.
 */
export function gradeSession(turns = [], opts = {}) {
  const isReal = opts.isRealGmModel || isRealGmModel;
  const list = Array.isArray(turns) ? turns : [];
  const realTurns = list.filter((t) => isReal(t.model) && !t.fallback);
  const fallbackTurns = list.filter((t) => !isReal(t.model) || t.fallback);
  const integrity = {
    total: list.length,
    real: realTurns.length,
    fallback: fallbackTurns.length,
    excludedTurns: fallbackTurns.map((t) => t.n),
    // Narration/coherence need a real-GM majority to be a valid product grade.
    valid: list.length > 0 && realTurns.length / list.length >= 0.5
  };

  const findings = [];

  // ---- COHERENCE (real turns): phantom NPC/lore, invented agents, band-desync,
  // clock divergence ----
  for (const t of realTurns) {
    const scene = t.scene || {};
    const phantomRes = auditProseAgainstState(t.narration, scene);
    for (const p of phantomRes.phantoms) {
      pushFinding(findings, {
        axis: "coherence", severity: "critical", turns: t.n,
        failure: `T${t.n}: narration names "${p.name}" — no committed entity/fact vouches it ("${p.sentence}")`,
        rootCause: "GM invented a proper-noun NPC/lore fact not committed to state (#27 phantom NPC / #41 phantom lore)",
        fixTarget: "server/solo/npcCommit.js phantom auditor (promote-or-strip) + GM-prompt name/lore discipline"
      });
    }
    const inv = auditInventedAgents(t.narration, scene);
    for (const iv of inv.inventions) {
      const sev = iv.kind === "state_tag" ? "high" : "high";
      pushFinding(findings, {
        axis: iv.kind === "state_tag" ? "narration" : "coherence", severity: sev, turns: t.n,
        failure: `T${t.n}: invented ${iv.kind} "${iv.detail}" with no committed backing ("${iv.sentence}")`,
        rootCause: iv.kind === "state_tag"
          ? "pseudo-state tag leaked into prose (interpreter output not stripped)"
          : "GM narrated an actor/speaker with no committed entity (B2 uncommitted social/agency)",
        fixTarget: iv.kind === "state_tag"
          ? "server/gm/actionNarration.js voice/strip pass"
          : "server/solo/npcCommit.js commit-or-strip + GM-prompt actor discipline"
      });
    }
    const desync = detectBandDesync(t.attemptResult);
    if (desync) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: t.n,
        failure: `T${t.n}: band/label desync — ${desync.detail}`,
        rootCause: "resolved outcome band disagrees with roll-vs-DC or human label (#28 band/label/narration desync)",
        fixTarget: "server/solo/attempt.js outcome/band/outcomeLabel derivation"
      });
    }
    const clockDiv = detectClockDivergence(t.narration, t.worldTime);
    if (clockDiv) {
      pushFinding(findings, {
        axis: "coherence", severity: "medium", turns: t.n,
        failure: `T${t.n}: clock divergence — ${clockDiv.detail}`,
        rootCause: "GM narrates a time the committed world clock (#14) does not reflect",
        fixTarget: "server/solo/worldClock.js durationMinutes commit + GM-prompt clock-awareness clause"
      });
    }
  }

  // ---- NARRATION (real turns): AI-tells, recycled-loop, thin fallback prose ----
  for (const t of realTurns) {
    const emdashes = (String(t.narration || "").match(/[—–―]|--/g) || []).length;
    if (emdashes > 0) {
      pushFinding(findings, {
        axis: "narration", severity: "low", turns: t.n,
        failure: `T${t.n}: ${emdashes} em-dash AI-tell(s) leaked into narration`,
        rootCause: "narration bypassed the em-dash strip (likely the fallback/template path)",
        fixTarget: "server/gm/voice.js stripAiTells + composeAttemptNarration voice pass"
      });
    }
  }
  const loops = detectRecycledLoop(realTurns.map((t) => ({ n: t.n, narration: t.narration })));
  for (const loop of loops.slice(0, 4)) {
    pushFinding(findings, {
      axis: "narration", severity: "high", turns: loop.turns,
      failure: `T${loop.turns.join("/")}: recycled imagery "${loop.phrase}" across ${loop.turns.length} turns`,
      rootCause: "failure-escalation not firing — repeated same-action outcomes recycle identical prose instead of escalating/opening options",
      fixTarget: "run.flags.failStreak escalation (server/solo/attempt.js) + GM-prompt anti-repeat/escalation clause"
    });
    // A recycled loop is also a DEPTH problem (on-rails / dead-loop).
    pushFinding(findings, {
      axis: "depth", severity: "high", turns: loop.turns,
      failure: `T${loop.turns.join("/")}: dead-loop — same outcome recycled, world not opening new options`,
      rootCause: "no escalation/branch on repeated failure; the world does not react to being stuck",
      fixTarget: "failure-escalation design (open new options on repeat) + run.flags.failStreak"
    });
  }

  // ---- DEPTH / TRACTION (all turns): did the world react on a signalled success? ----
  for (const t of list) {
    const ar = t.attemptResult || {};
    // Only judge a turn that produced a FRESH attempt result this turn. A reroute
    // turn (search / observe / move / take) commits via its own path and returns
    // no attemptResult; scene.latestAttemptResult then still holds the PREVIOUS
    // attempt (a `search` event does not overwrite the last `attempt` event), so
    // reading ar.success there attributes a stale prior success to a reroute turn
    // that legitimately committed nothing new — a false narrate-into-void. When the
    // runner reports freshAttempt we honor it; older observations (no flag) keep the
    // prior behavior. Reroute commits are judged by their own delta on the snapshot.
    const freshAttempt = t.freshAttempt !== false;
    const succeeded = ar.success === true || String(ar.band || ar.outcome || "").toLowerCase().includes("success");
    if (freshAttempt && succeeded && t.sceneBefore && t.sceneAfter) {
      if (JSON.stringify(t.sceneBefore) === JSON.stringify(t.sceneAfter)) {
        pushFinding(findings, {
          axis: "depth", severity: "high", turns: t.n,
          failure: `T${t.n}: signalled success committed NO state delta (narrate-into-void)`,
          rootCause: "a turn the engine calls a success changed no committed surface (loc/discovery/inv/quest/xp/objects/cast)",
          fixTarget: "server/solo/actions.js detect→route→commit for this intent class"
        });
      }
    }
  }

  // ---- MECHANICAL (all turns): checks resolve, clock/conditions fire ----
  for (const t of list) {
    const ar = t.attemptResult || {};
    if (ar.needsCheck === true && !ar.checkResult) {
      pushFinding(findings, {
        axis: "mechanical", severity: "high", turns: t.n,
        failure: `T${t.n}: needsCheck=true but no checkResult rolled`,
        rootCause: "a check was flagged required but the resolver did not roll it",
        fixTarget: "server/solo/attempt.js check-resolution path"
      });
    }
    const desync = detectBandDesync(ar);
    if (desync) {
      pushFinding(findings, {
        axis: "mechanical", severity: "medium", turns: t.n,
        failure: `T${t.n}: roll/band math desync — ${desync.detail}`,
        rootCause: "band derivation disagrees with the rolled total vs DC (#28)",
        fixTarget: "server/solo/attempt.js band derivation"
      });
    }
  }
  const shed = detectConditionsWithoutShed(list.map((t) => t.conditionCount));
  if (shed) {
    pushFinding(findings, {
      axis: "mechanical", severity: "medium", turns: list.map((t) => t.n),
      failure: `conditions-without-shed: ${shed.detail}`,
      rootCause: "conditions apply but the shed/expiry mechanism (#26) never clears them against the clock",
      fixTarget: "server/solo/conditions.js tick/shed against world clock"
    });
  }

  // ---- PACING (all turns): latency, fallback frequency, dead-loops ----
  for (const t of list) {
    const ms = typeof t.latencyMs === "number" ? t.latencyMs : null;
    if (ms != null && ms >= 30000) {
      pushFinding(findings, {
        axis: "pacing", severity: "high", turns: t.n,
        failure: `T${t.n}: turn latency ${(ms / 1000).toFixed(1)}s (>=30s)`,
        rootCause: "slow cloud turn; may trip the timeout→gemini fallback and stalls the read",
        fixTarget: "NOTDND_GM_CLOUD_TIMEOUT_MS + per-turn call fan-out (server/solo/gmProvider.js)"
      });
    } else if (ms != null && ms >= 20000) {
      pushFinding(findings, {
        axis: "pacing", severity: "medium", turns: t.n,
        failure: `T${t.n}: turn latency ${(ms / 1000).toFixed(1)}s (>=20s)`,
        rootCause: "borderline-slow cloud turn",
        fixTarget: "NOTDND_GM_CLOUD_TIMEOUT_MS + per-turn fan-out"
      });
    }
  }
  if (integrity.fallback > 0) {
    pushFinding(findings, {
      axis: "pacing", severity: "high", turns: integrity.excludedTurns,
      failure: `${integrity.fallback}/${integrity.total} turns fell to a fallback model (excluded from narration/coherence)`,
      rootCause: "cloud GM unavailable/timed-out on these turns; fallback prose is not representative",
      fixTarget: "cloud availability/timeout (NOTDND_GM_CLOUD_TIMEOUT_MS) + provider chain (server/ai/openrouter.js)"
    });
  }

  // ---- Axis scores from the findings ----
  const axisNumeric = (axis, gradeableTurns) => {
    if (gradeableTurns === 0) return null;
    const deduction = findings
      .filter((f) => f.axis === axis)
      .reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] || 0), 0);
    return Math.max(0, Math.min(100, AXIS_BASE - deduction));
  };
  const mk = (axis, gradeable, invalidNote) => {
    const numeric = axisNumeric(axis, gradeable);
    return {
      numeric,
      letter: numeric == null ? "N/A" : letterFor(numeric),
      gradeableTurns: gradeable,
      ...(invalidNote ? { invalid: true, note: invalidNote } : {})
    };
  };
  const narrCohInvalid = integrity.valid ? null : `only ${integrity.real}/${integrity.total} turns were real-deepseek — grade computed on a fallback-heavy session is NOT a valid product grade`;

  const axes = {
    narration: mk("narration", realTurns.length, narrCohInvalid),
    coherence: mk("coherence", realTurns.length, narrCohInvalid),
    depth: mk("depth", list.length),
    mechanical: mk("mechanical", list.length),
    pacing: mk("pacing", list.length)
  };

  // Rank findings: severity, then turn count (broader = worse).
  findings.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (b.turns.length - a.turns.length));

  return { axes, findings, integrity, meta: opts.meta || {} };
}

// Render a graded session to the machine-actionable markdown report written to
// docs/grades/auto-grade-<timestamp>.md.
export function renderGradeReport(graded, meta = {}) {
  const { axes, findings, integrity } = graded;
  const axisRow = (name, key) => {
    const a = axes[key] || {};
    const num = a.numeric == null ? "—" : a.numeric;
    return `| ${name} | **${a.letter}** | ${num} | ${a.gradeableTurns} |${a.invalid ? " ⚠️ INVALID" : ""}`;
  };
  const sevBadge = { critical: "🟥 CRITICAL", high: "🟧 HIGH", medium: "🟨 MEDIUM", low: "⬜ LOW" };
  const lines = [];
  lines.push(`# Auto-Grade — ${meta.timestamp || "session"}`);
  lines.push("");
  lines.push(`> Autoplay letter-grade of run \`${meta.runId || "?"}\` — ${integrity.total} turns, drive: \`${meta.drive || "free-text autoplay"}\`, tip \`${meta.sha || "?"}\`.`);
  lines.push(`> Scored against the manual walkthrough rubric (docs/design/grade-improvement-roadmap.md).`);
  lines.push("");
  lines.push("## Model integrity");
  lines.push("");
  lines.push(`- **Real deepseek turns:** ${integrity.real}/${integrity.total}`);
  lines.push(`- **Fallback turns (excluded from narration/coherence):** ${integrity.fallback}${integrity.excludedTurns.length ? ` (T${integrity.excludedTurns.join(", T")})` : ""}`);
  lines.push(`- **Grade validity:** ${integrity.valid ? "✅ real-GM majority — narration/coherence grades are representative" : "❌ FALLBACK-HEAVY — narration/coherence grades are NOT a valid product grade"}`);
  lines.push("");
  lines.push("## Grades");
  lines.push("");
  lines.push("| Axis | Grade | Numeric | Gradeable turns | |");
  lines.push("|---|---|---|---|---|");
  lines.push(axisRow("Narration", "narration"));
  lines.push(axisRow("Coherence", "coherence"));
  lines.push(axisRow("Depth / Traction", "depth"));
  lines.push(axisRow("Mechanical", "mechanical"));
  lines.push(axisRow("Pacing", "pacing"));
  lines.push("");
  lines.push(`## Machine-actionable findings (${findings.length}, ranked by severity)`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("_No deductions — clean session._");
  }
  findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${sevBadge[f.severity] || f.severity} · ${f.axis} · T${f.turns.join("/") || "—"}`);
    lines.push("");
    lines.push(`- **Observed:** ${f.failure}`);
    lines.push(`- **Root-cause hypothesis:** ${f.rootCause}`);
    lines.push(`- **Fix-target:** \`${f.fixTarget}\``);
    lines.push("");
  });
  return lines.join("\n");
}
