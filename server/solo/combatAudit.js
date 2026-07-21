// COMBAT NARRATION AUDITOR — the narrated-state-drift family, for combat. The combat
// directive is emphatic: speak WOUNDS IN BANDS, never a raw HP total or damage number
// (the server owns the numbers; the narrator speaks wounds). So ANY raw HP/damage
// figure in a combat narration is drift — a fabricated or leaked number that the
// committed resolution does not authorize. Log-only, same severity family as the
// romance-register / goal-ignored / narrated-essence auditors; the directive is the
// contract. Fires ONLY while a fight is live (out of combat, numbers are unremarkable).

// "12 HP" / "3 hit points" / "8 health"
const HP_NUMBER_RE = /\b\d{1,4}\s*(?:hp|health|hit ?points?)\b/i;
// "8 damage" / "8 points of damage"
const RAW_DAMAGE_RE = /\b\d{1,4}\s+(?:points?\s+of\s+)?damage\b/i;
// "drops to 3" / "down to 5" / "falls to 0" — a raw remaining-HP claim
const DROPS_TO_RE = /\b(?:drops?|falls?|sinks?|down|reduced)\s+to\s+\d{1,4}\b/i;

const PATTERNS = [
  { id: "hp_number", re: HP_NUMBER_RE },
  { id: "raw_damage", re: RAW_DAMAGE_RE },
  { id: "remaining_hp", re: DROPS_TO_RE }
];

/**
 * Detect raw HP/damage numbers narrated inside a live fight. Returns a list of
 * { kind, phrase } hits (empty when clean, when out of combat, or when the text is
 * empty). `combatState` is scene.combat (or run.combat) — the audit only fires when
 * status === "active".
 */
export function detectFabricatedCombatNumbers(narrationText, combatState) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  if (!combatState || combatState.status !== "active") return [];
  const hits = [];
  for (const { id, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ kind: id, phrase: m[0].trim() });
  }
  return hits;
}

// TEETH (A2, audit 5d548ac): don't just flag a fabricated number — STRIP it at the
// trim layer so the leaked figure never reaches the player. Each raw HP/damage phrase
// is replaced with wound-band language (the committed numbers are the only numbers).
// Fires only in a live fight; a no-op otherwise. Returns { text, scrubbed:[phrases] }.
const SCRUB_RULES = [
  { re: /\b\d{1,4}\s*(?:hp|health|hit ?points?)\b/gi, to: "wounded" },
  { re: /\b\d{1,4}\s+(?:points?\s+of\s+)?damage\b/gi, to: "a solid hit" },
  { re: /\b(?:drops?|falls?|sinks?|reduced)\s+to\s+\d{1,4}\b/gi, to: "reels" },
  { re: /\bdown\s+to\s+\d{1,4}\b/gi, to: "reeling" }
];
export function scrubFabricatedCombatNumbers(narrationText, combatState) {
  const text = String(narrationText || "");
  if (!text.trim() || !combatState || combatState.status !== "active") return { text, scrubbed: [] };
  const scrubbed = [];
  let out = text;
  for (const { re, to } of SCRUB_RULES) {
    out = out.replace(re, (m) => { scrubbed.push(m.trim()); return to; });
  }
  if (scrubbed.length) out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return { text: out, scrubbed };
}

// C2 — NARRATED-VIOLENCE FIREWALL (walk-2). OUTSIDE an active fight, narration may not
// deal damage / apply statuses / move vitality — HP moves ONLY through committed
// mechanisms (combat, applyFailureDamage, a hazard). So a sentence that describes an
// EXTERNAL assailant physically assaulting the PLAYER, outside combat, is a leak: it is
// stripped (and flagged so the caller can ENTER combat instead — the honest path).
//
// CALIBRATION (run_bbcb7b08): the judo-flip turn ("she flips you to the dirt") MUST flag;
// FIGURATIVE language ("the wind cuts like a knife", "the cold bites at your fingers")
// must NOT — a simile marker or an abstract/elemental subject is never an assailant.
const ASSAULT_VERB = /\b(strikes?|hits?|slams?|throws?|flips?|grabs?|seizes?|tackles?|bites?|claws?|slashes?|stabs?|lunges?\s+at|sinks?\s+(?:its?|their|his|her)\s+\w+\s+into|drives?\s+\w+\s+into|knocks?|hurls?|pins?|chokes?|wounds?|gores?|mauls?)\b/i;
const TARGETS_PLAYER = /\b(you|your)\b/i;
const FIGURATIVE = /\b(like|as if|as though|seems?|feels? like|might)\b/i;
// Abstract / elemental "subjects" that can never be a committed assailant (figurative).
const ABSTRACT_SUBJECT = /\b(wind|winds|cold|chill|air|silence|darkness|shadow|fear|dread|hunger|thirst|pain|ache|cough|heart|breath|memory|light|sun|rain|frost|fatigue|exhaustion)\b/i;

// Split into rough sentences for clause-level judgement.
function sentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

// Does this sentence describe an external assailant assaulting the player (committed
// violence), as opposed to figurative/elemental language?
export function isNarratedViolenceAgainstPlayer(sentence) {
  const s = String(sentence || "");
  if (!ASSAULT_VERB.test(s) || !TARGETS_PLAYER.test(s)) return false;
  if (FIGURATIVE.test(s)) return false; // a simile is not an assault
  // an abstract/elemental subject at the head of the clause is figurative, not an assailant
  const head = s.split(/\b(strikes?|hits?|slams?|throws?|flips?|grabs?|bites?|claws?|slashes?|stabs?|lunges?|knocks?|hurls?|pins?|chokes?|gores?|mauls?)\b/i)[0];
  if (ABSTRACT_SUBJECT.test(head) && !/\b(he|she|it|they|the\s+\w+(?:\s+\w+)?)\b/i.test(head.replace(ABSTRACT_SUBJECT, ""))) return false;
  return true;
}

/**
 * Strip narrated violence-against-the-player when NOT in an active fight. Returns the
 * cleaned text, the stripped clauses, and violenceDetected (the caller should ENTER
 * combat when a committed present hostile matches). A no-op during a live fight (the
 * combat surface owns violence then) and for figurative language.
 * @param {string} narrationText
 * @param {object|null} combatState
 * @returns {{ text: string, scrubbed: string[], violenceDetected: boolean }}
 */
export function scrubNarratedViolenceOutsideCombat(narrationText, combatState) {
  const text = String(narrationText || "");
  if (!text.trim()) return { text, scrubbed: [], violenceDetected: false };
  if (combatState && combatState.status === "active") return { text, scrubbed: [], violenceDetected: false };
  const scrubbed = [];
  const kept = [];
  for (const s of sentences(text)) {
    if (isNarratedViolenceAgainstPlayer(s)) {
      scrubbed.push(s.trim());
      // Replace the fabricated blow with pre-combat TENSION (no injury asserted).
      kept.push("The threat is real and close.");
    } else {
      kept.push(s);
    }
  }
  const out = scrubbed.length ? kept.join(" ").replace(/\s{2,}/g, " ").trim() : text;
  return { text: out, scrubbed, violenceDetected: scrubbed.length > 0 };
}
