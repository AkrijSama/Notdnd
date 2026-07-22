// ---------------------------------------------------------------------------
// ABSENT-TARGET REFUSAL — Finding #2, the phantom-hostile moat leak.
//
// THE BUG (severity HIGH): at a location with no wolf committed, a typed
// "attack the wolf" fell through EVERY present-target detector (detectAttackIntent
// binds only PRESENT hostiles) to the free-narration attempt path, which then
// MANUFACTURED the creature — a wolf fought across three turns and killed, with
// combat:null and run.npcs never touched. The model described an entity the server
// never committed: the moat, breached.
//
// THE CLASS: this is not an attack bug. EVERY target-directed intent verb shares the
// same fall-through — talk-to / follow / steal-from / give-to / flee-from / ambush an
// absent agent all reach free narration and can be answered by an invented entity.
// This gate refuses the whole class BEFORE narration, so the model never gets the
// chance to invent.
//
// CONSERVATISM (pre-mortem (a) — a gate that refuses a REAL present target is WORSE
// than the bug): the gate fires ONLY when NO committed agent of the relevant kind is
// present to be the referent. If a present NPC name-matches, or (for attack) any
// hostile is present, or (for agent verbs) any NPC is present under a generic
// reference, the gate DEFERS to the existing paths. It can refuse a present target
// only if that target is named by a PROPER NAME no present NPC bears. See the tests.
//
// LIMIT (honest, per contract rule 6 / job 2.2): the ATTACK arm needs an "is this an
// agent?" signal to tell "attack the wolf" (phantom) from "attack the door" (a
// feature — swing at it). It uses world fauna + a bounded creature/person noun set +
// proper-name detection. An exotic creature word outside all three (e.g. "the basilisk"
// in a world with no basilisks and no such noun) can still slip the ATTACK arm. The
// AGENT-DIRECTED verbs have NO such gap (the verb itself implies an agent). Stated in
// docs/design/walk-phantom-findings.md.
// ---------------------------------------------------------------------------

import { ATTACK_ENTRY_RE, ENGAGE_ENTRY_RE } from "./combat.js";

function isString(v) { return typeof v === "string"; }

// Agent-directed verb families. Each REQUIRES a person/creature object; an object
// that resolves to no present agent is a phantom regardless of the noun's form.
const TALK_RE = /\b(?:talk|speak|chat|converse|whisper|argue|plead|negotiate|bargain|flirt)\s+(?:to|with)\b|\b(?:greet|address|hail)\s+\w/i;
const FOLLOW_RE = /\b(?:follow|shadow|tail|pursue|chase)\s+\w/i;
const STEAL_RE = /\b(?:steal\s+from|pickpocket|rob|mug|loot\s+from|pilfer\s+from|filch\s+from)\b/i;
const GIVE_RE = /\b(?:give|hand|offer|pass|deliver|present|show|sell)\b[^.!?]*\bto\b\s*\w/i;
const FLEE_RE = /\b(?:flee|run|escape|hide|retreat|back away)\s+from\b/i;
const AMBUSH_RE = /\b(?:ambush|sneak up on|creep up on|surprise|jump)\s+\w/i;
// NOTE: seek / find / look-for are DELIBERATELY absent — a player may search for what
// is not present (that is what searching is). detectSearchIntent already routes those
// to the honest, non-manufacturing search resolver.
// EXCLUSIONS (false-refusal guards, pre-mortem (a)). "follow the trail / essence" is
// PATH-following, not agent-following (the essence path owns it); "steal from the chest"
// is a container TAKE, not a person. These objects opt the verb OUT of the agent gate.
const PATH_NOUNS = /\b(?:trail|trails|track|tracks|path|paths|road|roads|route|routes|scent|footprints?|footsteps?|essence|trace|traces|sound|noise|light|glow|smell|river|stream|current|smoke|breeze|wind|stars?|map)\b/i;
const CONTAINER_NOUNS = /\b(?:chest|box|crate|barrel|sack|pack|bag|pouch|pockets?|corpse|body|drawer|shelf|shelves|table|stall|cart|wagon|coffer|strongbox|urn|basket|bin|locker|cabinet|cupboard|vault|shelf|till|register|drawer|desk)\b/i;

