// Pure, honest run-state → label mapping for the saved-runs list. Extracted so the
// classification has ONE source of truth and can be verified (unit test + painted
// DOM) without importing main.js's app bootstrap.
//
// State contract (server/solo/schema.js RUN_STATUSES + server/solo/scene.js
// `resumable`, which is active-only):
//   active    → resumable; play continues                     → "Continue"
//   completed → a genuine resolution exists (an ending to read)→ "View ending"
//   abandoned → voluntarily left: NON-resumable AND no ending  → "View"
//   dead      → terminal death                                 → "View death"
//
// The bug this fixes (C.16): abandoned runs showed "View ending", implying a
// resolution that never happened. An abandoned run has no ending (server never
// concluded it narratively) and is not resumable, so neither "View ending" nor
// "Resume" is truthful — "View" is.

export function runFlags(run) {
  const status = run?.status || "unknown";
  const isDead = run?.isDead === true || status === "dead" || run?.player?.status === "dead";
  const isCompleted = status === "completed";
  const isAbandoned = status === "abandoned";
  return { status, isDead, isCompleted, isAbandoned, finished: isDead || isCompleted || isAbandoned };
}

export function soloRunActionLabel(run, { primary = false } = {}) {
  const { isDead, isCompleted, isAbandoned } = runFlags(run);
  if (isDead) return "View death";
  if (isCompleted) return "View ending";
  if (isAbandoned) return "View";
  return primary ? "Continue your adventure" : "Continue";
}
