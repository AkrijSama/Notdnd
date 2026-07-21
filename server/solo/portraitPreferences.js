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

// ── AVOID NORMALIZATION (WALK-3 V4) ──────────────────────────────────────────
// THE BUG: avoid terms were appended RAW to the negative prompt. CLIP has no negation
// operator, so a player writing a PROHIBITION into a field that is ITSELF a negation
// gets a double negative: "no arms" in the negative embeds the *arms* concept and
// steers AWAY from arms — producing the exact defect asked to be avoided. The owner
// typed "cut-off shoulders, floating, no arms" and got cropped, floating, armless
// portraits on every redo.
//
// FIX, in two moves:
//  1. STRIP the prohibition wrapper ("no X" / "without X" / "avoid X" / "not X") so the
//     term names the DEFECT, which is what a negative prompt wants.
//  2. TRANSLATE known defect phrasings into the checkpoint's effective negative
//     vocabulary, and emit a matching POSITIVE counter-cue where one exists (positives
//     beat negatives — the owner's kitchen lesson). "floating" alone rarely lands;
//     "floating head, disembodied" in the negative plus "grounded, shoulders and torso
//     in frame" in the positive does.
const AVOID_PROHIBITION_RE = /^(?:no|not|without|avoid|avoiding|never|don'?t(?:\s+want)?|exclude|remove)\s+(?:any\s+|the\s+|a\s+|an\s+)?/i;

// defect pattern -> { negative: effective negative vocabulary, positive: counter-cue }
const AVOID_VOCABULARY = [
  { re: /\b(arms?|armless)\b/i, negative: "missing arms, amputee, severed arms, hidden arms", positive: "both arms visible and intact" },
  { re: /\b(cut[\s-]*off|cropped|cut)\s*(shoulders?|torso|body|head)?\b/i, negative: "cropped, out of frame, cut off, closeup crop", positive: "chest-up framing, shoulders and upper torso fully in frame" },
  { re: /\bshoulders?\b/i, negative: "cropped shoulders, out of frame", positive: "shoulders and upper torso fully in frame" },
  { re: /\bfloat(ing)?\b|\bdisembodied\b/i, negative: "floating head, disembodied head, detached head, head only", positive: "grounded, neck and shoulders connected, torso in frame" },
  { re: /\bblurr?y?\b/i, negative: "blurry, out of focus, motion blur", positive: "sharp focus" },
  { re: /\b(extra|deformed|mutated)\s*(limbs?|fingers?|hands?)\b/i, negative: "extra limbs, deformed hands, mutated fingers, bad anatomy", positive: "correct anatomy" }
];

/**
 * Normalize one raw avoid term into effective negative vocabulary + an optional
 * positive counter-cue. Pure. Returns { negative, positive } (either may be "").
 */
export function normalizeAvoidTerm(raw) {
  const stripped = String(raw || "").trim().replace(AVOID_PROHIBITION_RE, "").trim();
  if (!stripped) return { negative: "", positive: "" };
  for (const entry of AVOID_VOCABULARY) {
    if (entry.re.test(stripped)) {
      return { negative: entry.negative, positive: entry.positive || "" };
    }
  }
  // Unknown term: the prohibition wrapper is still stripped, so at minimum the player
  // gets "arms" rather than "no arms" — the defect named, not the prohibition negated.
  return { negative: stripped, positive: "" };
}

/**
 * Apply the appearance/avoid preference slots to an already-sealed (positive, negative).
 * Additive only; identity + safety layers always win. Pure.
 * @param {{positive?:string, negative?:string, appearance?:string, avoid?:string, provider?:string}} opts
 * @returns {{positive:string, negative:string}}
 */
export function applyPreferenceSlots({ positive = "", negative = "", appearance = "", avoid = "", provider = "comfyui" } = {}) {
  const app = sanitizeSlot(appearance);
  let outPositive = app ? `${positive}, ${app}` : positive;

  // A positive-only provider has no negative field — omit the avoid slot entirely.
  const positiveOnly = provider === "pollinations" || provider === "positive-only" || provider === "flux";
  let outNegative = negative;

  const rawTerms = sanitizeSlot(avoid)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((term) => !AVOID_SAFETY_DENY.test(term.replace(AVOID_PROHIBITION_RE, ""))); // strip safety-floor breaches

  const negParts = [];
  const posCounters = [];
  for (const term of rawTerms) {
    const { negative: neg, positive: pos } = normalizeAvoidTerm(term);
    if (neg) negParts.push(neg);
    if (pos) posCounters.push(pos);
  }
  // The POSITIVE counter-cue rides on every provider (positives beat negatives, and a
  // positive-only provider can still be steered), appended as a weak tail so declared
  // identity keeps winning.
  if (posCounters.length) {
    outPositive = `${outPositive}, ${[...new Set(posCounters)].join(", ")}`;
  }
  if (!positiveOnly && negParts.length) {
    const joined = [...new Set(negParts)].join(", ");
    outNegative = negative ? `${negative}, ${joined}` : joined;
  }
  return { positive: outPositive, negative: outNegative };
}
