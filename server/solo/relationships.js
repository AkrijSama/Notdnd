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

const METERS = ["trust", "affection", "fear", "debt", "suspicion", "loyalty", "rivalry"];
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
  return {
    targetNpcId: npc.npcId,
    targetName: npc.generatedName || npc.displayName || npc.role || npc.npcId,
    meter,
    delta: primaryDelta,
    suspicionDelta,
    before: beforePrimary,
    after: rel.meters[meter]
  };
}

export const RELATIONSHIP_METERS = METERS;
