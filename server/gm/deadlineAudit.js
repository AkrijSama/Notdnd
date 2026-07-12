// DEADLINE-REFERENT LAW (item 4, bucket-2 — owner design ruling): narrated
// urgency must bind to committed state. Time-boxed pressure ("you have five
// minutes", "before nightfall") may only be narrated when a committed clock
// deadline backs it; pressure without a referent must be qualitative ("the smoke
// is thickening") with no invented countdown.
//
// COMMITTED DEADLINE REFERENTS (what exists in run state): (a) a timed player
// condition (finite expiresAtMinutes); (b) an ACTIVE THREAD carrying a committed
// world-clock deadline (thread.clock.expiresAtMinutes) — the momentum engine now
// commits the deadline WITH the stakes (D.5 item 3), so time-boxed narration bound
// to a thread's clock ("before the danger breaks") is lawful. Momentum objectStates
// still carry no expiry (they escalate qualitatively, not on a countdown).
//
// The live auditor is the same severity class as narrated-state drift /
// system-lore violations: detect -> flag loudly in the turn log. Same shape as
// detectSystemLoreViolations (sentence-scoped regex, pure, no I/O).

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A specific, countable time budget asserted in prose. Number words cover the
// owner's live case ("maybe five minutes to decide").
const NUM = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|\\d+)";
const UNIT = "(?:second|seconds|minute|minutes|hour|hours|moment|moments|heartbeat|heartbeats|breath|breaths)";
const TIME_BOX_RES = [
  // "you have (maybe) five minutes (to decide / left / before ...)"
  new RegExp(`\\b(?:you|there)(?:'ve| have| has|'s)?[^.!?]{0,24}\\b${NUM}\\s+${UNIT}\\b[^.!?]{0,50}\\b(?:to\\s+\\w+|left|remain(?:ing|s)?|before|until|at (?:best|most))`, "i"),
  // "maybe/perhaps/about five minutes to decide" (no leading "you have")
  new RegExp(`\\b(?:maybe|perhaps|about|barely|scarcely|at most|no more than|less than|only)\\s+${NUM}\\s+${UNIT}\\b[^.!?]{0,50}\\b(?:to\\s+\\w+|left|remain(?:ing|s)?|before|until)`, "i"),
  // "five minutes, no more" / "minutes remain"
  new RegExp(`\\b${NUM}\\s+${UNIT},?\\s+(?:no more|at best|if that)`, "i"),
  // event-boundary countdowns: "before nightfall/dawn/the bell tolls"
  /\bbefore (?:nightfall|night falls|dawn|daybreak|sunset|sundown|sunrise|midnight|the sun (?:sets|rises)|the bell(?:s)? (?:toll|ring)s?)\b/i,
  // explicit countdown assertions
  /\b(?:time is running out|you're running out of time|the clock is ticking(?: down)?)\b/i
];

// Does committed state back a countdown right now? Timed player conditions are
// the engine's only clock-backed deadline today (see header note).
export function hasCommittedDeadlineReferent(run) {
  const now = Number(run?.world?.time?.minutes);
  // A future expiry is a live countdown; without a readable clock, any finite expiry
  // counts (it is still committed, ticking state).
  const isLiveExpiry = (exp) => (typeof exp === "number" && Number.isFinite(exp) ? (Number.isFinite(now) ? exp > now : true) : false);

  // (a) timed player conditions.
  const player = run && isPlainObject(run.player) ? run.player : null;
  const conditions = player && Array.isArray(player.conditions) ? player.conditions : [];
  if (conditions.some((entry) => isPlainObject(entry) && isLiveExpiry(entry.expiresAtMinutes))) return true;

  // (b) active thread deadlines (D.5 item 3) — the momentum engine's committed clock.
  const threads = isPlainObject(run?.threads) ? Object.values(run.threads) : [];
  return threads.some((t) => isPlainObject(t) && t.status === "active" && isLiveExpiry(t.clock?.expiresAtMinutes));
}

/**
 * Flags narrated time-boxed pressure with no committed deadline referent.
 * Pure. Returns [{ phrase, sentence }] — empty when clean or when a committed
 * referent legitimizes the pressure.
 */
export function detectDeadlineViolations(narrationText, run) {
  const text = String(narrationText || "");
  if (!text.trim()) {
    return [];
  }
  if (hasCommittedDeadlineReferent(run)) {
    return []; // a committed countdown exists — time-boxed narration is legitimate
  }
  const out = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const re of TIME_BOX_RES) {
      const m = re.exec(sentence);
      if (m) {
        out.push({ phrase: m[0].slice(0, 80), sentence: sentence.trim().slice(0, 160) });
        break; // one flag per sentence
      }
    }
  }
  return out;
}
