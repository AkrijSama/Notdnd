// LAW R10 — SFW ENFORCEMENT (docs/design/romance-legacy-law.md, RATIFIED
// 2026-07-16): "Mainline: romance-register violations are BLOCKED
// (block-and-regenerate), not log-only. Personal Forbidden: log-only acceptable."
//
// This upgrades the romance-register auditor from log-only to blocking on the
// Mainline turn path, mirroring the handles-enforcement shape (one bounded
// corrective regeneration, never a loop):
//   1. Violating narration is NEVER returned to the caller in Mainline.
//   2. One regeneration attempt with a hardened register directive.
//   3. If the retry still violates (or fails), the result is narrative:null —
//      the caller's existing template path then serves the deterministic
//      committed-fact line (attemptResult/talk template), never raw violating
//      prose. No new fallback text surface is invented.
// Personal-Forbidden runs (run.edition === "forbidden") stay log-only per law.
//
// The regenerate callback is the caller's own provider plumbing (generateOnce
// with this module's corrective clause appended). Tests inject a mock.

import { detectRomanceRegisterViolations } from "../solo/reputation.js";

// Appended to the original turn message for the single corrective retry. Hard,
// explicit, and self-contained: the retry model may not have "seen" why the
// first draft was rejected.
export const ROMANCE_CORRECTIVE_CLAUSE =
  " REGISTER VIOLATION, REWRITE REQUIRED: your previous draft crossed the committed romance/SFW register for this scene." +
  " Rewrite the beat with ZERO physical-romantic content (no kissing, embracing, caressing, pulling close, sharing a bed)" +
  " and ZERO explicit content of any kind. Keep the same scene events and speakers otherwise." +
  " Warmth may show only through words, posture, and restraint, consistent with the committed relationship tier.";

/**
 * Enforce Law R10 on a finished narration draft.
 * @param {string} narrative - the draft narration (post-trim, post-strip)
 * @param {object} options
 * @param {object} options.run - the committed run (edition + reputation state)
 * @param {() => Promise<string>} [options.regenerate] - single-retry provider
 *   callback; must return the regenerated prose ("" on failure). Optional: with
 *   no callback a Mainline violation goes straight to blocked.
 * @param {(text: string, run: object) => Array} [options.detect] - injectable
 *   detector (defaults to the live romance-register auditor).
 * @returns {Promise<{ narrative: string|null, action: string, violations: Array, retryViolations: Array|null }>}
 *   action: "clean" | "log-only" | "regenerated" | "blocked".
 *   narrative is null ONLY for "blocked" — the caller must fall back to its
 *   deterministic committed-fact template, never the violating draft.
 */
export async function enforceRomanceRegister(narrative, { run, regenerate, detect = detectRomanceRegisterViolations } = {}) {
  const text = typeof narrative === "string" ? narrative : "";
  const violations = text.trim() ? detect(text, run) : [];
  if (!violations.length) {
    return { narrative: text, action: "clean", violations: [], retryViolations: null };
  }
  // Personal-Forbidden config path: log-only per law (the caller logs; the
  // prose passes through untouched).
  if (run?.edition === "forbidden") {
    return { narrative: text, action: "log-only", violations, retryViolations: null };
  }
  // Mainline: BLOCK. One corrective regeneration attempt.
  let retry = "";
  if (typeof regenerate === "function") {
    try {
      retry = String((await regenerate()) || "");
    } catch {
      retry = "";
    }
  }
  if (retry.trim()) {
    const retryViolations = detect(retry, run);
    if (retryViolations.length === 0) {
      return { narrative: retry, action: "regenerated", violations, retryViolations: [] };
    }
    // Still violating: the retry is discarded too.
    return { narrative: null, action: "blocked", violations, retryViolations };
  }
  return { narrative: null, action: "blocked", violations, retryViolations: null };
}
