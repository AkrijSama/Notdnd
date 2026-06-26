// ---------------------------------------------------------------------------
// Lightweight safety for player-supplied free text that reaches an AI prompt.
//
// This is NOT a content filter for dark fantasy. Violence, gore, villainy,
// morally grey scenarios, and mature themes are the point of the game and are
// deliberately left alone. This layer only catches:
//   1. Prompt injection / structure injection — text shaped like an instruction
//      to the GM model ("ignore previous instructions", "you are now", role
//      labels, HTML/markdown structure). Stripped so the model never sees it.
//   2. A narrow set of out-of-scope inputs that would embarrass the product in a
//      screenshot — obvious jailbreak attempts, slurs, and explicit sexual /
//      sexual-violence content (already red-zone in the content-safety policy).
//
// Pure, no I/O. Exports are reused by the attempt loop, the NPC creator, and
// world generation — every place player text reaches a prompt.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 500;

// Instruction/structure patterns STRIPPED from text before it reaches a prompt.
// Broad on purpose (replacing with a space is harmless); the real blocking is
// detectPolicyViolation below.
const INJECTION_STRIP_PATTERNS = [
  /\bignore\s+(?:all\s+|the\s+|your\s+|any\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|prompts?|rules?|messages?|guidelines?|context)\b/gi,
  /\bdisregard\s+(?:all\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|rules?|prompts?|guidelines?)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\byou\s+are\s+(?:actually|really|secretly)\b/gi,
  /\bpretend\s+you(?:'re| are|\b)/gi,
  /\byour\s+(?:real|true|actual)\s+(?:personality|instructions?|rules?|self|nature|programming|prompt)\b/gi,
  /\bact\s+as\s+(?:an?\s+)?(?:unfiltered|uncensored|jailbroken|dan)\b/gi,
  /\bjailbreak\b/gi,
  /\bnew\s+(?:system\s+prompt|instructions?|rules?)\b/gi,
  /(?:^|\n)\s*(?:system|assistant|developer|user)\s*:/gi
];

// Structural tokens that could fake a new turn/section in the prompt.
const STRUCTURE_STRIP_PATTERNS = [
  /<[^>]*>/g, // HTML / XML tags
  /`{3,}/g, // code fences
  /#{2,}/g, // markdown headings
  /[{}[\]]/g // braces / brackets (JSON / template structure)
];

/**
 * Cleans player text for safe inclusion in an AI prompt: strips injection- and
 * structure-shaped tokens, collapses whitespace, and truncates. Clean prose is
 * returned essentially unchanged. Never throws.
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function sanitizePlayerText(text, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : DEFAULT_MAX_LENGTH;
  let cleaned = String(text ?? "");
  for (const pattern of INJECTION_STRIP_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  for (const pattern of STRUCTURE_STRIP_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).trim();
  }
  return cleaned;
}

// Jailbreak / break-character attempts directed at the GM model. Deliberately
// second-person and GM-directed so legitimate player roleplay ("I pretend to be
// a guard", "I break down the door") is NOT caught.
const JAILBREAK_PATTERNS = [
  /\bignore\s+(?:all\s+|the\s+|your\s+|any\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|rules?|guidelines?|programming|prompts?)\b/i,
  /\bdisregard\s+(?:all\s+|the\s+|your\s+|previous\s+|prior\s+)*(?:instructions?|rules?|guidelines?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\byou\s+are\s+(?:actually|really|secretly)\b/i,
  /\bpretend\s+you(?:'re| are|\b)/i,
  /\byour\s+(?:real|true|actual)\s+(?:personality|instructions?|rules?|self|nature|programming)\b/i,
  /\bact\s+as\s+(?:an?\s+)?(?:unfiltered|uncensored|jailbroken|dan)\b/i,
  /\bjailbreak\b/i,
  /\bnew\s+(?:system\s+prompt|instructions)\b/i,
  /(?:^|\n|\s)(?:system|assistant|developer)\s*:/i
];

// Slurs — word-boundaried so "assassin", "Scunthorpe", legitimate names, etc.
// are not false-positives.
const SLUR_PATTERNS = [
  /\bn[i1]gg(?:er|a)s?\b/i,
  /\bfag(?:got)?s?\b/i,
  /\bcunts?\b/i,
  /\bkikes?\b/i,
  /\bspics?\b/i,
  /\bchinks?\b/i,
  /\btrann(?:y|ies)\b/i
];

// Explicit sexual / sexual-violence content (already red-zone in the content
// policy). Narrow and unambiguous — does not touch dark-fantasy violence.
const EXPLICIT_PATTERNS = [
  /\brap(?:e|ed|es|ing|ist)\b/i,
  /\bmolest(?:s|ed|ing)?\b/i,
  /\bincest\b/i,
  /\bbestiality\b/i,
  /\bpedophil(?:e|es|ia)\b/i,
  /\bchild\s*(?:porn|sex)\b/i,
  /\b(?:blowjob|handjob|cumshot|cumming|deepthroat|gangbang|creampie|bukkake)\b/i
];

/**
 * Flags obvious jailbreak attempts and explicit/slur content. Returns a reason
 * code so callers can respond differently if they want; does NOT flag dark
 * fantasy violence, villainy, or mature-but-in-scope content. Never throws.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string | null }}
 */
export function detectPolicyViolation(text) {
  const raw = String(text ?? "");
  if (JAILBREAK_PATTERNS.some((pattern) => pattern.test(raw))) {
    return { flagged: true, reason: "prompt_injection" };
  }
  if (SLUR_PATTERNS.some((pattern) => pattern.test(raw)) || EXPLICIT_PATTERNS.some((pattern) => pattern.test(raw))) {
    return { flagged: true, reason: "explicit_content" };
  }
  return { flagged: false, reason: null };
}

// In-character refusal shown for a flagged input — preserves immersion instead
// of breaking the fourth wall with an error message.
export const POLICY_VIOLATION_NARRATION = "The world does not bend to such words. Try again.";

/**
 * Screens a player's freeform attempt intent before it reaches any AI prompt.
 * Flags jailbreak/explicit content (caller should respond in character), else
 * returns the sanitized intent. An intent that is empty after sanitization is
 * treated as a (soft) violation so callers never send a blank prompt.
 * @param {string} intent
 * @returns {{ ok: boolean, cleanIntent: string, reason: string | null }}
 */
export function screenPlayerIntent(intent) {
  const raw = String(intent ?? "");
  const violation = detectPolicyViolation(raw);
  if (violation.flagged) {
    return { ok: false, cleanIntent: "", reason: violation.reason };
  }
  const cleanIntent = sanitizePlayerText(raw);
  if (!cleanIntent) {
    return { ok: false, cleanIntent: "", reason: "empty_after_sanitization" };
  }
  return { ok: true, cleanIntent, reason: null };
}
