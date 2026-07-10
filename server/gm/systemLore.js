// ---------------------------------------------------------------------------
// SYSTEM LORE — committed world-law facts about the VOICE and the WINDOW.
//
// Canon (owner ruling, Jul 10): the VOICE and the WINDOW never lie — and they
// never do anything beyond their committed capabilities. Live-observed
// violation: the GM narrated "The window will remember what direction you go"
// — the STATUS WINDOW has no memory. This module is the ONE source of truth
// the prompt grounding clause AND the live auditor both read, so the does/
// does-not split can never drift between them.
// ---------------------------------------------------------------------------

export const SYSTEM_LORE = Object.freeze({
  window: Object.freeze({
    what: "The WINDOW is a diegetic status display granted by the VOICE — a pane of light only the champion perceives.",
    does: Object.freeze([
      "displays the character's six measures (status)",
      "displays level and growth",
      "displays the tracked objective",
      "updates to reflect committed state when read"
    ]),
    doesNot: Object.freeze(["remember", "advise", "predict", "watch", "speak", "warn", "guide", "decide", "judge", "listen"])
  }),
  voice: Object.freeze({
    what: "The VOICE is the power that brought the champion here. It spoke once at the arrival and speaks rarely, if ever, again.",
    does: Object.freeze(["spoke the arrival orientation", "granted the WINDOW"]),
    doesNot: Object.freeze(["lie", "advise", "predict", "watch", "answer", "intervene", "command"])
  })
});

// The grounding clause every narration path that could mention the VOICE or
// WINDOW receives. Built from the constant above — never hand-written twice.
export function buildSystemLoreClause() {
  const w = SYSTEM_LORE.window;
  const v = SYSTEM_LORE.voice;
  return (
    ` SYSTEM LORE (committed world-law — never contradict): ${w.what} It ONLY ${w.does.join("; ")}. ` +
    `It does NOT ${w.doesNot.join(", ")} — never attribute any of those to the window. ` +
    `${v.what} It does NOT ${v.doesNot.join(", ")}. ` +
    `If the player asks what the window or voice can do, answer strictly from these facts.`
  );
}

// --- LIVE AUDITOR CHECK ------------------------------------------------------
// Flags narration that attributes to the WINDOW or VOICE a capability from its
// does-NOT list: the pattern is window/voice as the grammatical subject of a
// capability verb ("the window will remember…", "the voice watches…"). A
// NEGATED attribution ("the window does not remember") is the lore stated
// correctly and is never flagged. Pure; returns [{ subject, verb, sentence }].
const VERB_FORMS = (verbs) => verbs.map((v) => `${v}(?:es|s)?`).join("|");
const WINDOW_VERBS = VERB_FORMS([...SYSTEM_LORE.window.doesNot]);
const VOICE_VERBS = VERB_FORMS([...SYSTEM_LORE.voice.doesNot]);

function violationRe(subject, verbs) {
  // subject … (aux) verb, within one clause (no sentence punctuation between).
  return new RegExp(
    `\\b(${subject})\\b(?![^.!?]{0,60}\\b(?:not|never|cannot|can['’]t|won['’]t|doesn['’]t|does not|will not)\\b[^.!?]{0,20}\\b(?:${verbs})\\b)[^.!?]{0,60}?\\b(?:will\\s+|would\\s+|can\\s+|shall\\s+|is\\s+going\\s+to\\s+)?(${verbs})\\b`,
    "gi"
  );
}
const WINDOW_RE = violationRe("window", WINDOW_VERBS);
const VOICE_RE = violationRe("voice", VOICE_VERBS);

export function detectSystemLoreViolations(narrationText) {
  const text = String(narrationText || "");
  if (!text.trim()) {
    return [];
  }
  const out = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const re of [WINDOW_RE, VOICE_RE]) {
      re.lastIndex = 0;
      const m = re.exec(sentence);
      if (m) {
        out.push({ subject: m[1].toLowerCase(), verb: m[2].toLowerCase(), sentence: sentence.trim().slice(0, 160) });
      }
    }
  }
  return out;
}