const AGENT_NOUNS = new Set([
  // people
  "man", "men", "woman", "women", "person", "people", "guy", "girl", "boy", "lady",
  "gentleman", "stranger", "figure", "someone", "somebody", "guard", "guards",
  "soldier", "soldiers", "knight", "merchant", "trader", "shopkeeper", "innkeeper",
  "barkeep", "bartender", "priest", "priestess", "monk", "mage", "wizard", "witch",
  "hunter", "ranger", "bandit", "bandits", "thief", "thieves", "robber", "cultist",
  "cultists", "villager", "villagers", "child", "kid", "king", "queen", "lord",
  "noble", "beggar", "sailor", "captain", "guardsman", "watchman", "sentry", "acolyte",
  "elf", "dwarf", "orc", "goblin", "assassin", "warrior", "fighter", "archer", "guardian",
  // creatures
  "beast", "creature", "animal", "monster", "wolf", "wolves", "bear", "bears", "dog",
  "dogs", "hound", "hounds", "cat", "lion", "tiger", "boar", "deer", "elk", "snake",
  "serpent", "spider", "spiders", "rat", "rats", "bird", "hawk", "crow", "raven",
  "horse", "goat", "demon", "demons", "spirit", "ghost", "wraith", "drifter",
  "chaosling", "thing", "coyote", "bobcat", "cougar", "fox", "owl", "vermin"
]);

const AGENT_PRONOUNS = new Set(["him", "her", "them", "someone", "somebody", "anyone"]);

// Tokens that are never a distinctive NPC-name token (mirrors combat.js).
const TOKEN_STOP = new Set(["the", "a", "an", "of", "and", "reeve's", "reeves", "mr", "ms", "to", "with", "from", "at"]);

function presentNpcs(run) {
  const here = run?.currentLocationId;
  return Object.values(run?.npcs || {}).filter(
    (npc) => npc && npc.currentLocationId === here && npc.status !== "dead" && npc.flags?.defeated !== true
  );
}

// A present NPC's distinctive display-name tokens (len >= 4, non-stopword). "attack
// the grey" matches the "Limping Grey"; "the wolf" does not match "Barkeep".
function npcNameTokens(npc) {
  return String(npc.displayName || npc.generatedName || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !TOKEN_STOP.has(t));
}
function anyNpcNameMatches(present, lowerText) {
  return present.some((npc) => npcNameTokens(npc).some((t) => lowerText.includes(t)));
}

