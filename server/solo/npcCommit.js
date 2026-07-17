// ---------------------------------------------------------------------------
// COMMITTED NPC ENTITIES + PHANTOM DETECTION (#27) — the coherence moat, NPC side.
//
// The hole this closes: the GM narrates a named character into existence (Grace,
// Doc Han, the pursuers) but they never become a committed run.npcs record, so
// they are PHANTOMS — nothing persists their location/status/relationship, and
// the next turn the model can silently contradict them. "0 NPC entities in play"
// is that hole.
//
// Two pieces:
//   1. commitNarratedNpc — promote a GM-introduced NPC into a REAL run.npcs
//      record (validated against the NPC schema), so it has durable state and
//      shows up as a visible entity, a talk/inspect target, and a memory anchor.
//   2. detectPhantomNpcNames — a pure detector the auditor (gmEval) and the live
//      narration path both use to flag proper-noun characters that SPEAK or ACT
//      in narration but are not backed by a committed/visible entity.
//
// Pure except commitNarratedNpc's run mutation; no I/O, no Date.now (ids use
// crypto; callers may pass an idFactory for determinism in tests).
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { validateNpc } from "./schema.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// Promote a GM-introduced NPC into a committed run.npcs record. `spec` carries what
// the narration established: { displayName (required), role, locationId, known,
// status, origin, appearance, personality, introInstructions, tags }. Idempotent by
// display-name slug (a second mention of "Grace" returns the same record, never a
// duplicate cast member). Returns the committed record, the existing one on a
// re-mention, or null on invalid input / schema rejection (fails closed — a record
// that would not validate is never written, so the cast stays coherent).
export function commitNarratedNpc(run, spec, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(spec) || !isString(spec.displayName)) {
    return null;
  }
  if (!isPlainObject(run.npcs)) {
    run.npcs = {};
  }
  const displayName = spec.displayName.trim();
  const nameSlug = slugify(displayName);
  const firstNameLc = displayName.split(/\s+/)[0].toLowerCase();
  // Dedupe-BIND (the two-Sables bug): same explicit id, same slug or
  // case-insensitive name on EITHER displayName or generatedName, or a matching
  // FIRST name (>=3 chars — identity-minted "Sable" vs narrated "Sable" 30s
  // later). Mint-time uniqueness (npcIdentity) keeps first names unique per run,
  // so a first-name match here means the same character — bind, never re-mint.
  const nameMatches = (name) => {
    if (!isString(name)) return false;
    const trimmed = name.trim();
    return (
      slugify(trimmed) === nameSlug ||
      trimmed.toLowerCase() === displayName.toLowerCase() ||
      (firstNameLc.length >= 3 && trimmed.split(/\s+/)[0].toLowerCase() === firstNameLc)
    );
  };
  const existing = Object.values(run.npcs).find((npc) =>
    isPlainObject(npc) && (
      (isString(spec.npcId) && npc.npcId === spec.npcId) ||
      nameMatches(npc.displayName) ||
      nameMatches(npc.generatedName)
    )
  );
  if (existing) {
    // Refresh a couple of soft fields on re-introduction, but keep identity stable.
    if (isString(spec.locationId)) {
      existing.currentLocationId = spec.locationId;
    }
    return existing;
  }
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : shortId;
  const npcId = isString(spec.npcId) ? spec.npcId : `npc_${nameSlug || "figure"}_${idFactory()}`;
  const npc = {
    npcId,
    displayName,
    role: isString(spec.role) ? spec.role.trim() : "figure",
    currentLocationId: isString(spec.locationId) ? spec.locationId : (isString(run.currentLocationId) ? run.currentLocationId : null),
    known: spec.known !== false,
    status: isString(spec.status) ? spec.status : "alive",
    memoryFactIds: [],
    // Narrated NPCs are hybrid: the fiction (GM) named them, the server commits them.
    origin: "hybrid",
    tags: Array.isArray(spec.tags) ? spec.tags.filter(isString) : [],
    // Born introduced: the narration that minted them IS their introduction —
    // the first-appearance directive must not re-fire next turn.
    flags: { ...(isPlainObject(spec.flags) ? spec.flags : {}), introduced: true }
  };
  if (isString(spec.appearance)) npc.appearance = spec.appearance.trim();
  if (isString(spec.personality)) npc.personality = spec.personality.trim();
  if (isString(spec.introInstructions)) npc.introInstructions = spec.introInstructions.trim();
  // #50: committed gender + pronouns so the portrait matches the written character
  // (imageWorker.groundNpcPortrait consumes these). Inferred from narration on the
  // commit path; a re-mention keeps the first-committed value (identity stable).
  if (isString(spec.gender)) npc.gender = spec.gender.trim();
  if (isString(spec.pronouns)) npc.pronouns = spec.pronouns.trim();

  const validation = validateNpc(npc);
  if (!validation.ok) {
    return null;
  }
  run.npcs[npcId] = npc;
  return npc;
}

