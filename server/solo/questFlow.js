import crypto from "node:crypto";
import { validateSoloRun } from "./schema.js";

// ---------------------------------------------------------------------------
// QUEST-ACCEPT flow (per-verb detectX -> resolveX, sibling to search/take/move).
//
// The gap this closes (verified): an NPC "offers you a job" and the player says
// "ok, I'll do it" — but nothing was created (quests:{}), so there was no delivery
// to pursue and the session dissolved into aimless wandering. This instantiates a
// REAL tracked quest from a present NPC's `questOffer` when the player accepts, and
// places the offer's takeable item into the world so the next step (take) has a real
// object to commit against.
//
// COHERENCE FIREWALL: detectQuestAcceptIntent fires ONLY when a present NPC actually
// carries an un-accepted questOffer AND the intent expresses acceptance. No offer ->
// no quest (returns null -> normal attempt path). Nothing is conjured; the quest,
// its item, and the destination reveal are all committed server-side.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromOption(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return nowIso();
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Explicit acceptance phrasings.
const ACCEPT_VERB_RE =
  /\b(?:i accept|i'?ll do it|i will do it|i'?ll take (?:it|(?:the |this )?(?:\w+ )?(?:job|task|work|delivery|offer|contract|gig|bounty|cull|hunt|commission|contract))|i'?ll take this on|count me in|i'?m in|it'?s a deal|we have a deal|you have a deal|deal|agreed|consider it done|i'?ll help|i'?ll run it|i'?ll carry it|i'?ll deliver it|i accept the (?:job|task|offer|work|bounty|cull|hunt|commission)|let'?s do it|you can count on me)\b/i;
// A short standalone affirmative — only trusted BECAUSE a pending offer gates it.
const AFFIRMATIVE_RE = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|fine|alright|aye|absolutely|of course|very well|as you say)\b/i;

/**
 * The present NPCs at the current location that carry an un-accepted questOffer.
 * @param {object} run
 * @returns {Array<object>} npcs with a live offer
 */
export function getOfferingNpcs(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs) || !isString(run.currentLocationId)) {
    return [];
  }
  return Object.values(run.npcs).filter(
    (npc) =>
      isPlainObject(npc) &&
      npc.currentLocationId === run.currentLocationId &&
      npc.status !== "gone" &&
      isPlainObject(npc.questOffer) &&
      npc.questOffer.accepted !== true &&
      isPlainObject(npc.questOffer.quest)
  );
}

/**
 * Classifies a free-text intent as ACCEPTING a present NPC's job offer. Returns
 * { accept: true, npcId } or null. Requires a live offer present (the strong gate)
 * AND acceptance phrasing (explicit, or a bare affirmative that the pending offer
 * makes safe to read as "yes").
 * @param {object} run
 * @param {string} intent
 */
export function detectQuestAcceptIntent(run, intent) {
  const text = String(intent || "");
  if (!isString(text)) {
    return null;
  }
  const offering = getOfferingNpcs(run);
  if (offering.length === 0) {
    return null; // no live offer -> nothing to accept.
  }
  const lc = text.toLowerCase();
  const accepts = ACCEPT_VERB_RE.test(lc) || AFFIRMATIVE_RE.test(text);
  if (!accepts) {
    return null;
  }
  // If several NPCs offer, prefer one whose name is named; else take the first.
  const named = offering.find((npc) => isString(npc.displayName) && lc.includes(npc.displayName.toLowerCase()));
  const npc = named || offering[0];
  return { accept: true, npcId: npc.npcId };
}

export function validateQuestAcceptAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    runValidation.errors.forEach((error) => errors.push({ path: `run.${error.path}`, message: error.message }));
  }
  if (!isPlainObject(action)) {
    errors.push({ path: "action", message: "Expected object" });
    return { ok: errors.length === 0, errors };
  }
  if (action.type !== "quest_accept") {
    errors.push({ path: "action.type", message: "Expected quest_accept" });
  }
  if (!isString(action.npcId)) {
    errors.push({ path: "action.npcId", message: "Expected non-empty string" });
  }
  return { ok: errors.length === 0, errors };
}

function createAcceptMemoryFact(run, action, quest, offer, options) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    factId: idFactory("fact_quest"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", action.npcId, run.currentLocationId])],
    type: "quest_accepted",
    text: isString(offer.acceptedText) ? offer.acceptedText : `You accepted: ${quest.title}.`,
    source: "system",
    createdAt: now,
    tags: ["system", "quest"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: { questId: quest.questId, npcId: action.npcId }
  };
}

