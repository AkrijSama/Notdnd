// HOME NAVIGATION GATE (T1). The header mark+wordmark is a link back to the landing/
// home screen. If the player has in-progress work — an OPEN RUN (an unsent turn) OR
// mid character-creation (a portrait draft / entered fields) — we confirm first so a
// draft or turn is never SILENTLY abandoned (input-integrity manners). On the landing
// itself (world-select / inactive), going home is a no-op nav and needs no confirm.
//
// Pure + exported so both the home header and the in-run scene header share ONE gate,
// and it is unit-testable without a DOM.

// Steps where the player has NOT yet started creating anything — home nav is safe.
const HOME_SAFE_STEPS = new Set(["inactive", "world"]);

/**
 * Should clicking the home brand confirm before navigating away?
 * @param {{ inRun?: boolean, onboardingStep?: string }} ctx
 * @returns {boolean}
 */
export function shouldConfirmHomeNav({ inRun = false, onboardingStep = "inactive" } = {}) {
  if (inRun) {
    return true; // an open run may have an unsent turn
  }
  return !HOME_SAFE_STEPS.has(String(onboardingStep || "inactive"));
}

// The confirm copy (no em-dash — honesty-string em-dash net, T7).
export const HOME_NAV_CONFIRM =
  "Return to home? Your progress is saved. Any unsent message or unfinished character stays as it is.";