// Speech/action verbs that betray a PRESENT character. A capitalized name in front
// of one of these ("Grace nods", "Doc Han says") is a strong signal the narration
// is treating a proper-noun person as present — exactly what must be committed.
const NPC_ACTION_VERBS = [
  "says", "said", "asks", "asked", "replies", "replied", "answers", "answered",
  "nods", "nodded", "mutters", "muttered", "whispers", "whispered", "grins", "grinned",
  "growls", "growled", "shrugs", "shrugged", "snaps", "snapped", "calls", "called",
  "adds", "added", "continues", "explains", "explained", "laughs", "laughed",
  "sighs", "sighed", "gestures", "leans", "steps", "turns", "smiles", "smiled",
  "frowns", "frowned", "hisses", "barks", "warns", "warned", "offers", "offered"
];

// Words that are capitalized for reasons other than being a character name — do NOT
// flag these as phantom NPCs even when they precede an action verb.
const NAME_STOPLIST = new Set([
  "you", "your", "i", "we", "they", "he", "she", "it", "the", "a", "an", "this", "that",
  "there", "here", "then", "now", "one", "someone", "something", "everyone", "nobody",
  "your", "his", "her", "their", "its", "and", "but", "for", "with", "as", "at", "on",
  "north", "south", "east", "west", "up", "down", "inside", "outside"
]);

const NAME_RE = "([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)";
const ACTION_NAME_RE = new RegExp(`\\b${NAME_RE}\\s+(?:${NPC_ACTION_VERBS.join("|")})\\b`, "g");
const NAMED_RE = new RegExp(`\\bnamed\\s+${NAME_RE}`, "g");

// DIALOGUE SELF-INTRODUCTION (#27 extension — the live gap the S2 cascade exposed).
// A character often names itself INSIDE quoted speech rather than via a "X says"
// tag: "Name's Goran," he mutters / "Call me Vorga" / "The name is Goran". The
// action-verb detector never sees the name (it's the speech CONTENT), so the
// character stayed phantom. These high-signal intro phrases introduce a proper
// name; capture it. (`I'm X` / `I am X` are deliberately EXCLUDED — too noisy:
// "I'm Sorry/Fine/Cold" would false-commit.)
const SELF_INTRO_RE = new RegExp(`\\b(?:name['’]?s|name\\s+is|call\\s+me|they\\s+call\\s+me|you\\s+can\\s+call\\s+me|goes\\s+by|go\\s+by)\\s+${NAME_RE}`, "gi");

