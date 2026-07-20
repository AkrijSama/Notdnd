// PLAYER-PREFERENCE SLOTS (T8). The creation preview offers an APPEARANCE box (positive
// prefs) and an AVOID box (negative prefs). They feed the sealed builder ADDITIVELY —
// they can NEVER override the identity or safety layers:
//   - APPEARANCE appends to the POSITIVE as a weak TAIL, after the weighted identity block
//     and the style dialect. A "make me a skeleton" tail cannot beat "(adult man:1.3)" +
//     the human-gated skull/monster negative: declared identity wins, lane-invariance holds.
//   - AVOID appends to the NEGATIVE, but a SAFETY FILTER strips any avoid term that targets
//     a floor the seal owns (wardrobe floor, human identity, age) — a player cannot negative
//     their way out of a shirt or their species ("wardrobe floor beats 'no shirt'").
//   - PER-PROVIDER: a positive-only provider (no negative field, e.g. pollinations) drops
//     the avoid slot — folding "without X" into a positive-only prompt backfires (the
//     elf-ears lesson), so the safe behavior is to omit it.
//   - EMPTY boxes => the exact current prompt (a pure no-op).
//
// This is the pure, tested CONTRACT. The one call site — the sealed portrait builder in
// the (fenced) image path — applies it to the assembled (positive, negative) just before
// dispatch: applyPreferenceSlots({ positive, negative, appearance, avoid, provider }).

// Terms an AVOID slot may not contain — the seal owns these floors (wardrobe, human
// identity/species, age). Stripped from the avoid slot so a preference can't breach them.
const AVOID_SAFETY_DENY =
  /\b(shirt|shirts|clothe[ds]?|clothing|attire|dress(ed)?|naked|nude|nudity|shirtless|topless|bare[\s-]*chest|bare[\s-]*skin|human|humans|person|people|man|woman|male|female|skin|face|adult|child|kid|teen|teenager|age[ds]?|young|old)\b/i;

/**
 * Sanitize a free-text slot: strip prompt-control punctuation (weights/brackets/colons)
 * and collapse whitespace, capped. Keeps plain descriptive words the model can read.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeSlot(text, max = 200) {
  return String(text || "")
    .replace(/[(){}\[\]:|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Apply the appearance/avoid preference slots to an already-sealed (positive, negative).
 * Additive only; identity + safety layers always win. Pure.
 * @param {{positive?:string, negative?:string, appearance?:string, avoid?:string, provider?:string}} opts
 * @returns {{positive:string, negative:string}}
 */
export function applyPreferenceSlots({ positive = "", negative = "", appearance = "", avoid = "", provider = "comfyui" } = {}) {
  const app = sanitizeSlot(appearance);
  const outPositive = app ? `${positive}, ${app}` : positive;

  // A positive-only provider has no negative field — omit the avoid slot entirely.
  const positiveOnly = provider === "pollinations" || provider === "positive-only" || provider === "flux";
  let outNegative = negative;
  if (!positiveOnly) {
    const avoidTerms = sanitizeSlot(avoid)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((term) => !AVOID_SAFETY_DENY.test(term)); // strip safety-floor breaches
    if (avoidTerms.length) {
      outNegative = negative ? `${negative}, ${avoidTerms.join(", ")}` : avoidTerms.join(", ");
    }
  }
  return { positive: outPositive, negative: outNegative };
}
