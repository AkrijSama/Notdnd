// Pure builders for the GM-narration prompts used by the solo play loop and the
// world-entry opening. Dependency-free so they stay unit-testable; the actual
// runGmPipeline call + persistence lives in the request layer (server/index.js)
// and onboarding (server/campaign/onboarding.js).

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function currentLocation(run) {
  const locations = run && typeof run.locations === "object" && run.locations ? run.locations : {};
  return locations[run?.currentLocationId] || {};
}

function styleSuffix(run) {
  const tone = isString(run?.world?.tone) ? run.world.tone : "dark fantasy";
  return (
    `Narrate in 2-4 vivid sentences of second-person ${tone} prose. ` +
    "Do not restate dice or mechanics, and do not use bracketed trigger tags."
  );
}

// --- NPC invented-canon defense (the coherence moat, NPC side) ---------------
// A player can SAY anything; the NPC must not let the player's words rewrite the
// world. The model handles the nuance of HOW an NPC reacts (skeptical, amused,
// guarded), but it should not have to GUESS what is genuinely true — so we derive
// the ground truth from run-state and hand it to the prompt. State provides the
// facts where they exist; the model supplies the in-character delivery.

// The entity ids the player is referred to by across run-state (memory facts use
// the literal "player"/actorId; relationships may use the player's playerId).
function playerEntityIds(run) {
  const ids = new Set(["player"]);
  const pid = run?.player?.playerId;
  if (isString(pid)) {
    ids.add(pid);
  }
  return ids;
}

// The entity ids an NPC is referred to by (raw id and the "npc:"-prefixed form).
function npcEntityIds(npc) {
  const ids = new Set();
  if (isString(npc?.npcId)) {
    ids.add(npc.npcId);
    ids.add(`npc:${npc.npcId}`);
  }
  return ids;
}

// Pure. Reads run-state to determine what an NPC GENUINELY has with the player:
// an established relationship (run.relationships linking the two), whether they
// are acquainted (npc.known), and how many canonical shared-history facts link
// them. This is the deterministic backstop — anything the player asserts beyond
// this is, by definition, unverified.
export function npcEstablishedWithPlayer(run, npc) {
  const players = playerEntityIds(run);
  const npcs = npcEntityIds(npc);
  const linksBoth = (entityIds) => {
    if (!Array.isArray(entityIds)) {
      return false;
    }
    let hasPlayer = false;
    let hasNpc = false;
    for (const id of entityIds) {
      if (players.has(id)) hasPlayer = true;
      if (npcs.has(id)) hasNpc = true;
    }
    return hasPlayer && hasNpc;
  };

  // Established relationship: a run.relationships entry whose two endpoints are
  // the player and this NPC (in either direction).
  let relationship = null;
  const relationships = run && typeof run.relationships === "object" && run.relationships ? run.relationships : {};
  for (const entry of Object.values(relationships)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const endpoints = new Set();
    const src = isString(entry.sourceEntityId) ? entry.sourceEntityId.replace(/^npc:/, "") : "";
    const tgt = isString(entry.targetEntityId) ? entry.targetEntityId.replace(/^npc:/, "") : "";
    endpoints.add(src);
    endpoints.add(tgt);
    const pairsPlayer = [...players].some((id) => endpoints.has(id.replace(/^npc:/, "")));
    const pairsNpc = [...npcs].some((id) => endpoints.has(id.replace(/^npc:/, "")));
    if (pairsPlayer && pairsNpc) {
      relationship = entry;
      break;
    }
  }

  // Canonical shared-history facts that link both the player and this NPC.
  const facts = Array.isArray(run?.memoryFacts) ? run.memoryFacts : [];
  const sharedFacts = facts
    .filter((fact) => fact && fact.canonical !== false && linksBoth(fact.entityIds))
    .map((fact) => (isString(fact.text) ? fact.text.trim() : ""))
    .filter(Boolean);

  return {
    known: npc?.known === true,
    relationship,
    sharedFacts
  };
}

// Describes an established relationship in plain words for the prompt, drawing on
// the free-form flags (kind/label/descriptor) the relationship may carry, with a
// generic fallback. Never throws on partial data.
function describeRelationship(relationship) {
  const flags = relationship && typeof relationship.flags === "object" && relationship.flags ? relationship.flags : {};
  const label = [flags.kind, flags.label, flags.descriptor, flags.type]
    .find((value) => isString(value));
  return isString(label) ? label.trim() : "an established relationship recorded in the world's history";
}

