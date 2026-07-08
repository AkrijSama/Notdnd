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
  // Dedupe: same explicit id, same slug, or same case-insensitive display name.
  const existing = Object.values(run.npcs).find((npc) =>
    isPlainObject(npc) && (
      (isString(spec.npcId) && npc.npcId === spec.npcId) ||
      slugify(npc.displayName) === nameSlug ||
      (isString(npc.displayName) && npc.displayName.trim().toLowerCase() === displayName.toLowerCase())
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
    flags: isPlainObject(spec.flags) ? spec.flags : {}
  };
  if (isString(spec.appearance)) npc.appearance = spec.appearance.trim();
  if (isString(spec.personality)) npc.personality = spec.personality.trim();
  if (isString(spec.introInstructions)) npc.introInstructions = spec.introInstructions.trim();

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

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
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
      if (known.has(norm) || known.has(firstTok)) continue;
      if (!found.has(norm)) found.set(norm, raw);
    }
  };
  collect(ACTION_NAME_RE);
  collect(NAMED_RE);
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
    const npc = commitNarratedNpc(run, { displayName, role: "figure" }, options);
    // Only count NPCs that were NEWLY created — commitNarratedNpc returns the
    // existing record on a re-mention, which must not read as a fresh commit.
    if (npc && !before.has(npc.npcId)) {
      committed.push(npc.displayName);
    }
  }
  return committed;
}
