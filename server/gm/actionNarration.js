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
      return (
        `The player is mid-conversation with ${speaker}.${persona}${appearance} ` +
        `${transcript ? `Conversation so far:\n${transcript}\n` : ""}` +
        `The player just said to them: "${playerMessage}". ` +
        `Respond AS ${speaker}, in character, directly answering or reacting to what the player just said. ` +
        `Do NOT repeat an earlier greeting or a line already spoken; advance the exchange.${beatHint} ` +
        `Voice ${speaker}'s spoken reply (1-3 sentences of dialogue), then a brief line of narration. ${suffix}`
      );
    }

    const content =
      tr.found && isString(tr.line)
        ? `They have something specific to say: "${tr.line}".`
        : "This is a brief first exchange; nothing momentous is revealed.";
    return (
      `The player speaks with ${speaker}.${persona}${appearance} ${content} ` +
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