function createAcceptTimelineEvent(run, action, quest, memoryFact, options) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    eventId: idFactory("event_quest"),
    type: "quest_accepted",
    title: "Job Accepted",
    summary: `You accepted a job: ${quest.title}.`,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", action.npcId, run.currentLocationId])],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "quest"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: { actorId: action.actorId ?? "player", npcId: action.npcId, questId: quest.questId }
  };
}

/**
 * Commits accepting an NPC's job offer: instantiates the offered quest into
 * run.quests, places the offer's takeable item into the world (as a revealed
 * takeable searchDetail at the current location, so the take step has a real
 * object), reveals the destination location (a told-of knowledge event), and marks
 * the offer accepted so it cannot be re-taken. Refuses (ok:false) when no live
 * offer is present. Nothing is narrated that isn't committed here.
 * @param {object} run
 * @param {{ type:"quest_accept", npcId:string, actorId?:string }} action
 * @param {object} [options]
 */
export function resolveQuestAccept(run, action, options = {}) {
  const validation = validateQuestAcceptAction(run, action);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  const npc = updatedRun.npcs?.[action.npcId];
  if (!isPlainObject(npc) || !isPlainObject(npc.questOffer) || npc.questOffer.accepted === true) {
    return { ok: false, errors: [{ path: "action.npcId", message: "No open job offer here" }] };
  }
  if (npc.currentLocationId !== updatedRun.currentLocationId) {
    return { ok: false, errors: [{ path: "action.npcId", message: "The one offering the job is not here" }] };
  }
  const offer = npc.questOffer;
  const quest = clone(offer.quest);
  if (!isString(quest.questId)) {
    return { ok: false, errors: [{ path: "offer.quest.questId", message: "Offer quest missing id" }] };
  }
  // Idempotent: if already instantiated (double-accept race), refuse cleanly.
  updatedRun.quests = isPlainObject(updatedRun.quests) ? updatedRun.quests : {};
  if (isPlainObject(updatedRun.quests[quest.questId])) {
    return { ok: false, errors: [{ path: "offer.quest.questId", message: "Job already accepted" }] };
  }
  // The player CHOSE this undertaking (vs seeded side content) — suggestions and
  // GM context rank an explicitly-accepted job above the ambient main spine.
  quest.flags = isPlainObject(quest.flags) ? quest.flags : {};
  quest.flags.playerAccepted = true;
  updatedRun.quests[quest.questId] = quest;

  // Place the takeable item into the world so the next step (take) is real.
  if (isPlainObject(offer.takeableDetail)) {
    const location = updatedRun.locations?.[updatedRun.currentLocationId];
    if (isPlainObject(location)) {
      location.searchDetails = Array.isArray(location.searchDetails) ? location.searchDetails : [];
      const already = location.searchDetails.some(
        (detail) => isPlainObject(detail) && detail.detailId === offer.takeableDetail.detailId
      );
      if (!already) {
        location.searchDetails.push(clone(offer.takeableDetail));
      }
    }
  }

  // Reveal the destination — the NPC told the player where to take it (a legitimate
  // told-of knowledge event, same justification as the main quest's first target).
  if (isString(offer.destinationId)) {
    const dest = updatedRun.locations?.[offer.destinationId];
    if (isPlainObject(dest)) {
      dest.state = isPlainObject(dest.state) ? dest.state : {};
      dest.state.discovered = true;
    }
  }

  // Mark the offer accepted (no re-accept).
  npc.questOffer = { ...offer, accepted: true };

  const memoryFact = createAcceptMemoryFact(updatedRun, action, quest, offer, { now, idFactory });
  const timelineEvent = createAcceptTimelineEvent(updatedRun, action, quest, memoryFact, { now, idFactory });
  updatedRun.memoryFacts = [...(updatedRun.memoryFacts || []), memoryFact];
  updatedRun.timeline = [...(updatedRun.timeline || []), timelineEvent];
  updatedRun.updatedAt = now;

  const finalValidation = validateSoloRun(updatedRun);
  if (!finalValidation.ok) {
    return { ok: false, errors: finalValidation.errors };
  }

  return {
    ok: true,
    run: updatedRun,
    event: timelineEvent,
    memoryFact,
    questAccepted: { questId: quest.questId, title: quest.title, npcId: action.npcId },
    errors: []
  };
}
