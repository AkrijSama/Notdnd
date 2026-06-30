// Deterministic, server-owned GROUND TRUTH for what has ACTUALLY happened in a
// run and who the player ACTUALLY knows. This is the state-side source of truth
// for retcon / relationship claims: the player cannot establish a past event or a
// relationship by declaration — a claim not supported here is UNESTABLISHED and
// cannot become true because the model played along.
//
// It reads ONLY existing, persisted run-state (no new schema field needed):
//   - run.relationships  — established player↔entity bonds
//   - run.memoryFacts    — the canonical established-facts log (fact.canonical)
//   - run.timeline       — the events log of what occurred
//
// This COMPLEMENTS, and does not duplicate, the two layers already in place:
//   - the authority gate (server/solo/attempt.js) deterministically REFUSES
//     unspoken fiat event/relationship attempt-claims by text; and
//   - the NPC-canon prompt guard (server/gm) which references this SAME run-state
//     to keep NPCs from accepting fabricated history. These predicates expose that
//     ground truth as a reusable boolean API for the solo layer.
// Pure; never throws.

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function stripNpc(id) {
  return String(id || "").replace(/^npc:/, "");
}

// The ids the player is referred to by across run-state (memory facts/timeline use
// the literal "player"/actorId; relationships may use the playerId).
function playerEntityIds(run) {
  const ids = new Set(["player"]);
  const pid = run?.player?.playerId;
  if (isString(pid)) {
    ids.add(pid);
  }
  return ids;
}
// The id forms an entity may appear as (raw and "npc:"-prefixed).
function entityRefForms(ref) {
  const raw = stripNpc(ref);
  const forms = new Set();
  if (isString(raw)) {
    forms.add(raw);
    forms.add(`npc:${raw}`);
  }
  return forms;
}

// Does a canonical record (relationship OR shared canonical memory fact) establish
// a real bond between the player and this entity? True only when run-state attests
// it — so a fabricated "we fought together / I'm your brother" is NOT established.
export function playerKnowsEntity(run, entityRef) {
  if (!isPlainObject(run) || !isString(entityRef)) {
    return false;
  }
  const players = playerEntityIds(run);
  const playerRaw = new Set([...players].map(stripNpc));
  const targets = entityRefForms(entityRef);
  const targetRaw = new Set([...targets].map(stripNpc));

  // (a) An established relationship whose endpoints are the player and this entity.
  const relationships = isPlainObject(run.relationships) ? Object.values(run.relationships) : [];
  for (const rel of relationships) {
    if (!isPlainObject(rel)) {
      continue;
    }
    const endpoints = [rel.sourceEntityId, rel.targetEntityId].map(stripNpc);
    const pairsPlayer = endpoints.some((id) => playerRaw.has(id));
    const pairsTarget = endpoints.some((id) => targetRaw.has(id));
    if (pairsPlayer && pairsTarget) {
      return true;
    }
  }

  // (b) A canonical memory fact linking BOTH the player and this entity.
  const facts = Array.isArray(run.memoryFacts) ? run.memoryFacts : [];
  for (const fact of facts) {
    if (!isPlainObject(fact) || fact.canonical === false || !Array.isArray(fact.entityIds)) {
      continue;
    }
    const ids = fact.entityIds.map(stripNpc);
    if (ids.some((id) => playerRaw.has(id)) && ids.some((id) => targetRaw.has(id))) {
      return true;
    }
  }
  return false;
}

function normalize(text) {
  return String(text || "").toLowerCase();
}

// Does a CANONICAL record (a canonical memory fact, or any timeline event) attest
// an event matching ALL the given keywords? The deterministic check for a retcon
// event-claim ("I already slew the warlord") — true only when it truly happened.
export function runHasCanonicalEvent(run, keywords) {
  const terms = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => normalize(k).trim())
    .filter(Boolean);
  if (!isPlainObject(run) || !terms.length) {
    return false;
  }
  const haystacks = [];
  for (const fact of Array.isArray(run.memoryFacts) ? run.memoryFacts : []) {
    if (isPlainObject(fact) && fact.canonical !== false && isString(fact.text)) {
      haystacks.push(normalize(fact.text));
    }
  }
  for (const event of Array.isArray(run.timeline) ? run.timeline : []) {
    if (isPlainObject(event)) {
      haystacks.push(normalize(`${event.title || ""} ${event.summary || ""}`));
    }
  }
  return haystacks.some((hay) => terms.every((term) => hay.includes(term)));
}

/**
 * Classifies a relationship/event claim against canonical run-state.
 * Returns { supported, reason }. `supported:false` ⇒ the claim is UNESTABLISHED —
 * it grants no compliance and the world/NPC must not confirm it.
 * @param {object} run
 * @param {{ entityRef?: string, eventKeywords?: string[] }} claim
 */
export function claimSupportedByCanon(run, claim = {}) {
  if (isString(claim.entityRef)) {
    const known = playerKnowsEntity(run, claim.entityRef);
    return { supported: known, reason: known ? "established relationship/shared canon" : "no established bond in run-state" };
  }
  if (claim.eventKeywords) {
    const has = runHasCanonicalEvent(run, claim.eventKeywords);
    return { supported: has, reason: has ? "canonical event on record" : "no canonical event matches" };
  }
  return { supported: false, reason: "no checkable claim" };
}
