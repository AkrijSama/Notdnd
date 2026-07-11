// ---------------------------------------------------------------------------
// DIALOGUE-ALWAYS-VN (owner law, Jul 11). ALL dialogue goes to the VN screen.
// Typed quoted speech is CONVERSATION, never a log-attempt: it opens the VN with
// the addressed NPC and NEVER rolls. A line that mixes speech with an action
// («"Wait!" I grab his arm») splits — the quote to the VN, the action through the
// normal resolver — in one turn. Pure helpers here; the wiring is in actions.js.
// ---------------------------------------------------------------------------

function isString(value) {
  return typeof value === "string";
}

// Present, alive, known NPCs at the run's current location (the conversation pool).
function presentNpcs(run) {
  const npcs = run && typeof run.npcs === "object" && run.npcs ? Object.values(run.npcs) : [];
  const here = run?.currentLocationId;
  return npcs.filter((npc) => npc && npc.currentLocationId === here && npc.status !== "dead");
}

function npcName(npc) {
  if (isString(npc?.generatedName) && npc.generatedName.trim()) return npc.generatedName.trim();
  return isString(npc?.displayName) ? npc.displayName.trim() : "";
}

// Quoted spans that denote SPOKEN words: straight "…", curly “…”, and a
// leading/standalone '…' single-quote span (apostrophes inside words — "don't",
// "Marta's" — are NOT treated as delimiters because a single-quote span must be
// bounded by whitespace/edges on the OPENING side).
const DOUBLE_SPAN_RE = /"([^"]*)"|“([^”]*)”/g;
const SINGLE_SPAN_RE = /(^|\s)'([^']*)'(?=\s|[.!?,]|$)/g;

// Extract the spoken text (quoted) and the non-quoted remainder (a possible
// action). Returns { hasQuote, spokenText, remainder }.
export function extractQuotedSpeech(intent) {
  const text = isString(intent) ? intent : "";
  if (!text.trim()) {
    return { hasQuote: false, spokenText: "", remainder: "" };
  }
  const spoken = [];
  let remainder = text;

  remainder = remainder.replace(DOUBLE_SPAN_RE, (_m, a, b) => {
    const inner = a !== undefined ? a : b;
    if (isString(inner) && inner.trim()) spoken.push(inner.trim());
    return " ";
  });
  remainder = remainder.replace(SINGLE_SPAN_RE, (_m, lead, inner) => {
    if (isString(inner) && inner.trim()) spoken.push(inner.trim());
    return lead || " ";
  });

  return {
    hasQuote: spoken.length > 0,
    spokenText: spoken.join(" ").trim(),
    remainder: remainder.replace(/\s+/g, " ").trim()
  };
}

// A non-quoted remainder is a REAL ACTION (not mere speech scaffolding) when it
// carries a physical/interaction verb. "I grab his arm" -> action; "I say", "she
// asks", "" -> not an action (pure speech). Deliberately physical-verb-gated so a
// speech dialogue tag never spawns a phantom attempt.
const ACTION_REMAINDER_RE =
  /\b(grab|grabs|grabbed|seize|seizes|take|takes|took|snatch|draw|draws|drew|pull|pulls|push|pushes|shove|shoves|strike|strikes|hit|hits|punch|kick|kicks|swing|swings|throw|throws|hurl|stab|slash|cut|cuts|reach|reaches|reached|grip|grips|grasp|lunge|lunges|step|steps|stepped|move|moves|moved|walk|walks|run|runs|ran|climb|climbs|jump|jumps|leap|dodge|dodges|duck|ducks|block|blocks|parry|open|opens|opened|close|closes|slam|slams|point|points|raise|raises|lower|lowers|hand|hands|handed|give|gives|gave|drop|drops|dropped|draw|pick|picks|slip|slips|sneak|hide|hides|attack|attacks|shoot|shoots|fire|fires|cast|casts|search|searches|grabbing)\b/i;

export function hasActionRemainder(remainder) {
  const t = isString(remainder) ? remainder.trim() : "";
  if (!t) return false;
  return ACTION_REMAINDER_RE.test(t);
}

// Resolve WHO the player is addressing, per the owner law's priority:
//  1. explicit address — a present NPC named in the line ("to Marta", "Marta, …");
//  2. an active VN session — the current speaker (run.vn.speakerId), if present;
//  3. exactly one present NPC — them;
//  4. ambiguous multi-NPC with no address — the last-interacted present NPC
//     (run.flags.lastSpokenToNpcId), else the first present NPC (deterministic).
// Returns the raw npcId, or null when there is no one present to address.
export function resolveConversationSpeaker(run, intent) {
  const present = presentNpcs(run);
  if (!present.length) {
    return null;
  }
  const text = isString(intent) ? intent : "";

  // 1) explicit address: a present NPC named in the line.
  const named = present.filter((npc) => {
    const name = npcName(npc);
    if (name.length < 3) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // match the first name token too ("Marta" for "Old Marta")
    const first = name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text) || new RegExp(`\\b${first}\\b`, "i").test(text);
  });
  if (named.length === 1) {
    return named[0].npcId;
  }
  if (named.length > 1) {
    // several named — prefer the active-VN speaker among them, else the last-
    // interacted among them, else the first named (deterministic, header shows it).
    const active = run?.vn?.active && isString(run.vn.speakerId) ? stripNpcPrefix(run.vn.speakerId) : null;
    if (active && named.some((n) => n.npcId === active)) return active;
    const last = isString(run?.flags?.lastSpokenToNpcId) ? run.flags.lastSpokenToNpcId : null;
    if (last && named.some((n) => n.npcId === last)) return last;
    return named[0].npcId;
  }

  // 2) active VN session — continue with the current speaker if still present.
  const activeSpeaker = run?.vn?.active && isString(run.vn.speakerId) ? stripNpcPrefix(run.vn.speakerId) : null;
  if (activeSpeaker && present.some((npc) => npc.npcId === activeSpeaker)) {
    return activeSpeaker;
  }

  // 3) exactly one present NPC.
  if (present.length === 1) {
    return present[0].npcId;
  }

  // 4) ambiguous — the last-interacted present NPC, else the first present NPC.
  const last = isString(run?.flags?.lastSpokenToNpcId) ? run.flags.lastSpokenToNpcId : null;
  if (last && present.some((npc) => npc.npcId === last)) {
    return last;
  }
  return present[0].npcId;
}

function stripNpcPrefix(id) {
  const s = isString(id) ? id : "";
  return s.startsWith("npc:") ? s.slice("npc:".length) : s;
}