// A capitalized proper name in the ORIGINAL text that no present NPC bears and that is
// not a sentence-initial or common word. Returns the name or null. Deliberately narrow
// (single Cap token, or Cap Cap) to avoid firing on "The", "You", etc.
const PROPER_RE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g;
const PROPER_STOP = new Set([
  "You", "Your", "The", "There", "Then", "This", "That", "They", "Their", "It", "He",
  "She", "We", "But", "And", "For", "With", "Attack", "Strike", "Kill", "Talk", "Speak",
  "Follow", "Give", "Steal", "Flee", "Ambush", "Face", "Hit", "Fight", "Draw", "Take"
]);
function absentProperName(text, present) {
  const lowerPresent = present.map((npc) => npcNameTokens(npc));
  let m;
  PROPER_RE.lastIndex = 0;
  while ((m = PROPER_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    const first = raw.split(/\s+/)[0];
    if (PROPER_STOP.has(first)) continue;
    const norm = raw.toLowerCase();
    const bornBy = lowerPresent.some((toks) => toks.some((t) => norm.includes(t) || t.includes(norm.split(/\s+/)[0])));
    if (!bornBy) return raw;
  }
  return null;
}

// Is the attack target an AGENT (creature/person), so a swing at it would need a
// committed entity? Returns a short label or null. Layered: world fauna → agent-noun
// set → proper name → agent pronoun.
function attackTargetAgent(run, text, lower) {
  const fauna = Array.isArray(run?.world?.plausibleFauna) ? run.world.plausibleFauna : [];
  for (const f of fauna) {
    const words = String(f).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    for (const w of words) {
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return w;
    }
  }
  for (const noun of AGENT_NOUNS) {
    if (new RegExp(`\\b${noun}\\b`).test(lower)) return noun;
  }
  const proper = absentProperName(text, presentNpcs(run));
  if (proper) return proper;
  for (const p of AGENT_PRONOUNS) if (new RegExp(`\\b${p}\\b`).test(lower)) return "them";
  return null;
}

function refusal(category, narration, label) {
  return { refuse: true, category, narration, targetLabel: label || null };
}

/**
 * Detect an intent that targets an AGENT the server has not committed at the player's
 * location. Returns { refuse:true, category, narration, targetLabel } or null.
 * Pure; reads run state only. Callers gate on !interrogative.
 */
export function detectAbsentTargetRefusal(run, intent) {
  if (!run || run.combat?.status === "active") return null;
  const text = isString(intent) ? intent : "";
  if (!text.trim()) return null;
  const lower = text.toLowerCase();

  const isAttack = ATTACK_ENTRY_RE.test(lower) || ENGAGE_ENTRY_RE.test(lower);
  const isTalk = TALK_RE.test(lower);
  const isFollow = FOLLOW_RE.test(lower) && !PATH_NOUNS.test(lower);   // path-following is not agent-following
  const isSteal = STEAL_RE.test(lower) && !CONTAINER_NOUNS.test(lower); // container theft is a TAKE, not a person
  const isGive = GIVE_RE.test(lower);
  const isFlee = FLEE_RE.test(lower);
  const isAmbush = AMBUSH_RE.test(lower);
  const agentDirected = isTalk || isFollow || isSteal || isGive || isFlee || isAmbush;
  if (!isAttack && !agentDirected) return null;

  const present = presentNpcs(run);
  // Resolves to a present entity by name → not a phantom; the present-target paths own it.
  if (anyNpcNameMatches(present, lower)) return null;

  if (agentDirected) {
    // The verb REQUIRES an agent object. Refuse when NOBODY is present to be it, or
    // when a PROPER NAME names an agent no present NPC bears. A generic reference with
    // some NPC present is DEFERRED (it may mean that NPC — never a false refusal).
    const proper = absentProperName(text, present);
    if (present.length === 0) {
      if (isTalk) return refusal("absent_target_talk", "There is no one here to talk to.");
      if (isFollow) return refusal("absent_target_follow", "There is no one here to follow.");
      if (isSteal) return refusal("absent_target_steal", "There is no one here to steal from.");
      if (isGive) return refusal("absent_target_give", "There is no one here to give anything to.");
      if (isFlee) return refusal("absent_target_flee", "There is nothing here to flee from.");
      if (isAmbush) return refusal("absent_target_ambush", "There is no one here to ambush.");
    }
    if (proper) {
      return refusal("named_agent_absent", `There is no ${proper} here.`, proper);
    }
    return null;
  }

  // ATTACK / ENGAGE. A present hostile means the present-target/ambiguity paths own it
  // (detectAttackIntent's sole-hostile fallback, or a clarify) — never refuse then.
  const hostiles = present.filter((npc) => npc.flags?.hostile === true);
  if (hostiles.length > 0) return null;
  // No hostile present. Refuse only if the target names an AGENT (else "attack the
  // door" is a legit swing at a feature and must fall through unchanged).
  const label = attackTargetAgent(run, text, lower);
  if (!label) return null;
  const nice = /^[A-Z]/.test(label) ? label : `${label}`;
  return refusal("phantom_hostile", `There is no ${nice} here to attack.`, label);
}

/**
 * Build the turn RESULT for a refused absent-target intent — shaped exactly like the
 * unreachable-move grounded refusal (buildUnreachableMoveResult): ok:true, a gated
 * attemptResult carrying the diegetic line, and NO result.run (state untouched — no
 * npc minted, no combat opened, no hp delta, no clock tick). The suggestion engine
 * still offers moves/actions so the player is never stranded.
 */
export function buildAbsentTargetRefusalResult(run, normalized, refusalInfo, { getAvailableMoves, getAvailableSoloActions }) {
  return {
    ok: true,
    action: normalized,
    attemptResult: {
      actorId: normalized.actorId ?? "player",
      intent: normalized.intent,
      success: false,
      needsCheck: false,
      checkResult: null,
      consequence: { type: "refused", applied: false, category: refusalInfo.category, reason: "named target not present or committed" },
      foreclosed: false,
      unpossessed: false,
      gated: true,
      gateCategory: refusalInfo.category,
      narration: refusalInfo.narration,
      damage: null
    },
    availableMoves: getAvailableMoves(run),
    availableActions: getAvailableSoloActions(run),
    errors: []
  };
}
