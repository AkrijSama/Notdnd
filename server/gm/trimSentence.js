// ---------------------------------------------------------------------------
// SENTENCE-BOUNDARY TRIM (owner ruling, Jul 11: sentence-boundary-trim).
//
// Flash writes to the max_tokens ceiling; when the model DID NOT stop itself but
// was cut by the cap (finish_reason === "length"), the tail is a partial sentence
// or an unclosed quote — the live failures 'The Woman sees you notice. "That's
// new', "Old Marta's", "The offer to sit is not". A beheaded quote is worse than
// no quote, so we trim BACKWARD to the last complete unit.
//
// This is an ENFORCEMENT mechanism only — it never changes the cap or the prose
// contract. A NORMAL finish (the model stopped itself) is passed through
// untouched: we only repair what the ceiling severed, detected from the
// provider's finish_reason (never inferred from the text).
// ---------------------------------------------------------------------------

// True only when the generation was cut by the token ceiling (provider-reported),
// across the finish-reason spellings OpenRouter/its upstreams use.
export function isLengthCut(finishReason) {
  const r = String(finishReason || "").trim().toLowerCase();
  return r === "length" || r === "max_tokens" || r === "max_output_tokens" || r === "token_limit" || r === "max_completion_tokens";
}

// Walk the text tracking DOUBLE-quote dialogue state (straight " toggles; curly
// “ opens, ” closes). Apostrophes/single quotes ("That's") are NOT delimiters, so
// they never confuse the analysis. Returns whether the text ends INSIDE an open
// quote and the index where that still-open quote opened.
function analyzeQuotes(text) {
  let inQuote = false;
  let lastOpenIndex = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (!inQuote) { inQuote = true; lastOpenIndex = i; } else { inQuote = false; }
    } else if (ch === "“") { // left double quote
      inQuote = true;
      lastOpenIndex = i;
    } else if (ch === "”") { // right double quote
      inQuote = false;
    }
  }
  return { inQuote, lastOpenIndex };
}

// The index just AFTER the last sentence terminator (. ! ?, plus any trailing
// closing quote/paren) that sits at a real boundary (end of region or followed by
// whitespace). Returns -1 when the region has no complete sentence.
function lastSafeSentenceEnd(region) {
  const re = /[.!?]+["'”’)\]]*/g;
  let last = -1;
  let m;
  while ((m = re.exec(region)) !== null) {
    const end = m.index + m[0].length;
    if (end === region.length || /\s/.test(region[end])) {
      last = end;
    }
  }
  return last;
}

/**
 * Trim a length-capped generation back to its last COMPLETE sentence.
 *  - finish_reason NOT a length cut (or no text) -> passed through untouched.
 *  - ended INSIDE an unclosed quote -> drop the partial quote entirely; trim to
 *    the last complete sentence BEFORE the quote opened.
 *  - otherwise -> trim to the last sentence terminator (dropping a dangling
 *    partial tail); a text already ending at a terminator is unchanged.
 *  - >40% removed -> keep the trim, but log a warning (cap too tight — tuning data).
 *  - never returns empty when the input had content (safety valve).
 * Pure (except the warning log); never throws.
 * @param {string} text the raw generated narration
 * @param {string|null} finishReason provider finish_reason for this generation
 * @param {{ onWarn?: (msg: string) => void }} [options]
 * @returns {string}
 */
export function trimToCompleteSentence(text, finishReason, options = {}) {
  const original = typeof text === "string" ? text : "";
  if (!original.trim() || !isLengthCut(finishReason)) {
    return original;
  }

  const { inQuote, lastOpenIndex } = analyzeQuotes(original);
  // When we ended inside an unclosed quote, only look for a complete sentence
  // BEFORE that quote opened — the beheaded quote is dropped whole.
  const searchEnd = inQuote && lastOpenIndex >= 0 ? lastOpenIndex : original.length;
  const region = original.slice(0, searchEnd);
  const cut = lastSafeSentenceEnd(region);

  if (cut <= 0) {
    // No complete sentence found before the cut point. If we were mid-quote,
    // dropping the partial quote is still correct even if little remains; but
    // never emit empty narration — fall back to the original in that pathology.
    const fallback = inQuote ? region.trimEnd() : original;
    return fallback.trim() ? fallback : original;
  }

  const trimmed = original.slice(0, cut).trimEnd();
  if (!trimmed.trim()) {
    return original; // safety valve: never blank a turn
  }
  if (trimmed.length < original.length * 0.6) {
    const warn = options.onWarn || ((msg) => console.warn(msg));
    warn(
      `[GM] trimToCompleteSentence removed >40% of a length-cut generation ` +
        `(${original.length} -> ${trimmed.length} chars) — the max_tokens cap is likely too tight for this turn.`
    );
  }
  return trimmed;
}
