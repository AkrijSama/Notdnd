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
