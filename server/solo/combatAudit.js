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