// Pure. Builds the hardened invented-canon guard for a talk turn, grounded in
// run-state. Two halves:
//   1. GROUND TRUTH from state — what (if anything) is genuinely established
//      between this NPC and the player, so a real bond is HONORED (anti-tyranny)
//      and the absence of one is explicit.
//   2. The DISCIPLINE — the NPC does not accept player-asserted history,
//      relationships, promises, or authority it has no basis to know are true,
//      and never grants compliance (passage, goods, obedience) on the strength of
//      an unverified claim alone. A real persuasion/deception attempt still rolls
//      separately; the point is the claim isn't auto-true.
export function buildNpcCanonGuard(run, npc, speaker) {
  const who = isString(speaker) ? speaker : (isString(npc?.displayName) ? npc.displayName : "the NPC");
  const established = npcEstablishedWithPlayer(run, npc);

  let groundTruth;
  if (established.relationship) {
    groundTruth =
      ` GROUND TRUTH (from the world's records — this IS real, honor it): ${who} and the player share ` +
      `${describeRelationship(established.relationship)}. Treat that bond as genuine and respond accordingly.`;
  } else if (established.known || established.sharedFacts.length > 0) {
    const sample = established.sharedFacts.slice(-2).join(" | ");
    groundTruth =
      ` GROUND TRUTH (from the world's records): ${who} has only met the player in passing — the ONLY real history ` +
      `between them is${sample ? ` what has actually happened in play (e.g. "${sample}")` : " this encounter"}. ` +
      `There is NO deeper bond, kinship, debt, or shared past on record.`;
  } else {
    groundTruth =
      ` GROUND TRUTH (from the world's records): ${who} does NOT know the player. There is NO prior relationship, ` +
      `shared history, kinship, debt, oath, or promise between them on record. The player is a stranger to ${who}.`;
  }

  const discipline =
    ` ${who} only knows what they genuinely would. The player may CLAIM anything — invented shared history ` +
    `("we fought together at Blackmoor"), a fabricated relationship ("I'm your brother / the captain's kin"), a ` +
    `made-up promise or obligation ("the king granted me passage", "you owe me"), or any backstory the records above ` +
    `do NOT support. ${who} must NOT accept such a claim as established fact and must NOT rewrite the world to fit it. ` +
    `${who} may be skeptical, dismissive, confused, or play along noncommittally — but never confirm the invented ` +
    `claim as true. Crucially, ${who} does NOT grant compliance — passage, goods, secrets, obedience — on the strength ` +
    `of an unverified claimed relationship or promise alone. (The player is free to try to persuade or deceive; that ` +
    `is a separate effort that can fail — the claim itself is not automatically true.)`;

  return groundTruth + discipline;
}

/**
 * Builds a GM-narration prompt for a resolved solo action, or null when the
 * action type carries no narration (e.g. inspect). Pure.
 * @param {object} run the (post-action) solo run
 * @param {object} resolved the resolveSoloAction result
 * @returns {string|null}
 */
