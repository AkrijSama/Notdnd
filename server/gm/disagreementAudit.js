// DISAGREEMENT LAW (vn-dialogue-hardening, law 1) — contract + auditor pair.
//
// Research-validated retention killer: NPCs who agree with everything read as
// vending machines and the social sim collapses. The law is enforced in the same
// two-sided pattern as the spit ban / romance register:
//   1. buildDisagreementDirective(run)   — a HARD prompt-contract clause derived
//      from committed reputation values (tier + fear/suspicion meters). The
//      narrator is told which present NPCs may not simply comply, and how each
//      resists. Server-owned; values are READ here, never recomputed.
//   2. detectComplianceViolations(text, run) — post-generation auditor: quoted
//      lines grounded to a low-standing NPC (via the same attributeSceneDialogue
//      the nameplates use — never a guessed speaker) are scanned for simple-
//      compliance markers. Log-only, same severity family as narrated-state drift.

import { individualReputation } from "../solo/reputation.js";
import { attributeSceneDialogue } from "../solo/gmProvider.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Meter thresholds ([-50,50] scale; social deltas move ±1..3, so 10+ is a
// sustained committed pattern, not one bad roll).
export const FEAR_METER_THRESHOLD = 10;
export const SUSPICION_METER_THRESHOLD = 10;

function relFor(run, npcId) {
  const rels = isPlainObject(run?.relationships) ? Object.values(run.relationships) : [];
  return (
    rels.find((r) => isPlainObject(r) && r.sourceEntityId === "player" && r.targetEntityId === npcId) || null
  );
}

function presentNpcs(run) {
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  return npcs.filter((npc) => isPlainObject(npc) && npc.currentLocationId === run.currentLocationId && npc.status !== "gone");
}

function npcName(npc) {
  return npc.generatedName || npc.displayName || npc.role || npc.npcId;
}

// How this NPC resists, by committed standing. Priority: outright hostility >
// fear > distrust (suspicion meter) > wariness (tier). Returns null when the
// NPC's committed standing does not warrant the hard law (neutral and above,
// calm and unsuspicious — normal social latitude applies).
export function resistanceProfile(run, npcId) {
  const view = individualReputation(run, npcId);
  if (!view) return null;
  const rel = relFor(run, npcId);
  const fear = Number(rel?.meters?.fear) || 0;
  const suspicion = Number(rel?.meters?.suspicion) || 0;
  if (view.tier === "hostile") {
    return {
      reason: "hostile",
      tier: view.tier,
      law: "refuses player requests outright — they lie, stonewall, or actively work against the player; NO cooperation, NO favors"
    };
  }
  if (fear >= FEAR_METER_THRESHOLD) {
    return {
      reason: "fearful",
      tier: view.tier,
      law: "is AFRAID of the player — they hedge, avoid commitment, may lie just to end the exchange, and never volunteer help; fear is not friendliness"
    };
  }
  if (suspicion >= SUSPICION_METER_THRESHOLD) {
    return {
      reason: "distrustful",
      tier: view.tier,
      law: "does not trust the player's word — they question motives, demand proof or payment up front, and refuse anything on faith"
    };
  }
  if (view.tier === "wary") {
    return {
      reason: "wary",
      tier: view.tier,
      law: "is wary of the player — they deflect, answer evasively, or set terms before any cooperation; simple agreement is out of character"
    };
  }
  return null;
}

// The hard prompt-contract clause. "" when no present NPC's committed standing
// warrants it (the common friendly-scene case adds zero tokens).
export function buildDisagreementDirective(run) {
  const flagged = [];
  for (const npc of presentNpcs(run)) {
    const profile = resistanceProfile(run, npc.npcId);
    if (profile) {
      flagged.push(`${npcName(npc)} (${profile.reason}) ${profile.law}`);
    }
  }
  if (!flagged.length) return "";
  return (
    ` DISAGREEMENT LAW (hard, server-owned — committed standing binds every spoken line): ${flagged.join("; ")}.` +
    ` A character bound by this law may NOT simply agree to, comply with, or grant a player request this turn —` +
    ` refusal, deflection, a lie, or a hard demand for terms are the ONLY lawful shapes of their answer.`
  );
}

// ── auditor ──────────────────────────────────────────────────────────────────
// Simple-compliance markers: the line OPENS with assent, or contains an
// unconditional-service phrase. Negation/conditions nearby exempt the line
// ("Of course not", "Sure — once you've paid") so refusals never false-flag.
const ASSENT_OPEN_RE = /^(?:yes|sure|of course|certainly|gladly|absolutely|very well|as you wish|right away|at once|anything for you)\b/i;
const SERVICE_RE = /\b(?:i(?:'|’)?d be happy to|happy to help|no problem|it(?:'|’)?s yours|here you go|take (?:it|whatever you need)|i(?:'|’)?ll (?:get|fetch|bring|show|help|do) (?:it|that|you)\b)/i;
const NEGATION_RE = /\b(?:not|no\b|never|nothing|can't|cannot|won't|wouldn't|refuse|unless|until|if you|once you|first|prove|pay)\b|\bbut\b/i;

function isSimpleCompliance(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (NEGATION_RE.test(text)) return false;
  return ASSENT_OPEN_RE.test(text) || SERVICE_RE.test(text);
}

// Post-generation check: quoted lines attributed (grounded, never guessed) to a
// present NPC bound by the law, whose content is simple compliance. Log-only —
// the caller records violations in the turn log, same family as romance-register.
export function detectComplianceViolations(narrationText, run) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  const present = presentNpcs(run);
  const bound = new Map();
  for (const npc of present) {
    const profile = resistanceProfile(run, npc.npcId);
    if (profile) bound.set(npc.npcId, { npc, profile });
  }
  if (!bound.size) return [];
  const out = [];
  for (const line of attributeSceneDialogue(text, present, {})) {
    if (line.kind !== "npc" || !bound.has(line.speakerId)) continue;
    if (isSimpleCompliance(line.text)) {
      const { npc, profile } = bound.get(line.speakerId);
      out.push({
        npcId: npc.npcId,
        name: npcName(npc),
        tier: profile.tier,
        reason: profile.reason,
        line: String(line.text).slice(0, 160)
      });
    }
  }
  return out;
}
