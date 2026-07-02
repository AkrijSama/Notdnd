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