export function buildActionGmMessage(run, resolved) {
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const type = resolved.action?.type;
  const loc = currentLocation(run);
  const suffix = styleSuffix(run);

  if (type === "attempt") {
    const ar = resolved.attemptResult;
    // No AI narration for a missing or policy-flagged attempt: a flagged intent
    // must never reach the model, and its fixed in-character refusal stands.
    if (!ar || ar.policyViolation) {
      return null;
    }
    // A scripted (test-hook) attempt keeps its deterministic narration so the
    // self-play harness can assert narration↔state agreement without a live model.
    if (resolved.action?.scriptedAttempt === true) {
      return null;
    }
    // IMPOSSIBILITY / AUTHORITY GATE refusal: the server already refused this
    // intent pre-roll (reality-breaking / authority-by-fiat / summon-from-nothing /
    // retconned loot). The action did NOT and CANNOT succeed. Steer the GM to
    // narrate the world simply NOT complying — grounded, in-fiction, atmospheric —
    // never a system error, never a scolding, never secretly letting it work.
    if (ar.gated === true) {
      return (
        `In the current scene, the player tries something the world will not allow: "${String(ar.intent || "an action")}". ` +
        `This does NOT happen and CANNOT happen — reality does not bend, no item appears, no power answers, no one is compelled. ` +
        `Narrate ONLY the world quietly refusing to comply, grounded in the fiction (e.g. the words die in the air, the hand closes on nothing). ` +
        `Do NOT let it succeed even partially, do NOT mock the player, do NOT mention rules or systems. ${suffix}`
      );
    }
    const cr = ar.checkResult;
    const rollText = cr && cr.total !== undefined && cr.total !== null ? ` (rolled ${cr.total} vs DC ${cr.dc})` : "";
    return (
      `In the current scene, the player attempts: "${String(ar.intent || "an action")}". ` +
      `The attempt ${ar.success ? "succeeds" : "fails"}${rollText}. ${suffix}`
    );
  }

  if (type === "move") {
    return (
      `The player travels to ${isString(loc.name) ? loc.name : "a new place"}` +
      `${isString(loc.description) ? `: ${loc.description}` : ""}. ` +
      `Narrate arriving there — what they see, hear, and sense. ${suffix}`
    );
  }

  if (type === "talk") {
    const tr = resolved.talkResult;
    if (!tr) {
      return null;
    }
    const npc = (run?.npcs || {})[tr.npcId] || {};
    const speaker = isString(tr.speakerName) ? tr.speakerName : isString(npc.displayName) ? npc.displayName : "the figure";
    const persona = isString(npc.personality) ? ` Their manner: ${npc.personality}.` : "";
    const appearance = isString(npc.appearance) ? ` Appearance: ${npc.appearance}.` : "";

    // Reply turn: the player typed something. Voice an in-character ANSWER to what
    // they said, grounded in the conversation so far — never a re-run of the intro
    // greeting. (Initial approach carries no message and keeps the beat behavior.)
    const playerMessage = isString(resolved.action?.message) ? resolved.action.message.trim() : "";
    if (playerMessage) {
      const turns = Array.isArray(resolved.action?.history) ? resolved.action.history : [];
      const transcript = turns
        .filter((turn) => turn && isString(turn.text))
        .slice(-8)
        .map((turn) => `${turn.role === "player" ? "Player" : speaker}: ${turn.text.trim()}`)
        .join("\n");
      const beatHint = tr.found && isString(tr.line) ? ` ${speaker} may draw on what they know: "${tr.line}".` : "";
      // INVENTED-CANON GUARD (hardened, state-backed): the NPC must not let the
      // player's words rewrite the world. The guard carries the GROUND TRUTH from
      // run-state (a real relationship is honored; its absence is explicit) plus
      // the discipline (don't accept invented history/relationships/promises;
      // don't grant compliance on an unverified claim alone). See buildNpcCanonGuard.
      const canonGuard = buildNpcCanonGuard(run, npc, speaker);
      return (
        `The player is mid-conversation with ${speaker}.${persona}${appearance} ` +
        `${transcript ? `Conversation so far:\n${transcript}\n` : ""}` +
        `The player just said to them: "${playerMessage}". ` +
        `Respond AS ${speaker}, in character, directly answering or reacting to what the player just said. ` +
        `Do NOT repeat an earlier greeting or a line already spoken; advance the exchange.${beatHint}${canonGuard} ` +
        `Voice ${speaker}'s spoken reply (1-3 sentences of dialogue), then a brief line of narration. ${suffix}`
      );
    }

    const content =
      tr.found && isString(tr.line)
        ? `They have something specific to say: "${tr.line}".`
        : "This is a brief first exchange; nothing momentous is revealed.";
    // The same invented-canon discipline applies to the opening exchange: even a
    // first line must not confirm a fabricated bond the player leads with.
    const canonGuard = buildNpcCanonGuard(run, npc, speaker);
    return (
      `The player speaks with ${speaker}.${persona}${appearance} ${content}${canonGuard} ` +
      `Voice ${speaker}'s spoken reply in-character (1-3 sentences of dialogue), then a brief line of narration. ${suffix}`
    );
  }

  if (type === "search") {
    const sr = resolved.searchResult;
    return (
      `The player searches ${isString(loc.name) ? loc.name : "the area"}. ` +
      `${sr && sr.found ? `They discover: ${sr.summary}.` : "They turn up nothing of obvious importance."} ` +
      `Narrate what they notice as they look. ${suffix}`
    );
  }

  if (type === "rest") {
    const rr = resolved.restResult;
    const kind = rr && rr.restType === "long" ? "a long rest" : "a short rest";
    const blocked = rr && rr.allowed === false ? " But it is not truly safe to rest here." : "";
    return (
      `The player takes ${kind} at ${isString(loc.name) ? loc.name : "this place"}.${blocked} ` +
      `Narrate the passage of time and how they feel. ${suffix}`
    );
  }

  if (type === "use_item") {
    const ur = resolved.useItemResult;
    return (
      `The player uses ${ur && isString(ur.itemName) ? ur.itemName : "an item"}. ` +
      `${ur && isString(ur.summary) ? ur.summary : ""} Narrate the effect. ${suffix}`
    );
  }

  return null; // inspect / unknown -> no narration
}