// POSSESSIVE-NAME-AS-PRESENT (#27 extension). "Goran's chair scrapes back",
// "Vorga's rag stills on the bar" — a proper-noun person acting through a
// possessive, which the action-verb detector misses (the verb attaches to the
// object, not the name). A capitalized name + "'s" + a lowercase word signals a
// present character. Guarded by POSSESSIVE_STOPLIST so place/object possessives
// ("the tavern's door", "the hearth's glow") are not mistaken for people.
const POSSESSIVE_RE = /\b([A-Z][a-z]+)['’]s\s+[a-z]/g;
const POSSESSIVE_STOPLIST = new Set([
  "tavern", "inn", "hearth", "door", "doorway", "room", "fire", "table", "bar", "counter",
  "window", "wall", "city", "town", "village", "keep", "tower", "watchtower", "gate", "hall",
  "market", "temple", "shrine", "road", "bridge", "sky", "sun", "moon", "night", "morning",
  "evening", "dusk", "dawn", "wind", "rain", "storm", "blade", "sword", "hand", "face", "eyes",
  "voice", "world", "air", "ground", "floor", "ceiling", "corner", "shadow", "light", "dark",
  "god", "gods", "kingdom", "empire", "guild", "order", "crown", "throne", "north", "south",
  "east", "west", "reach", "wastes", "district", "quarter", "square", "harbor", "docks"
]);

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

// #50: infer a committed NPC's gender + pronouns from how the narration refers to
// them, so the portrait prompt (imageWorker.groundNpcPortrait) matches the written
// character (the Mara-written-female-rendered-male bug). Scans a window AFTER the
// name for the first gendered pronoun, then the whole narration as a fallback when
// the name is the sole gendered subject. Returns { gender, pronouns } or null when
// the text gives no signal (portrait then falls back to its neutral default).
export function inferNpcGenderFromNarration(name, text) {
  const source = String(text || "");
  const clean = String(name || "").trim();
  if (!source.trim() || clean.length < 2) {
    return null;
  }
  const decide = (windowText) => {
    const w = String(windowText || "").toLowerCase();
    const female = (w.match(/\b(she|her|hers|herself)\b/g) || []).length;
    const male = (w.match(/\b(he|him|his|himself)\b/g) || []).length;
    const nb = (w.match(/\b(they|them|their|theirs|themself|themselves)\b/g) || []).length;
    if (female > male && female >= nb) return { gender: "female", pronouns: "she/her" };
    if (male > female && male >= nb) return { gender: "male", pronouns: "he/him" };
    if (nb > 0 && nb >= female && nb >= male) return { gender: "non-binary", pronouns: "they/them" };
    return null;
  };
  // First: the ~160-char window right after the FIRST mention of the name — the
  // pronoun that immediately follows the introduction is the strongest signal.
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${escaped}(?:['’]s)?\\b`, "i").exec(source);
  if (m) {
    const near = decide(source.slice(m.index, m.index + 160));
    if (near) return near;
  }
  // Fallback: the whole narration (works when the NPC is the only gendered subject).
  return decide(source);
}

// Place/landmark suffix words (kept in sync with PLACE_SUFFIX below). A proper
// noun whose LAST token is one of these ("Garrison", "the Iron Gate", "Dreadhold
// Keep") is a PLACE, not a person — the NPC detectors skip it so it routes to the
// lore-commit path instead of being mis-committed as a cast member.
const PLACE_SUFFIX_WORDS = new Set([
  "watchtower", "tower", "keep", "gate", "gates", "bridge", "road", "roads", "district",
  "market", "temple", "shrine", "hall", "halls", "square", "quarter", "wall", "walls",
  "citadel", "cathedral", "fortress", "mine", "mines", "docks", "harbor", "harbour",
  "sanctum", "vault", "crossing", "pass", "ridge", "hollow", "reach", "wastes", "fields",
  "woods", "forest", "inn", "tavern", "palace", "spire", "bastion", "well", "chapel",
  "monastery", "abbey", "barrow", "crypt", "tomb", "catacombs", "sept", "sanctuary",
  "garrison", "watch", "ward", "wards"
]);

function endsInPlaceSuffix(rawName) {
  const tokens = String(rawName || "").trim().toLowerCase().split(/\s+/);
  return tokens.length > 0 && PLACE_SUFFIX_WORDS.has(tokens[tokens.length - 1]);
}

// Pure. Scan narration text for proper-noun characters that SPEAK or ACT ("X says",
// "a woman named X") and return those NOT present in `knownNames` (committed/visible
// entity display names + the player's name). These are candidate PHANTOMS — narrated
// as present people with no committed record behind them. Best-effort heuristic (it
// FLAGS for the auditor / a commit prompt, it does not gate), tuned to avoid firing
// on pronouns, sentence-initial words, and already-committed names.
export function detectPhantomNpcNames(text, knownNames = []) {
  const source = String(text || "");
  if (!source.trim()) {
    return [];
  }
  const known = new Set();
  for (const name of knownNames) {
    if (isString(name)) {
      known.add(normalizeName(name));
      // also index first-name tokens so "Grace" matches a committed "Grace Whitfield"
      String(name).trim().split(/\s+/).forEach((tok) => known.add(normalizeName(tok)));
    }
  }
  const found = new Map(); // normalized -> display
  const collect = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      const raw = m[1].trim();
      const norm = normalizeName(raw);
      const firstTok = normalizeName(raw.split(/\s+/)[0]);
      if (NAME_STOPLIST.has(norm) || NAME_STOPLIST.has(firstTok)) continue;
      if (endsInPlaceSuffix(raw)) continue; // a landmark, not a person — routes to lore
      if (known.has(norm) || known.has(firstTok)) continue;
      if (!found.has(norm)) found.set(norm, raw);
    }
  };
  collect(ACTION_NAME_RE);
  collect(NAMED_RE);
  collect(SELF_INTRO_RE);
  // Possessive collector: same known/stoplist guards PLUS the place/object guard,
  // so "Goran's chair" flags Goran but "the tavern's door" flags nothing.
  POSSESSIVE_RE.lastIndex = 0;
  let pm;
  while ((pm = POSSESSIVE_RE.exec(source)) !== null) {
    const raw = pm[1].trim();
    const norm = normalizeName(raw);
    if (NAME_STOPLIST.has(norm) || POSSESSIVE_STOPLIST.has(norm)) continue;
    if (endsInPlaceSuffix(raw)) continue; // "Garrison's gate" → place, routes to lore
    if (known.has(norm)) continue;
    if (!found.has(norm)) found.set(norm, raw);
  }
  return [...found.values()];
}

// LIVE moat-closer (#27). After the GM narrates, promote every phantom character it
// asserted (a proper-noun person who spoke/acted with no committed record) into a
// real run.npcs entity, placed in the current location. Returns the names committed
// so the caller can log/surface them. Best-effort and non-fatal: a name that fails
// to validate is simply skipped. `knownNames` is the committed/visible set + player.
export function auditAndCommitNarratedNpcs(run, narrationText, knownNames = [], options = {}) {
  // Fold the run's already-committed NPCs into the known set so a character named
  // last turn is never re-detected as a phantom (defense in depth, independent of
  // what the caller passed).
  const committedNames = isPlainObject(run?.npcs)
    ? Object.values(run.npcs).map((npc) => (isPlainObject(npc) ? npc.displayName : null)).filter(Boolean)
    : [];
  const phantoms = detectPhantomNpcNames(narrationText, [...knownNames, ...committedNames]);
  const before = isPlainObject(run?.npcs) ? new Set(Object.keys(run.npcs)) : new Set();
  const committed = [];
  for (const displayName of phantoms) {
    // #50: infer gender/pronouns from how THIS narration referred to the character,
    // so the committed entity carries it and the portrait matches the text.
    const g = inferNpcGenderFromNarration(displayName, narrationText);
    const npc = commitNarratedNpc(run, { displayName, role: "figure", ...(g || {}) }, options);
    // Only count NPCs that were NEWLY created — commitNarratedNpc returns the
    // existing record on a re-mention, which must not read as a fresh commit.
    if (npc && !before.has(npc.npcId)) {
      committed.push(npc.displayName);
    }
  }
  return committed;
}

// #50: backfill gender/pronouns onto ALREADY-committed NPCs that carry none, from
// how the live narration refers to them. A starting NPC (identity-minted, often
// gender-neutral role) or any legacy cast member picks up the gender the TEXT uses
// the first time the narration genders them — closing the write-female/render-male
// mismatch for NPCs the commit/identity paths left ungendered. Returns names updated.
export function backfillNpcGenderFromNarration(run, narrationText) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  const updated = [];
  for (const npc of Object.values(run.npcs)) {
    if (!isPlainObject(npc)) continue;
    if (isString(npc.gender) && npc.gender.trim()) continue; // already grounded
    const name = isString(npc.generatedName) && npc.generatedName.trim() ? npc.generatedName : npc.displayName;
    if (!isString(name) || name.trim().length < 2) continue;
    const g = inferNpcGenderFromNarration(name, narrationText);
    if (g) {
      npc.gender = g.gender;
      if (!(isString(npc.pronouns) && npc.pronouns.trim())) npc.pronouns = g.pronouns;
      updated.push(name.trim());
    }
  }
  return updated;
}

