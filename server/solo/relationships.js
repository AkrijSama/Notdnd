// ---------------------------------------------------------------------------
// SOCIAL DISPOSITION COMMIT (B2) — the relationship side of the coherence moat.
//
// The hole this closes: run.relationships exists (trust / affection / fear / …
// meters) and validates, but NOTHING moved it — a persuade / charm / intimidate
// success narrated rapport while the committed disposition never changed. So a
// social win was theatre (the same narrate-into-void as a passive success), and
// nothing could gate on a relationship (the romance / non-combat prerequisite).
//
// This commits a bounded meter delta on the player→NPC relationship when a SOCIAL
// attempt resolves against a present NPC: a clean win moves the mapped meter, a
// win-at-a-cost moves it less and adds a little suspicion, a failure adds
// suspicion (a botched approach puts them on guard). The server owns the numbers;
// the GM only narrates them. Pure — mutates the passed run, no I/O, no Date.now.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import {
  applyAffinityToRelationship,
  recomputeIndividualTiers,
  aggregateAffinityFromMeters,
  isRomanceEligible,
  pendingRomanceGateSpec,
  romanceGateBeat,
  selectRejectionOutcome,
  lightningStrikeDelta
} from "./reputation.js";

const METERS = ["trust", "affection", "fear", "debt", "suspicion", "loyalty", "rivalry"];

// reputation-engine-v1: the base affinity a social band contributes to the running
// score (before per-target preference weighting). Owner-tunable.
const SOCIAL_AFFINITY_BASE = { success: 2, cost: 1, failure: -1 };
// Social intents that read as their own preference tags — a violence-averse NPC
// resents a "successful" intimidation. Others weight neutrally (1).
function socialTags(meter) {
  return meter === "fear" ? ["violence", "intimidation"] : [];
}
const METER_MIN = -50;
const METER_MAX = 50;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function clampMeter(n) {
  const v = Number.isFinite(n) ? n : 0;
  return Math.max(METER_MIN, Math.min(METER_MAX, v));
}

// Which meter a social verb moves. Ordered — the FIRST match wins, so coercion
// beats a generic "talk". A social intent with no specific verb defaults to trust
// (plain rapport). Deceit builds (false) trust on a win — the lie landed.
const SOCIAL_METER_RULES = [
  { re: /\b(intimidate|threaten|menace|coerce|scare|frighten|browbeat|cow)\b/i, meter: "fear" },
  { re: /\b(charm|seduce|woo|flirt|romance|comfort|console|flatter|endear|befriend|warm)\b/i, meter: "affection" },
  { re: /\b(deceive|lie|bluff|trick|con|mislead|dupe|fool)\b/i, meter: "trust" },
  { re: /\b(persuade|convince|negotiate|reassure|impress|appeal|plead|win\s+over|talk|barter|perform)\b/i, meter: "trust" }
];

function meterForIntent(intent) {
  const t = String(intent || "");
  for (const rule of SOCIAL_METER_RULES) {
    if (rule.re.test(t)) return rule.meter;
  }
  return "trust";
}

// Present, non-gone NPCs at the player's current location.
function presentNpcs(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs) || !isString(run.currentLocationId)) {
    return [];
  }
  return Object.values(run.npcs).filter(
    (npc) => isPlainObject(npc) && npc.currentLocationId === run.currentLocationId && npc.status !== "gone"
  );
}

// Resolve WHICH present NPC a social attempt is aimed at: an explicit targetId, a
// name in the intent, or the sole present NPC. Null when it can't be grounded (no
// disposition is committed against a guessed or absent target — the moat holds).
export function resolveSocialTarget(run, { intent, targetId } = {}) {
  const present = presentNpcs(run);
  if (present.length === 0) return null;
  const byId = isString(targetId)
    ? present.find((npc) => npc.npcId === targetId || npc.npcId === `npc:${targetId}` || rawId(npc.npcId) === targetId)
    : null;
  if (byId) return byId;
  const text = String(intent || "").toLowerCase();
  const named = present.find((npc) => {
    const name = (npc.generatedName || npc.displayName || "").toLowerCase();
    return name.length >= 3 && text.includes(name);
  });
  if (named) return named;
  return present.length === 1 ? present[0] : null;
}

function rawId(id) {
  const v = String(id || "");
  return v.startsWith("npc:") ? v.slice(4) : v;
}

