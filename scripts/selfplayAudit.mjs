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
    let candidate = match[2].trim();
    let tokens = candidate.split(/\s+/);
    // Strip a leading pronoun+apostrophe CONTRACTION ("I'll", "We'll", "He's",
    // "She'd", "You're", "They'll", "It's", "That's"…) and a lone "I". The capital
    // pronoun (sentence/quote start, or the word itself) otherwise reads as a
    // proper noun and false-flags a phantom NPC — the false CRITICAL on "I'll".
    // A real name GLUED after it ("He's Garrick") is preserved by dropping only the
    // contraction token; a genuine apostrophe-name ("O'Brien", "D'Ana") has a
    // non-pronoun stem and is kept.
    let strippedContraction = false;
    while (
      tokens.length > 0 &&
      (tokens[0].toLowerCase() === "i" ||
        /^(?:i|we|you|he|she|it|they|who|that|there|here|what|let)['’](?:ll|d|s|m|ve|re)?$/i.test(tokens[0]))
    ) {
      tokens.shift();
      strippedContraction = true;
    }
    if (tokens.length === 0) continue;
    if (strippedContraction) candidate = tokens.join(" ");
    const firstLower = tokens[0].toLowerCase();
    if (PROSE_STOPWORDS.has(firstLower)) continue;
    // Sentence-initial single tokens are ambiguous (sentence starts capitalize
    // anything) — but phantom NPC names LOVE that position ("Garrick eyes you
    // warily", "Ilse's eyes narrowed"). Allow the sentence-initial case only on
    // the name-like patterns: a possessive, or a following speech/gesture verb.
    // Skipped when we stripped a contraction (the surviving name's position no
    // longer starts at match.index, and it is already name-like enough to keep).
    const before = text.slice(0, match.index + match[1].length);
    const sentenceInitial = !strippedContraction && /(^|[.!?]\s*|["'“]\s*)$/.test(before);
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
  // Committed lore/place facts (#41): once the server commits a GM-asserted place
  // as canonical lore (npcCommit.commitNarratedLoreFact, type "gm_lore"), the name
  // is real — the grader must vouch it. Read the surfaced memory facts' committed
  // place name (payload.name) so a committed landmark is no longer a phantom.
  for (const f of scene.relevantMemoryFacts || []) {
    if (f && (f.type === "gm_lore" || (Array.isArray(f.tags) && f.tags.includes("lore")))) {
      add(f.payload?.name);
    }
  }
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
// RULER v2 — tightened diagnostic checks (one-time ruler change, then FROZEN)
// ===========================================================================
// The goal is NOT higher grades: a stricter, more diagnostic ruler whose
// findings are machine-actionable. Grades are EXPECTED to drop under v2 — that
// is success. Every check below ships with known-bad + known-good tests.
// v1 auditors above (auditProseAgainstState / auditInventedAgents) are frozen —
// the selfplay battery consumes them; v2 layers on top for the grader.

export const RULER_VERSION = "v2";
export const RULER_CHECKS = Object.freeze([
  "phantom-proper-nouns(#27/#41)",
  "unnamed-invented-agents(strict-colocated)",
  "narrated-state-drift(classC)",
  "pronoun-gender-enforcement",
  "introduction-beat",
  "name-collision(worldgen)",
  "band-desync(#28)",
  "clock-divergence(#14)",
  "conditions-without-shed(#26)",
  "recycled-loop",
  "narrate-into-void",
  "handles(pacing)",
  "paragraph-structure(raw-gm)",
  "latency",
  "model-integrity",
  "compliments(regression-guards)"
]);

// Aggregation across sessions must never mix rulers — a v1 A and a v2 B are not
// on the same scale. Throws on mixed input.
export function assertSameRulerVersion(versions = []) {
  const distinct = [...new Set(versions.filter(Boolean))];
  if (distinct.length > 1) {
    throw new Error(`ruler-version mix: refusing to aggregate ${distinct.join(" + ")} — regrade on one ruler`);
  }
  return distinct[0] || null;
}

// ---- 2a. UNNAMED INVENTED AGENTS (strict, co-located) ---------------------
// The v1 agent check vouches a noun by token-matching the WHOLE known-name pool
// (locations, POIs, away NPCs) and waves through person-generics whenever any
// cast exists. v2 rule: an ACTING agent noun is vouched only by a CO-LOCATED
// committed cast member whose name/role/tag matches the noun; pure person
// generics ("figure", "someone") are vouched by any co-located cast member.
const V2_ROLE_NOUNS = [
  "guard", "merchant", "medic", "barkeep", "courier", "marshal", "broker",
  "warden", "soldier", "sentry", "watcher", "thief", "hunter", "raider",
  "bandit", "assailant", "attacker", "rider", "priest", "farmer", "smith",
  "trader", "scout", "officer", "stranger", "traveler", "woman", "man",
  "boy", "girl", "elder", "child", "drone", "scavenger", "creature",
  "beast", "wolf", "hound", "figure", "voice", "someone", "somebody"
];
const V2_PERSON_GENERICS = new Set(["figure", "voice", "someone", "somebody", "stranger"]);
// v1 verb list plus the quiet social verbs it missed (scowls, frowns, gestures…).
const V2_AGENCY_VERB_RE = new RegExp(
  AGENCY_VERB_RE.source.slice(0, -3) +
    "|scowls?|scowled|frowns?|frowned|gestures?|gestured|leans?|leaned|eyes|eyed|studies|studied|" +
    "shrugs?|shrugged|sighs?|sighed|laughs?|laughed|points?|pointed|raises|raised|offers?|offered|" +
    "hands?|handed|slides?|pushes|pushed|pulls?|pulled|sits?|sat|stands?|stood|rises|rose)\\b",
  "i"
);

function colocatedCast(scene = {}) {
  return (Array.isArray(scene.cast) ? scene.cast : []).filter((m) => m && m.present !== false);
}

export function auditUnnamedAgents(prose, scene = {}) {
  const text = String(prose || "");
  const cast = colocatedCast(scene);
  const castTokens = new Set();
  for (const m of cast) {
    for (const src of [m.displayName, m.role, ...(Array.isArray(m.tags) ? m.tags : [])]) {
      for (const t of String(src || "").toLowerCase().split(/[\s-]+/)) {
        const clean = t.replace(/[^a-z']/g, "");
        if (clean.length >= 3) castTokens.add(clean);
      }
    }
  }
  const flags = [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  for (const sentence of sentences) {
    // strip player-possessives ("your hand closes…") like v1
    const lower = sentence.toLowerCase().replace(/\b(?:your|my)\s+(?:own\s+)?\w+/g, " ");
    for (const noun of V2_ROLE_NOUNS) {
      const nounRe = new RegExp(`\\b(?:a|an|the|some|another)\\s+(?:\\w+\\s+){0,2}${noun}s?\\b`, "i");
      if (!nounRe.test(lower)) continue;
      const negatedRe = new RegExp(`\\b(?:no|not a|nor a|neither|without a|no other)\\s+(?:\\w+\\s+)?${noun}s?\\b`, "i");
      if (negatedRe.test(lower)) continue;
      if (!V2_AGENCY_VERB_RE.test(sentence)) continue;
      const vouched = V2_PERSON_GENERICS.has(noun) ? cast.length > 0 : castTokens.has(noun);
      if (!vouched) {
        flags.push({ noun, sentence: sentence.trim().slice(0, 180) });
        break;
      }
    }
  }
  return flags;
}

// ---- 2b. CLASS C — NARRATED-BUT-UNCOMMITTED STATE (detail drift) -----------
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function parseCount(word) {
  const n = Number(word);
  if (Number.isFinite(n)) return n;
  return NUMBER_WORDS[String(word).toLowerCase()] ?? null;
}
const DRIFT_CONDITION_WORDS = [
  "poisoned", "bleeding", "exhausted", "grappled", "stunned", "burning",
  "frozen", "blinded", "cursed", "diseased", "paralyzed", "prone"
];
const WOUND_ASSERT_RE = /\byou(?:'re| are)\s+(?:badly|gravely|severely)\s+(?:wounded|hurt|injured)|\bbleeding out\b|\bnear(?:ly)? death\b|\bbarely alive\b|\bhalf(?: of)? your (?:health|strength|life)\b/i;

export function detectNarratedStateDrift(prose, scene = {}) {
  const text = String(prose || "");
  const lower = text.toLowerCase();
  const drifts = [];

  // Conditions asserted about the player that committed state does not hold.
  const committedConditions = (scene.conditions || scene.player?.conditions || scene.player?.status?.conditions || [])
    .map((c) => String(c?.name || c?.id || c || "").toLowerCase());
  for (const cond of DRIFT_CONDITION_WORDS) {
    const assertRe = new RegExp(`\\byou(?:'re| are| feel)\\s+(?:\\w+\\s+)?${cond}\\b`, "i");
    if (assertRe.test(text) && !committedConditions.some((c) => c.includes(cond.replace(/ed$/, "")) || cond.includes(c))) {
      drifts.push({ kind: "condition", detail: `narrated "you are ${cond}" but committed conditions = [${committedConditions.join(", ") || "none"}]` });
    }
  }

  // Wound/HP severity asserted while committed HP is full.
  const hp = scene.player?.resources?.hp || scene.player?.resources?.hitPoints || scene.player?.hitPoints || null;
  const hpCurrent = hp?.current ?? hp?.value ?? null;
  const hpMax = hp?.max ?? null;
  if (WOUND_ASSERT_RE.test(text) && hpCurrent != null && hpMax != null && hpCurrent >= hpMax) {
    drifts.push({ kind: "hp", detail: `narrated grave wounds but committed HP is full (${hpCurrent}/${hpMax})` });
  }

  // Enemy/agent counts above committed co-located cast.
  const cast = colocatedCast(scene);
  for (const m of lower.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(guards?|raiders?|bandits?|soldiers?|men|women|figures?|wolves|hunters?|riders?|attackers?)\b/g)) {
    const n = parseCount(m[1]);
    if (n != null && n >= 2 && n > cast.length) {
      drifts.push({ kind: "agent_count", detail: `narrated "${m[1]} ${m[2]}" but committed co-located cast = ${cast.length}` });
    }
  }

  // Item counts that contradict committed inventory quantities.
  const inventory = scene.playerInventory || scene.player?.inventory || [];
  for (const item of inventory) {
    const name = String(item?.name || "").toLowerCase().trim();
    const qty = item?.quantity ?? item?.qty ?? null;
    if (!name || qty == null) continue;
    const token = name.split(/\s+/).pop(); // "field ration" → "ration(s)"
    if (token.length < 4) continue;
    const re = new RegExp(`\\b(one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(?:\\w+\\s+)?${token}s?\\b`, "i");
    const m = text.match(re);
    if (m) {
      const n = parseCount(m[1]);
      if (n != null && n !== qty) {
        drifts.push({ kind: "item_count", detail: `narrated "${m[0].trim()}" but committed ${name} quantity = ${qty}` });
      }
    }
  }
  return drifts;
}

// ---- 2c. GENDER / PRONOUN ENFORCEMENT --------------------------------------
// Narrated pronouns vs committed gender for ALL committed NPCs (not only
// #50-backfilled ones). Window: from a committed name's mention until the next
// committed name. Conservative: flags only >=2 contradicting pronouns with 0
// agreeing in the window. `focusName` anchors prose that never names its
// subject (a VN beat where the speaker is implied).
function pronounGenderOf(entity = {}) {
  const p = String(entity.pronouns || "").toLowerCase();
  const g = String(entity.gender || "").toLowerCase();
  if (/she|her/.test(p) || /female|woman/.test(g)) return "female";
  if (/\bhe\b|him/.test(p) || /^male$|\bman\b/.test(g)) return "male";
  return null;
}
const FEMALE_PRONOUN_RE = /\b(she|her|hers|herself)\b/gi;
const MALE_PRONOUN_RE = /\b(he|him|his|himself)\b/gi;

export function detectPronounMismatch(prose, entities = [], { focusName = null } = {}) {
  const text = String(prose || "");
  const known = entities
    .map((e) => ({ name: String(e.displayName || e.name || "").trim(), expected: pronounGenderOf(e) }))
    .filter((e) => e.name && e.expected);
  if (!known.length || !text) return [];

  const sentences = text.split(/(?<=[.!?])\s+/);
  // Assign each sentence to the last-named committed entity (the active subject).
  let active = null;
  const windows = new Map(); // name -> concatenated window text
  const anyNameMentioned = known.some((k) => new RegExp(`\\b${k.name.split(/\s+/)[0]}\\b`, "i").test(text));
  if (!anyNameMentioned && focusName) {
    const focus = known.find((k) => k.name.toLowerCase() === String(focusName).toLowerCase().trim());
    if (focus) windows.set(focus.name, text);
  } else {
    for (const s of sentences) {
      for (const k of known) {
        if (new RegExp(`\\b${k.name.split(/\s+/)[0]}\\b`, "i").test(s)) active = k.name;
      }
      if (active) windows.set(active, `${windows.get(active) || ""} ${s}`);
    }
  }

  const flags = [];
  for (const [name, windowText] of windows) {
    const expected = known.find((k) => k.name === name)?.expected;
    if (!expected) continue;
    const fem = (windowText.match(FEMALE_PRONOUN_RE) || []).length;
    const masc = (windowText.match(MALE_PRONOUN_RE) || []).length;
    if (expected === "male" && fem >= 2 && masc === 0) {
      flags.push({ name, expected: "he/him", observed: `"she/her" ×${fem}`, count: fem });
    } else if (expected === "female" && masc >= 2 && fem === 0) {
      flags.push({ name, expected: "she/her", observed: `"he/him" ×${masc}`, count: masc });
    }
  }
  return flags;
}

// ---- 2d. INTRODUCTION-BEAT CHECK (run-level) --------------------------------
// A committed NPC's first surfacing must be, or be preceded by, an introduction
// beat (the courier arrival-event pattern). A procedural pre-seed whose only
// surfacing evidence is talk (revealed beats / talk facts) with NO non-talk
// timeline event mentioning its name or role has surfaced cold → flag.
export function auditIntroductionBeats(run = {}) {
  const npcs = Object.values(run.npcs || {});
  const timeline = Array.isArray(run.timeline) ? run.timeline : [];
  const flags = [];
  for (const npc of npcs) {
    const origin = String(npc.origin || npc.committedBy || "").toLowerCase();
    if (origin !== "procedural") continue; // runtime commits are introduced by their own narration
    const interacted =
      (Array.isArray(npc.memoryFactIds) && npc.memoryFactIds.length > 0) ||
      (Array.isArray(npc.dialogueBeats) && npc.dialogueBeats.some((b) => b?.revealed));
    if (!interacted) continue; // never surfaced — nothing to judge yet
    const nameToken = String(npc.displayName || "").split(/\s+/)[0].toLowerCase();
    const roleToken = String(npc.role || "").toLowerCase();
    // Introduction evidence must be a WORLD-side event (momentum arrival, quest
    // beat, commit event). A PLAYER-action echo (talk / attempt / search / move /
    // rest / use_item) mentioning the name is NOT an introduction — the live miss
    // was a player attempt saying "the message i got from mara" false-vouching
    // the medic (and it referred to the OTHER Mara — the conflation itself).
    const PLAYER_ACTION_TYPES = new Set(["talk", "attempt", "search", "move", "movement", "rest", "use_item", "ooc", "run_created"]);
    const introduced = timeline.some((ev) => {
      if (!ev || typeof ev !== "object") return false;
      const type = String(ev.type || "").toLowerCase();
      if (PLAYER_ACTION_TYPES.has(type) || type.startsWith("talk")) return false;
      const blob = `${ev.title || ""} ${ev.summary || ""}`.toLowerCase();
      return (nameToken && blob.includes(nameToken)) || (roleToken && blob.includes(roleToken));
    });
    if (!introduced) {
      flags.push({
        npcId: npc.npcId,
        name: npc.displayName,
        role: npc.role,
        detail: `committed-but-never-introduced: pre-seeded "${npc.displayName}" (${npc.role}) surfaced cold in a talk beat with no introduction event`
      });
    }
  }
  return flags;
}

// ---- 2e. NAME-COLLISION DETECTION (run-level, worldgen severity) ------------
export function detectNameCollisions(npcs = {}) {
  const groups = new Map();
  for (const npc of Object.values(npcs || {})) {
    const first = String(npc?.displayName || "").trim().split(/\s+/)[0].toLowerCase();
    if (!first) continue;
    if (!groups.has(first)) groups.set(first, []);
    groups.get(first).push(npc);
  }
  const collisions = [];
  for (const [name, members] of groups) {
    if (members.length > 1) {
      collisions.push({
        name,
        npcIds: members.map((m) => m.npcId),
        roles: members.map((m) => m.role),
        detail: `${members.length} committed NPCs share the name "${members[0].displayName.split(/\s+/)[0]}": ${members.map((m) => `${m.npcId}(${m.role})`).join(" + ")}`
      });
    }
  }
  return collisions;
}

// ---- 3a. HANDLES (pacing/agency) --------------------------------------------
// Does the narration turn end with actionable, state-grounded directions?
// Hooks counted over the FINAL paragraph: a direct question, an explicit option
// construction, an exit/direction affordance, or a named co-located cast member.
// >=2 hooks → handles present (compliment); 0 → complaint; 1 → borderline, no
// finding. Suggestions referencing uncommitted entities are caught by the
// phantom check as usual.
export function detectHandles(narration, scene = {}) {
  const text = String(narration || "").trim();
  if (!text) return { hooks: 0, verdict: "missing" };
  const paras = text.split(/\n{2,}/);
  const tail = paras[paras.length - 1] || text;
  const tailAndPrev = paras.length > 1 ? `${paras[paras.length - 2]} ${tail}` : tail;
  let hooks = 0;
  if (/\?\s*["”']?\s*$/.test(text) || /\?/.test(tail)) hooks += 1;
  if (/\byou (?:could|can|might)\b|\beither\b|\bor you\b|\bchoice\b|\bdecide\b/i.test(tailAndPrev)) hooks += 1;
  if (/\b(?:door|path|road|street|stairs|corridor|exit|gate|trail|north|south|east|west)\b/i.test(tail)) hooks += 1;
  for (const m of colocatedCast(scene)) {
    const first = String(m.displayName || "").split(/\s+/)[0];
    if (first && new RegExp(`\\b${first}\\b`, "i").test(tail)) { hooks += 1; break; }
  }
  return { hooks, verdict: hooks >= 2 ? "present" : hooks === 0 ? "missing" : "borderline" };
}

// ---- 3b. PARAGRAPH STRUCTURE (raw GM output, pre-chunker) --------------------
export function detectSingleBlockProse(narration, { threshold = 500 } = {}) {
  const text = String(narration || "");
  if (text.length <= threshold) return null;
  if (/\n\s*\n/.test(text)) return null;
  return { chars: text.length, detail: `${text.length} chars with no paragraph break — single-block prose only the client chunker saves` };
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
  const finding = f.finding || f.failure;
  findings.push({
    axis: f.axis,
    severity: f.severity,
    turns: Array.isArray(f.turns) ? f.turns : f.turns != null ? [f.turns] : [],
    // Ruler v2 schema: polarity distinguishes complaints (deduct) from
    // compliments (regression guards — logged, never scored). `finding` is the
    // canonical text; `failure` kept as a back-compat alias (same string).
    polarity: f.polarity === "compliment" ? "compliment" : "complaint",
    finding,
    failure: finding,
    rootCause: f.rootCause,
    fixTarget: f.fixTarget
  });
}

// Compliments carry NO score weight (deductions are computed over complaints
// only) — their job is to make strengths measurable so the fix phase can't
// regress them unnoticed. severity is always "low" for stable sort order.
function pushCompliment(findings, f) {
  pushFinding(findings, { ...f, severity: "low", polarity: "compliment" });
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
    // v1 invented-agent auditor keeps ownership of dialogue + state-tag kinds;
    // the strict v2 co-located check below owns the agent kind (no double-flag).
    const inv = auditInventedAgents(t.narration, scene);
    for (const iv of inv.inventions.filter((x) => x.kind !== "agent")) {
      pushFinding(findings, {
        axis: iv.kind === "state_tag" ? "narration" : "coherence", severity: "high", turns: t.n,
        failure: `T${t.n}: invented ${iv.kind} "${iv.detail}" with no committed backing ("${iv.sentence}")`,
        rootCause: iv.kind === "state_tag"
          ? "pseudo-state tag leaked into prose (interpreter output not stripped)"
          : "GM narrated an actor/speaker with no committed entity (B2 uncommitted social/agency)",
        fixTarget: iv.kind === "state_tag"
          ? "server/gm/actionNarration.js voice/strip pass"
          : "server/solo/npcCommit.js commit-or-strip + GM-prompt actor discipline"
      });
    }
    // RULER v2 2a: unnamed invented agents, strict co-located vouching.
    for (const agent of auditUnnamedAgents(t.narration, scene)) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: t.n,
        failure: `T${t.n}: unnamed invented agent "a/the ${agent.noun}" acting with no co-located committed entity ("${agent.sentence}")`,
        rootCause: "GM gave agency to an uncommitted generic actor (B2 class) — v1 vouching let non-co-located tokens cover it",
        fixTarget: "server/solo/npcCommit.js auditAndCommitInventedAgents co-location + GM-prompt actor discipline"
      });
    }
    // RULER v2 2b: Class C narrated-but-uncommitted state (detail drift).
    for (const d of detectNarratedStateDrift(t.narration, scene)) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: t.n,
        failure: `T${t.n}: narrated-state drift (${d.kind}) — ${d.detail}`,
        rootCause: "narration asserts player/world state the committed state does not hold (Class C detail drift — the coherence failure players notice most)",
        fixTarget: "GM-prompt state-echo discipline + server-side narration state check"
      });
    }
    // RULER v2 2c: pronoun/gender enforcement for ALL committed NPCs.
    const focusName = (() => {
      const sid = scene.vn?.speakerId || scene.speakerId || null;
      if (!sid) return null;
      const m = (scene.cast || []).find((c) => c && (c.npcId === sid || c.entityId === `npc:${sid}`));
      return m ? m.displayName : null;
    })();
    for (const p of detectPronounMismatch(t.narration, scene.cast || [], { focusName })) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: t.n,
        failure: `T${t.n}: pronoun mismatch — "${p.name}" committed ${p.expected} but narrated ${p.observed}`,
        rootCause: "narration genders a committed NPC against their committed gender/pronouns (#50 class, all NPCs)",
        fixTarget: "GM-prompt committed-gender echo + server/solo/npcCommit.js gender enforcement"
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
    // RULER v2 3b: paragraph structure measured on the RAW GM output (the client
    // chunker rescuing a wall is not the GM writing structured beats).
    const block = detectSingleBlockProse(t.narration);
    if (block) {
      pushFinding(findings, {
        axis: "narration", severity: "medium", turns: t.n,
        failure: `T${t.n}: single-block prose — ${block.detail}`,
        rootCause: "GM emits monolithic prose instead of structured multi-paragraph beats; the client chunker masks it",
        fixTarget: "GM-prompt paragraph-structure clause (raw output, pre-chunker)"
      });
    } else if (/\n\s*\n/.test(String(t.narration || "")) && String(t.narration || "").length > 300) {
      pushCompliment(findings, {
        axis: "narration", turns: t.n,
        finding: `T${t.n}: native multi-paragraph beat structure (raw GM output, no chunker rescue needed)`,
        rootCause: "GM emitted structured paragraphs on its own",
        fixTarget: "KEEP — regression guard: paragraph structure must survive prompt changes"
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
    // A committed SOCIAL disposition change (B2) is a real delta the snapshot
    // (loc/discovery/inv/quest/xp/cast) does not carry — a persuade/charm success
    // that moved a relationship meter is NOT narrate-into-void.
    const committedDisposition = ar.dispositionChange && (ar.dispositionChange.delta || ar.dispositionChange.suspicionDelta);
    if (freshAttempt && succeeded && !committedDisposition && t.sceneBefore && t.sceneAfter) {
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

  // ---- RULER v2 3a: HANDLES (pacing/agency) — does each real turn end with
  // actionable, state-grounded directions? ----
  for (const t of realTurns) {
    const handles = detectHandles(t.narration, t.scene || {});
    if (handles.verdict === "missing") {
      pushFinding(findings, {
        axis: "pacing", severity: "medium", turns: t.n,
        failure: `T${t.n}: no handles — narration ends with zero actionable, state-grounded directions`,
        rootCause: "the turn gives the player nothing to push on (no question, option, exit, or present NPC in the closing beat)",
        fixTarget: "GM-prompt closing-handles clause (2-4 grounded directions per turn)"
      });
    } else if (handles.verdict === "present") {
      pushCompliment(findings, {
        axis: "pacing", turns: t.n,
        finding: `T${t.n}: handles present — ${handles.hooks} actionable direction hook(s) in the closing beat`,
        rootCause: "turn ends with grounded directions the player can act on",
        fixTarget: "KEEP — regression guard: closing handles must survive prompt changes"
      });
    }
  }

  // ---- RULER v2 compliments (regression guards; zero score weight) ----
  for (const t of realTurns) {
    const scene = t.scene || {};
    const ar = t.attemptResult || {};
    // Clean band: a rolled turn whose band/label/math all agree.
    if (ar.checkResult && !detectBandDesync(ar)) {
      pushCompliment(findings, {
        axis: "mechanical", turns: t.n,
        finding: `T${t.n}: clean band/label — roll ${ar.checkResult.total} vs DC ${ar.checkResult.dc} reads as "${ar.outcomeLabel || ar.band}"`,
        rootCause: "band derivation and label agree with the rolled math",
        fixTarget: "KEEP — regression guard: #28 band integrity"
      });
    }
    // Possession-gate refusal correctly held.
    const refused = ar.refused === true || ar.possession === "refused" ||
      /refus/i.test(String(ar.outcomeLabel || "")) ||
      (Array.isArray(ar.warningCodes) && ar.warningCodes.some((w) => /POSSESS|REFUS/i.test(w)));
    if (refused) {
      pushCompliment(findings, {
        axis: "mechanical", turns: t.n,
        finding: `T${t.n}: possession gate held — refused a claimed item the player does not hold`,
        rootCause: "the possession gate refused an ungrounded item claim instead of minting it",
        fixTarget: "KEEP — regression guard: possession-gate refusals"
      });
    }
    // Grounded narration: no phantoms, no invented agents, and it names committed state.
    const phantomFree = auditProseAgainstState(t.narration, scene).phantoms.length === 0;
    const agentFree = auditUnnamedAgents(t.narration, scene).length === 0;
    const namesCommitted = [...(scene.cast || []).map((c) => c.displayName), scene.location?.name]
      .filter(Boolean)
      .some((n) => new RegExp(`\\b${String(n).split(/\s+/)[0]}\\b`, "i").test(String(t.narration || "")));
    if (phantomFree && agentFree && namesCommitted) {
      pushCompliment(findings, {
        axis: "coherence", turns: t.n,
        finding: `T${t.n}: grounded narration — every named actor/place is committed state`,
        rootCause: "narration stayed inside the committed world",
        fixTarget: "KEEP — regression guard: grounded-narration rate"
      });
    }
    // Grounded callback: narration references a committed discovery/memory fact.
    const callbacks = [
      ...(scene.discoveredDetails || []).map((d) => d.label),
      ...(scene.relevantMemoryFacts || []).map((f) => f?.payload?.name).filter(Boolean)
    ].filter((label) => label && String(label).length >= 4);
    const calledBack = callbacks.find((label) => new RegExp(`\\b${String(label).split(/\s+/)[0]}\\b`, "i").test(String(t.narration || "")));
    if (calledBack) {
      pushCompliment(findings, {
        axis: "depth", turns: t.n,
        finding: `T${t.n}: grounded callback — narration references committed fact "${calledBack}"`,
        rootCause: "the world remembered its own committed state",
        fixTarget: "KEEP — regression guard: memory callbacks"
      });
    }
  }

  // ---- RULER v2 run-level checks (2d introduction beats, 2e name collisions).
  // Supplied via opts.run (the committed run record); skipped when absent. ----
  const run = opts.run || null;
  if (run && run.npcs) {
    for (const c of detectNameCollisions(run.npcs)) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: [],
        failure: `name collision — ${c.detail}`,
        rootCause: "worldgen/namegen minted two committed NPCs with the same first name in one run (players conflate them)",
        fixTarget: "server worldgen/identity namegen: per-run first-name dedup"
      });
    }
    for (const f of auditIntroductionBeats(run)) {
      pushFinding(findings, {
        axis: "coherence", severity: "high", turns: [],
        failure: f.detail,
        rootCause: "pre-seeded NPC reached dialogue with no introduction beat (the courier arrival-event pattern is the known-good)",
        fixTarget: "server/solo/scene.js first-surfacing introduction event + GM-prompt introduce-on-first-appearance clause"
      });
    }
  }

  // ---- Axis scores: deductions from COMPLAINTS only (compliments carry no
  // weight — a check that raised a grade would be a ruler defect). ----
  const axisNumeric = (axis, gradeableTurns) => {
    if (gradeableTurns === 0) return null;
    const deduction = findings
      .filter((f) => f.axis === axis && f.polarity !== "compliment")
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

  // Rank findings: complaints first (severity, then turn breadth), compliments
  // after (by turn) — the report renders both, only complaints deduct.
  const POLARITY_RANK = { complaint: 0, compliment: 1 };
  findings.sort(
    (a, b) =>
      (POLARITY_RANK[a.polarity] - POLARITY_RANK[b.polarity]) ||
      (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
      (b.turns.length - a.turns.length)
  );

  return {
    axes,
    findings,
    integrity,
    // Ruler stamp: aggregates must refuse to mix versions (assertSameRulerVersion).
    ruler: { version: RULER_VERSION, checks: RULER_CHECKS },
    meta: opts.meta || {}
  };
}

// Render a graded session to the machine-actionable markdown report written to
// docs/grades/auto-grade-<timestamp>.md.
export function renderGradeReport(graded, meta = {}) {
  const { axes, findings, integrity } = graded;
  const ruler = graded.ruler || { version: "v1", checks: [] };
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
  lines.push(`> **ruler=${ruler.version}** — checks: ${ruler.checks.join(", ") || "(v1 baseline)"}. Do NOT aggregate across ruler versions.`);
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
  const complaints = findings.filter((f) => f.polarity !== "compliment");
  const compliments = findings.filter((f) => f.polarity === "compliment");
  lines.push(`## Machine-actionable findings (${complaints.length} complaints, ranked by severity)`);
  lines.push("");
  if (complaints.length === 0) {
    lines.push("_No deductions — clean session._");
  }
  complaints.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${sevBadge[f.severity] || f.severity} · ${f.axis} · T${f.turns.join("/") || "—"}`);
    lines.push("");
    lines.push(`- **Observed:** ${f.finding || f.failure}`);
    lines.push(`- **Root-cause hypothesis:** ${f.rootCause}`);
    lines.push(`- **Fix-target:** \`${f.fixTarget}\``);
    lines.push("");
  });
  lines.push(`## What worked (${compliments.length} compliments — regression guards, zero score weight)`);
  lines.push("");
  if (compliments.length === 0) {
    lines.push("_No compliments logged._");
  }
  compliments.forEach((f, i) => {
    lines.push(`${i + 1}. ✅ **${f.axis} · T${f.turns.join("/") || "—"}** — ${f.finding || f.failure} _(keep: ${f.fixTarget})_`);
  });
  lines.push("");
  return lines.join("\n");
}