// PRONOUN ENFORCEMENT AT NARRATION (baseline: he/him Mara narrated she ×5).
// Same enforcement class as phantom rejection: the committed gender/pronouns are
// server truth; narration contradicting them is detected and REPAIRED, not
// trusted. Conservative surgery — only sentences that mention the NPC's name
// (plus an immediately-following sentence that opens with the wrong pronoun)
// are touched, and only when the narration's own usage measurably contradicts
// the committed gender (inferNpcGenderFromNarration disagrees).
const PRONOUN_SWAPS = {
  female: [
    [/\bhe\b/g, "she"], [/\bHe\b/g, "She"],
    [/\bhimself\b/g, "herself"], [/\bHimself\b/g, "Herself"],
    [/\bhim\b/g, "her"], [/\bHim\b/g, "Her"],
    [/\bhis\b/g, "her"], [/\bHis\b/g, "Her"]
  ],
  male: [
    [/\bshe\b/g, "he"], [/\bShe\b/g, "He"],
    [/\bherself\b/g, "himself"], [/\bHerself\b/g, "Himself"],
    [/\bhers\b/g, "his"], [/\bHers\b/g, "His"],
    // "her" is object OR possessive: possessive when a word follows directly.
    [/\bher\b(?=\s+[a-z])/g, "his"], [/\bHer\b(?=\s+[a-z])/g, "His"],
    [/\bher\b/g, "him"], [/\bHer\b/g, "Him"]
  ]
};