function ensureRelationship(run, npcId, { idFactory } = {}) {
  // run.relationships is a keyed RECORD (relationshipId -> relationship), not an
  // array — match the schema (createDefaultSoloRun seeds {}).
  if (!isPlainObject(run.relationships)) {
    run.relationships = {};
  }
  const playerId = "player";
  let rel = Object.values(run.relationships).find(
    (r) => isPlainObject(r) && r.sourceEntityId === playerId && r.targetEntityId === npcId
  );
  if (!rel) {
    const mk = typeof idFactory === "function" ? idFactory : () => crypto.randomBytes(4).toString("hex");
    const relationshipId = `rel_${rawId(npcId)}_${mk()}`;
    rel = {
      relationshipId,
      sourceEntityId: playerId,
      targetEntityId: npcId,
      meters: METERS.reduce((acc, m) => ({ ...acc, [m]: 0 }), {}),
      memoryFactIds: [],
      flags: {}
    };
    run.relationships[relationshipId] = rel;
  }
  if (!isPlainObject(rel.meters)) {
    rel.meters = METERS.reduce((acc, m) => ({ ...acc, [m]: 0 }), {});
  }
  for (const m of METERS) {
    if (!Number.isFinite(rel.meters[m])) rel.meters[m] = 0;
  }
  // reputation-engine-v1: ensure the running affinity + computed tiers exist,
  // MIGRATING a legacy B2 record by aggregating its committed trust+affection (no
  // meter is discarded). Idempotent; recomputes romanceTier off the present NPC.
  if (!Number.isFinite(rel.affinity)) rel.affinity = aggregateAffinityFromMeters(rel.meters);
  recomputeIndividualTiers(rel, run.npcs?.[npcId]);
  return rel;
}

/**
 * Commit a social attempt's disposition change against a present NPC. Returns the
 * committed change { targetNpcId, targetName, meter, delta, before, after } (so the
 * attempt result can surface it and the GM can narrate it), or null when the intent
 * is not social / there is no groundable target (no phantom disposition).
 *
 * band: "success" | "success_at_cost" | "failure" | "automatic".
 */
export function commitSocialDisposition(run, { intent, targetId, band, success } = {}, options = {}) {
  if (!isPlainObject(run)) return null;
  const npc = resolveSocialTarget(run, { intent, targetId });
  if (!npc) return null;
  const meter = meterForIntent(intent);
  const rel = ensureRelationship(run, npc.npcId, options);

  // Bounded deltas: a clean win moves the meter +3; at-a-cost +1 (plus +1
  // suspicion — they got what they wanted but the seams showed); a failure adds
  // +2 suspicion (a botched approach puts them on guard), no primary movement.
  const b = String(band || (success === true ? "success" : "failure")).toLowerCase();
  let primaryDelta = 0;
  let suspicionDelta = 0;
  if (b.includes("cost")) {
    primaryDelta = 1;
    suspicionDelta = 1;
  } else if (b.includes("fail")) {
    primaryDelta = 0;
    suspicionDelta = 2;
  } else {
    // clean success (or automatic social beat)
    primaryDelta = 3;
  }
  if (primaryDelta === 0 && suspicionDelta === 0) {
    return null;
  }
  const beforePrimary = rel.meters[meter];
  if (primaryDelta !== 0) {
    rel.meters[meter] = clampMeter(rel.meters[meter] + primaryDelta);
  }
  if (suspicionDelta !== 0) {
    rel.meters.suspicion = clampMeter(rel.meters.suspicion + suspicionDelta);
  }
  // reputation-engine-v1: the social outcome also moves the RUNNING AFFINITY,
  // preference-weighted (the "now weighted" B2 path). Intimidation reads as a
  // violence tag, so a violence-averse target's affinity can drop even on a compliant
  // win. recompute romanceTier off the (now-moved) affection meter.
  const bandKey = b.includes("cost") ? "cost" : b.includes("fail") ? "failure" : "success";
  // Captured BEFORE the affinity apply so the client can detect a tier CROSSING
  // (romanceTierBefore !== romanceTier) and cue it distinctly (vn tier-cue).
  const romanceTierBefore = rel.romanceTier ?? null;
  const affinityChange = applyAffinityToRelationship(rel, npc, SOCIAL_AFFINITY_BASE[bandKey], socialTags(meter));
  return {
    targetNpcId: npc.npcId,
    targetName: npc.generatedName || npc.displayName || npc.role || npc.npcId,
    meter,
    delta: primaryDelta,
    suspicionDelta,
    before: beforePrimary,
    after: rel.meters[meter],
    // running standing surfaced alongside the meter (the GM/scene reads these).
    affinity: rel.affinity,
    affinityDelta: affinityChange?.delta ?? 0,
    tier: rel.tier,
    romanceTierBefore,
    romanceTier: rel.romanceTier
  };
}

/**
 * GIFT COMMIT (reputation-engine-v1). Transfer an inventory item to a present/known
 * NPC; their preference weights PRICE it (Stardew law) into an affinity delta. A
 * loved-tag gift amplifies, an untagged gift lands base, a hated-tag gift insults.
 * Consumes one of the item. Returns the committed change, or null when the NPC/item
 * can't be grounded (no phantom transfer). Server-committed; the GM only narrates it.
 */
