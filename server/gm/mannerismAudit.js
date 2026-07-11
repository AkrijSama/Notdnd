// ---------------------------------------------------------------------------
// MANNERISM / SPIT AUDITOR (owner law, Jul 11: spit-ban-and-mannerisms).
//
// (1) SPIT BAN — absolute, all worlds/characters. Narration in which a character
//     spits is a violation; the surgical repair drops the offending gesture (the
//     same "server owns the truth, repair the prose" class as pronoun repair).
// (2) REPETITION GUARD — cheap + general: the SAME physical-gesture phrase reused
//     across a session (the next stock tic after spit, whatever it is) is flagged.
// Pure; no state — the caller persists the running gesture signatures on the run.
// ---------------------------------------------------------------------------

// A character SPITTING — the verb forms + spittle. "spite"/"despite"/"in spite
// of" never match (\bspit\b has no boundary before the 'e'). A roasting "spit"
// (noun) is a rare false positive worth the absolute ban.
const SPIT_RE = /\bspat\b|\bspit(?:s|ting)?\b|\bspittle\b/i;

// Split on a terminator, including one tucked inside a closing quote/paren
// ('… late." Then …' is two sentences), so a gesture beat is isolated cleanly.
function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?]["'”’)\]]?)\s+/);
}

// Sentences in which a character spits. Returns [{ sentence }]. Pure.
export function detectSpitViolations(narrationText) {
  const text = String(narrationText || "");
  if (!text.trim()) {
    return [];
  }
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (SPIT_RE.test(sentence)) {
      out.push({ sentence: sentence.trim().slice(0, 200) });
    }
  }
  return out;
}

// Surgical repair: drop every sentence that contains a spit gesture. A gesture
// beat is almost always its own short sentence ("He spits to the side."), so
// removing the sentence excises the banned action without mangling the rest.
// Returns { text, removed:[…] }; never returns empty when the input had other
// sentences (a whole-narration spit is left to the contract, not blanked here).
export function stripSpitGestures(narrationText) {
  const text = String(narrationText || "");
  if (!text.trim() || !SPIT_RE.test(text)) {
    return { text, removed: [] };
  }
  const sentences = splitSentences(text);
  const removed = [];
  const kept = sentences.filter((sentence) => {
    if (SPIT_RE.test(sentence)) {
      removed.push(sentence.trim());
      return false;
    }
    return true;
  });
  const rebuilt = kept.join(" ").replace(/\s+/g, " ").trim();
  // Safety valve: if stripping left nothing (the whole narration was spitting),
  // keep the original — the contract ban + a logged violation handle that case.
  return rebuilt ? { text: rebuilt, removed } : { text, removed };
}

// --- REPETITION GUARD --------------------------------------------------------
// A committed/stock physical gesture, normalized so the SAME tic reads the same
// no matter which character (subject) performs it. We look for a physical-action
// verb + its short object, strip the subject, and lowercase — "Marta narrows her
// eyes" and "Soren narrows his eyes" both signature as "narrows eyes".
const GESTURE_VERBS =
  "spits?|spat|narrows?|rubs?|scratch(?:es)?|taps?|folds?|cracks?|clenches?|grinds?|shrugs?|nods?|winks?|smirks?|snorts?|sniffs?|drums?|clicks?|rolls?|purses?|licks?|bites?|grips?|wrings?|twists?|flexes?|picks?";
const GESTURE_RE = new RegExp(`\\b(${GESTURE_VERBS})\\b([^.!?,;]{0,40})`, "gi");
// Subject / grammatical filler stripped so the SAME tic reads the same regardless
// of who performs it or the trailing prose ("narrows her eyes at the ledger" and
// "narrows his eyes and says nothing" both signature to "narrow eyes").
const STOPWORDS = new Set([
  "his", "her", "their", "its", "the", "a", "an", "one", "at", "to", "into", "in",
  "on", "of", "and", "but", "with", "up", "down", "back", "side", "then", "as", "he", "she", "they"
]);

// Normalized gesture signatures present in a narration: verb (de-pluralized) + its
// first content word (the object), so a stock gesture repeats identically across
// characters. Pure.
export function extractGestureSignatures(narrationText) {
  const text = String(narrationText || "");
  if (!text.trim()) {
    return [];
  }
  const sigs = new Set();
  let m;
  GESTURE_RE.lastIndex = 0;
  while ((m = GESTURE_RE.exec(text)) !== null) {
    const verb = m[1].toLowerCase().replace(/s$/, ""); // narrows -> narrow, spits -> spit
    const object = m[2]
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w))
      .slice(0, 1);
    if (object.length >= 1) {
      sigs.add(`${verb} ${object[0]}`);
    }
  }
  return [...sigs];
}

// Flags gesture signatures in THIS narration that already appeared earlier in the
// session (priorSignatures) — the stock tic spreading across characters. Pure;
// returns { repeated:[…], signatures:[…] } where `signatures` is the merged set to
// persist for the next turn.
export function detectRepeatedGestures(narrationText, priorSignatures = []) {
  const prior = new Set((Array.isArray(priorSignatures) ? priorSignatures : []).map((s) => String(s || "").trim()).filter(Boolean));
  const current = extractGestureSignatures(narrationText);
  const repeated = current.filter((sig) => prior.has(sig));
  const merged = [...prior, ...current];
  // Cap the persisted set so a long run doesn't grow it unbounded.
  const signatures = merged.slice(Math.max(0, merged.length - 200));
  return { repeated, signatures };
}