/**
 * Pure. Detects and repairs narration pronouns that contradict a committed NPC's
 * gender. Returns { text, repairs: [{ name, committed }] } — text unchanged and
 * repairs empty when nothing contradicts. Non-binary commitments are detected
 * but NOT text-repaired (verb agreement can't be patched safely); they surface
 * in repairs with `unrepairable: true` so the caller can log them.
 */
export function repairNarrationPronouns(narrationText, npcs = []) {
  let text = String(narrationText || "");
  const repairs = [];
  if (!text.trim()) {
    return { text, repairs };
  }
  for (const npc of npcs) {
    if (!isPlainObject(npc)) continue;
    const committed = isString(npc.gender) ? npc.gender.trim().toLowerCase() : "";
    if (!committed) continue;
    const name = isString(npc.generatedName) && npc.generatedName.trim() ? npc.generatedName.trim() : (isString(npc.displayName) ? npc.displayName.trim() : "");
    if (name.length < 3) continue;
    // GATE (widened for the S5 Talin slip): the old gate was a MAJORITY vote over
    // the narration window (inferNpcGenderFromNarration) — MIXED usage ("…he
    // wipes… She sets her mug…") ties or flips the vote and the repair never
    // fired, while any single wrong pronoun near the name is still a visible
    // contradiction. New gate: ANY wrong-gender pronoun inside the repair scope
    // (a sentence mentioning the name, or one opening with the wrong pronoun
    // right after such a sentence) triggers the repair of exactly that scope.
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?\\b`, "i");
    if (!nameRe.test(text)) continue;
    if (committed !== "female" && committed !== "male") {
      // Non-binary: detect a gendered pronoun near the name (window heuristic) —
      // unrepairable (verb agreement can't be patched safely), surfaced for logs.
      const inferred = inferNpcGenderFromNarration(name, text);
      if (inferred && inferred.gender !== committed) {
        repairs.push({ name, committed, unrepairable: true });
      }
      continue;
    }
    const wrongPronounRe = committed === "female" ? /\b(?:he|him|his|himself)\b/i : /\b(?:she|her|hers|herself)\b/i;
    const swaps = PRONOUN_SWAPS[committed];
    const wrongOpen = committed === "female" ? /^\s*(?:He|Him|His)\b/ : /^\s*(?:She|Her|Hers)\b/;
    const sentences = text.split(/(?<=[.!?])\s+/);
    let touched = false;
    // Ambiguity guard: a sentence that ALSO names a different committed NPC of
    // the opposite gender may legitimately use those pronouns for them — skip it
    // (never swap another character's pronouns by proximity).
    const oppositeNames = npcs
      .filter((other) => isPlainObject(other) && other !== npc && isString(other.gender) && other.gender.trim().toLowerCase() !== committed)
      .map((other) => (isString(other.generatedName) && other.generatedName.trim()) || (isString(other.displayName) ? other.displayName.trim() : ""))
      .filter((n) => n.length >= 3);
    const mentionsOpposite = (sentence) =>
      oppositeNames.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?\\b`, "i").test(sentence));
    for (let i = 0; i < sentences.length; i += 1) {
      const mentions = nameRe.test(sentences[i]);
      const follows = i > 0 && nameRe.test(sentences[i - 1]) && wrongOpen.test(sentences[i]);
      if (!mentions && !follows) continue;
      if (!wrongPronounRe.test(sentences[i])) continue; // nothing wrong in scope
      if (mentionsOpposite(sentences[i])) continue; // shared sentence — ambiguous
      let s = sentences[i];
      for (const [re, sub] of swaps) {
        s = s.replace(re, sub);
      }
      if (s !== sentences[i]) {
        sentences[i] = s;
        touched = true;
      }
    }
    if (touched) {
      text = sentences.join(" ");
      repairs.push({ name, committed });
    }
  }
  return { text, repairs };
}

