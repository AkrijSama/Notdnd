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
    if (!ar) {
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
export function buildOpeningGmMessage({ characterName, race, characterClass, world = {}, npc = null } = {}) {
  const name = isString(characterName) ? characterName : "the wanderer";
  const descriptor = [race, characterClass].filter((part) => isString(part)).join(" ");
  const who = descriptor ? `${name}, a ${descriptor},` : name;
  const tone = isString(world.tone) ? world.tone : "dark fantasy";
  const loc = world.startingLocation || {};
  const locLine = isString(loc.name)
    ? `${loc.name}${isString(loc.description) ? `: ${loc.description}` : ""}`
    : "an unfamiliar place";
  const worldLine = isString(world.description) ? ` The wider world: ${world.description}` : "";
  const npcHint =
    npc && isString(npc.generatedName)
      ? ` Hint at the presence of ${npc.generatedName}${isString(npc.role) ? `, the ${npc.role}` : ""}, without forcing a conversation.`
      : "";
  return (
    `${who} arrives at ${locLine}.${worldLine} ` +
    `Narrate their arrival in 3-5 vivid sentences of second-person ${tone} prose, grounding them in the scene.${npcHint} ` +
    "Do not use bracketed trigger tags."
  );
}