/**
 * Builds the opening-arrival GM prompt for a freshly created world run. Pure.
 * @param {{characterName?:string, race?:string, characterClass?:string, world?:object, npc?:object|null}} input
 * @returns {string}
 */
export function buildOpeningGmMessage({ characterName, race, characterClass, world = {}, npc = null, npcReason = null, baseBuilding = false, questObjective = null } = {}) {
  const name = isString(characterName) ? characterName : "the wanderer";
  const descriptor = [race, characterClass].filter((part) => isString(part)).join(" ");
  const who = descriptor ? `${name}, a ${descriptor},` : name;
  const tone = isString(world.tone) ? world.tone : "dark fantasy";
  const loc = world.startingLocation || {};
  const locLine = isString(loc.name)
    ? `${loc.name}${isString(loc.description) ? `: ${loc.description}` : ""}`
    : "an unfamiliar place";
  const worldLine = isString(world.description) ? ` The wider world: ${world.description}` : "";
  // Presence is justified, not assumed. With an NPC, hint at them AND why they're
  // here (their reason). With nobody, state the player is ALONE so the GM never
  // invents a contextless stranger.
  const npcHint =
    npc && isString(npc.generatedName)
      ? ` ${npc.generatedName}${isString(npc.role) ? `, the ${npc.role},` : ""} is also here${isString(npcReason) ? ` because ${npcReason}` : ""}. Hint at their presence and make the reason they are here feel natural; do not force a conversation.`
      : " The player is ALONE here — do NOT introduce any other person, figure, or stranger.";
  // Base-building: for an adoptable ruin/abandoned start, explicitly offer the
  // place as a foothold the player could claim and develop over time.
  const baseLine = baseBuilding
    ? " Make clear this place is defensible and unclaimed — a foothold they could shelter in and, over time, rebuild into a base of their own. Offer that possibility; do not decide it for them."
    : "";
  // The hook: tie the opening to the main quest's first objective so the player
  // leaves with a reason to move — without the GM resolving or inventing it.
  const hookLine = isString(questObjective)
    ? ` A pull toward purpose hangs in the air — ${questObjective} Hint at this hook in the fiction; do not resolve it.`
    : "";
  return (
    `${who} arrives at ${locLine}.${worldLine} ` +
    `Narrate their arrival in 3-5 vivid sentences of second-person ${tone} prose, grounding them in the atmosphere of the scene.${npcHint}${baseLine}${hookLine} ` +
    "End by leaving the moment open and unspoken — theirs to act on. Do not use bracketed trigger tags."
  );
}

// Deterministic, tone-aware opening used when the GM call fails, times out, or is
// disabled. Always a real welcoming opening (arrival + atmosphere + hook + a beat
// handing the moment to the player) — never a blank or a bare location dump.
export function buildOpeningFallback({ characterName, race, characterClass, world = {}, location = {}, baseBuilding = false, questObjective = null } = {}) {
  const name = isString(characterName) ? characterName : "Wanderer";
  const descriptor = [race, characterClass].filter((part) => isString(part)).join(" ");
  const who = descriptor ? `${name}, ${descriptor}` : name;
  const tone = isString(world.tone) ? world.tone : "dark fantasy";
  const worldName = isString(world.name) ? world.name : "this world";
  const placeName = isString(location.name)
    ? location.name
    : isString(world.startingLocationName)
      ? world.startingLocationName
      : "an unfamiliar place";
  const placeDesc = isString(location.description)
    ? location.description
    : isString(world.startingLocation?.description)
      ? world.startingLocation.description
      : "";
  const sentences = [
    `You are ${who}, and the ${tone} of ${worldName} settles over you as you arrive at ${placeName}.`,
    placeDesc || "The place watches you in silence, every shadow holding its own weight.",
    // Base-building beat for an adoptable start: name the option without taking it.
    baseBuilding
      ? "No one holds this ground. You could make it yours — shelter here, and in time build it into a foothold of your own."
      : "",
    isString(questObjective)
      ? `Something tugs at the edge of your purpose: ${questObjective}`
      : "Whatever brought you here, it has not finished with you yet.",
    "The moment is yours now — what do you do?"
  ];
  return sentences.filter(Boolean).join(" ");
}