// PHANTOM PLACE / LORE DETECTION (#41) — the moat, LORE side. The #27 detector
// only catches people (they SPEAK or ACT); a GM-asserted PLACE or landmark ("the
// Old Watchtower", "the Gilded Kingdoms Watch") is proper-noun canon the state
// never committed, so the next turn can freely contradict it — the class that
// scored one grading session F/0. This flags capitalized landmark phrases: a
// "the …" proper-noun run ending in a place suffix (Tower, Keep, Gate, Road, …),
// or a "the X of Y" name. Pure heuristic (FLAGS for commit; does not gate).
const PLACE_SUFFIX =
  "Watchtower|Tower|Keep|Gate|Gates|Bridge|Road|Roads|District|Market|Temple|Shrine|Hall|Halls|Square|Quarter|Wall|Walls|Citadel|Cathedral|Fortress|Mine|Mines|Docks|Harbor|Harbour|Sanctum|Vault|Crossing|Pass|Ridge|Hollow|Reach|Wastes|Fields|Woods|Forest|Inn|Tavern|Palace|Spire|Bastion|Well|Chapel|Monastery|Abbey|Barrow|Crypt|Tomb|Catacombs|Sept|Sanctuary|Garrison|Watch|Ward|Wards";
const PLACE_SUFFIX_RE = new RegExp(`\\bthe\\s+((?:[A-Z][a-z]+\\s+){1,4}?(?:${PLACE_SUFFIX}))\\b`, "g");
const PLACE_OF_RE = /\bthe\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+of\s+(?:the\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;

/**
 * Pure. Scan narration for proper-noun PLACES / landmarks not vouched by
 * `knownNames` (committed location/POI/entity names + player). Returns the
 * distinct phantom place names for the caller to commit as canonical lore.
 */
export function detectPhantomLoreNames(text, knownNames = []) {
  const source = String(text || "");
  if (!source.trim()) {
    return [];
  }
  const known = new Set();
  for (const name of knownNames) {
    if (isString(name)) {
      known.add(normalizeName(name));
    }
  }
  const vouched = (raw) => {
    const norm = normalizeName(raw);
    for (const k of known) {
      if (k && (k.includes(norm) || norm.includes(k))) return true;
    }
    return false;
  };
  const found = new Map();
  for (const re of [PLACE_SUFFIX_RE, PLACE_OF_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const raw = m[1].trim();
      const norm = normalizeName(raw);
      if (norm.length < 4 || vouched(raw)) continue;
      if (!found.has(norm)) found.set(norm, raw);
    }
  }
  return [...found.values()];
}

// Commit a GM-asserted place/lore name as a CANONICAL memory fact, so the world
// durably holds it (no longer a phantom the next turn can contradict). Idempotent
// by name (a re-mention returns the existing fact). Returns the fact, or null on
// invalid input. Non-schema-heavy on purpose: lore is a fact, not a full location
// entity (the GM referenced it; it is not yet a place the player can travel to).
export function commitNarratedLoreFact(run, name, options = {}) {
  if (!isPlainObject(run) || !isString(name)) {
    return null;
  }
  if (!Array.isArray(run.memoryFacts)) {
    run.memoryFacts = [];
  }
  const clean = name.trim();
  const slug = slugify(clean);
  const existing = run.memoryFacts.find(
    (f) => isPlainObject(f) && f.type === "gm_lore" && slugify(f.payload?.name || "") === slug
  );
  if (existing) {
    return existing;
  }
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : shortId;
  const now = isString(options.now) ? options.now : new Date().toISOString();
  const fact = {
    factId: `fact_lore_${slug || "place"}_${idFactory()}`,
    entityIds: [run.runId, run.currentLocationId].filter(Boolean),
    type: "gm_lore",
    text: `${clean} is a known place referenced in the world.`,
    source: "system",
    createdAt: now,
    tags: ["system", "lore", "place"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: { name: clean, kind: "place" }
  };
  run.memoryFacts.push(fact);
  return fact;
}

// INVENTED GENERIC AGENT DETECTION (B2) — the moat, un-named-actor side. Beyond
// proper-noun people (#27), a model invents GENERIC actors: "the creature's gaze
// demands an answer", "some gutter scavenger hisses". These have agency (they act
// / speak) but no committed entity behind them (2/5 grading sessions). Commit-or-
// strip → we COMMIT: promote the acting generic agent into a real cast member, so
// it persists and the next turn can't contradict it (same doctrine as #27).
//
// A generic PARAPHRASE noun (figure/stranger/voice/someone) is a legitimate stand-
// in for an EXISTING committed cast member ("a figure steps forward" = the watcher),
// so it is only an invention when the scene has NO cast; a concrete noun
// (creature/wolf/scavenger) is committed whenever its token isn't already cast.
const AGENT_NOUNS = [
  "creature", "scavenger", "drone", "guard", "soldier", "sentry", "warden", "watcher",
  "merchant", "thief", "hunter", "raider", "bandit", "assailant", "attacker", "rider",
  "beast", "wolf", "hound", "robot", "android", "automaton", "enemy", "foe", "figure", "stranger",
  // v2 (harness-parity): an ANSWERING VOICE with no committed speaker is an
  // invented agent (the ARC-7 class: "a static-laden voice sputters from the
  // wall"). "voice" also sits in the paraphrase set, so with cast present it is
  // vouched as an existing speaker and never committed.
  "voice"
];
const AGENT_PARAPHRASE_NOUNS = new Set(["figure", "stranger", "voice", "someone", "somebody"]);
// v2 (phantom-agent upgrade): the v1 verb list carried social/movement agency
// only, so an agent whose agency was expressed through COMBAT/DESTRUCTION
// OUTCOMES slipped the net — the documented maintenance-drone case ("your blade
// shatters a rusted maintenance drone's chassis. The dying drone clatters to
// the floor") never committed live even though the offline harness flagged it.
// The second alternation is the harness's combat/outcome verb set, closing the
// live/offline divergence. Ambience stays safe: the noun allowlist still gates
// every flag ("the fire crackles" / "a cold wind screams" name no agent noun).
const AGENT_AGENCY_VERB_RE = new RegExp(
  "\\b(?:answers?|answered|replies|replied|responds?|responded|speaks?|spoke|says?|said|whispers?|calls?|called|shouts?|mutters?|growls?|hisses|" +
    "steps?|stepped|moves?|moved|emerges?|emerged|appears?|appeared|approaches|approached|arrives?|arrived|lunges?|lunged|attacks?|attacked|strikes?|struck|" +
    "watches|watched|turns?|turned|hovers?|slides?|crawls?|leaps?|circles?|stalks?|follows?|followed|blocks?|blocked|grabs?|grabbed|reaches|beckons?|nods?|stares?|demands?|demanded|" +
    "shatters?|shattered|clatters?|clattered|crashes?|crashed|collapses?|collapsed|snarls?|snarled|roars?|roared|bites?|bit|claws?|clawed|" +
    "fires?|fired|shoots?|shot|swings?|swung|charges?|charged|flees?|fled|screams?|screamed|dives?|dove|slams?|slammed|drags?|dragged|" +
    "hurls?|hurled|pounces?|pounced|springs?|sprang|bursts?|sputters?|crackles?|dies|dying)\\b",
  "i"
);

/**
 * Pure. Scan narration for GENERIC animate agents acting/speaking with no committed
 * cast to vouch them. `knownAgentTokens` is the lowercased token set the committed
 * state vouches as actors (cast/entity name words); `hasCast` is whether the run
 * has any committed NPC. Returns distinct capitalized agent display names to commit.
 */
export function detectInventedAgents(text, { knownAgentTokens = new Set(), hasCast = false } = {}) {
  const source = String(text || "");
  if (!source.trim()) {
    return [];
  }
  const found = new Map();
  const sentences = source.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  for (const sentence of sentences) {
    // Never treat the player's own body/voice as an agent, and never scan inside
    // bracketed system/state tags ("[UPDATE_ENTITY …]", "[GM VOICE]") — leaked
    // markup is the state-tag auditor's beat, not an acting entity (v2 guard).
    const lower = sentence
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(?:your|my)\s+(?:own\s+)?\w+/g, " ");
    if (!AGENT_AGENCY_VERB_RE.test(sentence)) continue;
    for (const noun of AGENT_NOUNS) {
      if (knownAgentTokens.has(noun)) continue;
      if (AGENT_PARAPHRASE_NOUNS.has(noun) && hasCast) continue; // paraphrase of existing cast
      const nounRe = new RegExp(`\\b${noun}s?\\b`, "i");
      const negatedRe = new RegExp(`\\b(?:no|not a|nor a|neither|without a|no other)\\s+(?:\\w+\\s+)?${noun}s?\\b`, "i");
      if (nounRe.test(lower) && !negatedRe.test(lower)) {
        const display = noun.charAt(0).toUpperCase() + noun.slice(1);
        if (!found.has(noun)) found.set(noun, display);
      }
    }
  }
  return [...found.values()];
}

// LIVE moat-closer (B2). Commit every generic agent the GM gave agency to but did
// not ground, as a real cast member, so it persists instead of being a phantom the
// next turn contradicts. Returns the display names committed. `knownNames` is the
// committed/visible/location set + player.
export function auditAndCommitInventedAgents(run, narrationText, knownNames = [], options = {}) {
  const hasCast = isPlainObject(run?.npcs) && Object.values(run.npcs).some((n) => isPlainObject(n) && n.status !== "gone");
  const knownAgentTokens = new Set();
  const committedNames = isPlainObject(run?.npcs)
    ? Object.values(run.npcs).map((npc) => (isPlainObject(npc) ? npc.displayName : null)).filter(Boolean)
    : [];
  for (const name of [...knownNames, ...committedNames]) {
    for (const tok of String(name || "").toLowerCase().split(/[\s-]+/)) {
      const clean = tok.replace(/[^a-z']/g, "");
      if (clean.length >= 3) knownAgentTokens.add(clean);
    }
  }
  const agents = detectInventedAgents(narrationText, { knownAgentTokens, hasCast });
  const before = isPlainObject(run?.npcs) ? new Set(Object.keys(run.npcs)) : new Set();
  const committed = [];
  for (const displayName of agents) {
    const npc = commitNarratedNpc(run, { displayName, role: "figure", tags: ["unnamed"] }, options);
    if (npc && !before.has(npc.npcId)) {
      committed.push(npc.displayName);
    }
  }
  return committed;
}

// LIVE moat-closer (#41). Commit every phantom PLACE/landmark the GM asserted as
// canonical lore, so the reference persists as truth. Returns the names committed.
// `knownNames` is the committed/visible/location set + player.
export function auditAndCommitNarratedLore(run, narrationText, knownNames = [], options = {}) {
  const phantoms = detectPhantomLoreNames(narrationText, knownNames);
  const committed = [];
  for (const name of phantoms) {
    const before = Array.isArray(run?.memoryFacts) ? run.memoryFacts.length : 0;
    const fact = commitNarratedLoreFact(run, name, options);
    if (fact && Array.isArray(run.memoryFacts) && run.memoryFacts.length > before) {
      committed.push(name);
    }
  }
  return committed;
}