export function commitGift(run, { npcId, itemId } = {}, options = {}) {
  if (!isPlainObject(run)) return null;
  const npc = run.npcs?.[npcId];
  const item = run.inventory?.[itemId];
  if (!isPlainObject(npc) || !isPlainObject(item)) return null;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const rel = ensureRelationship(run, npcId, options);
  const GIFT_BASE = 2;
  const romanceTierBefore = rel.romanceTier ?? null;
  const change = applyAffinityToRelationship(rel, npc, GIFT_BASE, tags);
  // Transfer: one unit leaves the player's pack (the gift is really given).
  if (Number.isFinite(item.quantity) && item.quantity > 1) item.quantity -= 1;
  else delete run.inventory[itemId];
  return {
    targetNpcId: npcId,
    targetName: npc.generatedName || npc.displayName || npc.role || npcId,
    itemId,
    itemName: item.name || itemId,
    itemTags: tags,
    baseDelta: GIFT_BASE,
    weight: change.weight,
    delta: change.delta,
    before: change.before,
    after: change.after,
    tier: change.tier,
    romanceTierBefore,
    romanceTier: change.romanceTier
  };
}

export const RELATIONSHIP_METERS = METERS;

// ═══ ROMANCE TWO-TRACK + GATES + REJECTION + LIGHTNING (R1/R5/R8/R4 commits) ═══
// The affection meter accrues via the normal social/gift routes above. These
// functions own the ROMANCE TRACK: the explicit switch, the gate events, the
// rejection outcomes, and the lightning-strike deed hook. Server-owned, pure
// (mutate the passed run), narrator only voices what they commit.

// Explicit romance-track-OPENING verbs (R1). Distinct from generic charm/flirt in
// SOCIAL_METER_RULES, which only build the affection METER — these are the committed
// "knock" that opens the door. A generic "flirt with X" both builds affection AND
// opens (flirt is listed as an initiation door in the ruling).
const ROMANTIC_OPEN_RE = /\b(confess|court|courting|woo|propose|proposing|ask(?:ing)?\s+(?:\w+\s+)?out\b|kiss(?:ing)?|profess|declare\s+(?:my\s+|your\s+)?(?:love|feelings)|make\s+a\s+move|flirt(?:ing)?\s+with)\b/i;
/** Does this intent read as an explicit romance-track-opening action? Pure. */
export function detectRomanticOpen(intent) {
  return ROMANTIC_OPEN_RE.test(String(intent || ""));
}

function findPlayerRel(run, npcId) {
  if (!isPlainObject(run) || !isPlainObject(run.relationships)) return null;
  return Object.values(run.relationships).find((r) => isPlainObject(r) && r.sourceEntityId === "player" && r.targetEntityId === npcId) || null;
}

/**
 * R1: open the romance track (the switch) on player→NPC. Only for a romance-eligible
 * NPC. `initiator`: "player" (flirt/confess/court) or "npc" (a crush the player
 * ACCEPTED). Idempotent. Returns { opened, initiator, romanceTier } or {opened:false}.
 */
export function openRomanceTrack(run, npcId, { initiator = "player", idFactory } = {}) {
  const npc = run?.npcs?.[npcId];
  if (!isRomanceEligible(npc)) return { opened: false, reason: "ineligible", npcId };
  const rel = ensureRelationship(run, npcId, { idFactory });
  const already = rel.romanceOpen === true;
  rel.romanceOpen = true;
  if (!rel.romanceOpenedBy) rel.romanceOpenedBy = initiator;
  if (!Array.isArray(rel.romanceGatesPassed)) rel.romanceGatesPassed = [];
  recomputeIndividualTiers(rel, npc);
  return { opened: !already, initiator: rel.romanceOpenedBy, romanceTier: rel.romanceTier, npcId };
}

/** R5: the gate owed on this relationship (with its committed beat), or null. Read-only. */
export function pendingRomanceGate(run, npcId) {
  const npc = run?.npcs?.[npcId];
  const rel = findPlayerRel(run, npcId);
  const spec = pendingRomanceGateSpec(rel, npc);
  if (!spec) return null;
  return { ...spec, npcId, beat: romanceGateBeat(rel, npc, spec.tier) };
}

/**
 * R5: commit a gate event — marks that tier's gate passed so the promotion resolves.
 * Enforces order (partner's gate needs courting's first). Returns the committed gate
 * with the tier crossing (romanceTierBefore/after), or null.
 */
export function commitRomanceGate(run, npcId, tier, { idFactory } = {}) {
  const npc = run?.npcs?.[npcId];
  if (!isRomanceEligible(npc)) return null;
  const t = String(tier || "");
  if (t !== "courting" && t !== "partner") return null;
  const rel = ensureRelationship(run, npcId, { idFactory });
  if (!Array.isArray(rel.romanceGatesPassed)) rel.romanceGatesPassed = [];
  if (t === "partner" && !rel.romanceGatesPassed.includes("courting")) return null;
  const before = rel.romanceTier;
  if (!rel.romanceGatesPassed.includes(t)) rel.romanceGatesPassed.push(t);
  recomputeIndividualTiers(rel, npc);
  return { npcId, tier: t, romanceTierBefore: before, romanceTier: rel.romanceTier, beat: romanceGateBeat(rel, npc, t) };
}

/**
 * R8: commit a rejection outcome (GRUDGE | TORCH | FADE | GENUINE_FRIENDS),
 * DETERMINISTICALLY selected from committed disposition × history. `initiator` = who
 * was rebuffed. Commits the outcome's disposition effect; closes the switch. Narrator
 * only voices. Returns { outcome, ... } or null.
 */
export function commitRomanceRejection(run, npcId, { initiator = "player", seed, idFactory } = {}) {
  const npc = run?.npcs?.[npcId];
  if (!isPlainObject(npc)) return null;
  const rel = ensureRelationship(run, npcId, { idFactory });
  const s = seed != null ? String(seed) : `${run?.worldSeed || run?.runId || ""}|${npcId}|${rel.meters?.affection ?? 0}`;
  const outcome = selectRejectionOutcome(rel, npc, s);
  const before = { affinity: rel.affinity, suspicion: rel.meters.suspicion };
  let torchSeed = null;
  if (outcome === "grudge") {
    rel.meters.suspicion = clampMeter(rel.meters.suspicion + 6);
    rel.meters.rivalry = clampMeter((rel.meters.rivalry ?? 0) + 4);
    applyAffinityToRelationship(rel, npc, -8);
  } else if (outcome === "torch") {
    // outward friendship kept + a SECRET thread-seed (covert-watching hook)
    rel.flags = isPlainObject(rel.flags) ? rel.flags : {};
    torchSeed = { npcId, secret: true, hook: "covert-watching", seededAtAffinity: rel.affinity };
    rel.flags.torch = torchSeed;
  } else if (outcome === "fade") {
    applyAffinityToRelationship(rel, npc, -4); // interest decays
  }
  // GENUINE_FRIENDS: clean — no penalty. All outcomes close the romance switch.
  rel.romanceOpen = false;
  recomputeIndividualTiers(rel, npc);
  return { npcId, initiator, outcome, seed: s, before, affinity: rel.affinity, suspicion: rel.meters.suspicion, romanceTier: rel.romanceTier, torchSeed };
}

/**
 * Per-turn romance orchestration (the thin hook attempt.js calls once, alongside the
 * gift/charm routes): (1) an explicit romantic intent on a non-failed turn OPENS the
 * switch (R1); (2) if the affection meter has now reached the next tier's threshold
 * with the switch open, the GATE fires as a committed beat this turn and the promotion
 * resolves after it (R5). Returns { npcId, opened, gate } or null. Server-owned.
 */
export function applyRomanceTurn(run, { intent, targetId, success, dispositionChange, giftChange, idFactory } = {}) {
  const npcId = dispositionChange?.targetNpcId || giftChange?.targetNpcId || resolveSocialTarget(run, { intent, targetId })?.npcId;
  if (!npcId) return null;
  if (!isRomanceEligible(run?.npcs?.[npcId])) return null;
  let opened = null;
  if (success !== false && detectRomanticOpen(intent)) {
    opened = openRomanceTrack(run, npcId, { initiator: "player", idFactory });
  }
  let gate = null;
  const owed = pendingRomanceGate(run, npcId);
  if (owed) gate = commitRomanceGate(run, npcId, owed.tier, { idFactory });
  if (!opened && !gate) return null;
  return { npcId, opened, gate };
}

/**
 * R4: apply a lightning-strike affection surge from an extraordinary committed deed
 * (faction-saved / family-saved / heirloom-returned class). Bounded by the Law-6
 * table + hard ceiling. Wire this into the deed/consequence commit path. Returns the
 * committed change, or null when the deed class carries no delta.
 */
export function applyLightningStrike(run, npcId, deedClass, { idFactory } = {}) {
  const npc = run?.npcs?.[npcId];
  if (!isPlainObject(npc)) return null;
  const delta = lightningStrikeDelta(deedClass);
  if (delta <= 0) return null;
  const rel = ensureRelationship(run, npcId, { idFactory });
  const affectionBefore = rel.meters.affection ?? 0;
  rel.meters.affection = clampMeter(affectionBefore + delta);
  const change = applyAffinityToRelationship(rel, npc, delta);
  return { npcId, deedClass, delta, affectionBefore, affectionAfter: rel.meters.affection, affinity: rel.affinity, affinityDelta: change?.delta ?? 0, romanceTier: rel.romanceTier };
}
