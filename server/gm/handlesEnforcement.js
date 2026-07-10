// HANDLES ENFORCEMENT (server-clearout item 5). The prose contract lands closing
// handles on ~72% of turns; when a draft comes back with NONE, regenerate ONCE
// with a corrective clause, then accept whatever came back — a turn is never
// blocked on handles. Uses the SAME detectHandles the grader runs (imported, the
// frozen ruler file is untouched) so live enforcement and measurement agree.
import { detectHandles } from "../../scripts/selfplayAudit.mjs";

export const HANDLES_CORRECTIVE_CLAUSE =
  " Your previous draft omitted closing directions — end with 2-4 grounded directions the player could take right now.";

/**
 * @param {string} narrative the first draft (non-empty)
 * @param {{ scene?: object, regenerate: () => Promise<string> }} opts
 *   `regenerate` produces the retry draft ("" on failure). Called at most once.
 * @returns {Promise<{ narrative: string, handlesRetry: 0|1, retryReplaced: boolean }>}
 */
export async function enforceHandles(narrative, { scene = {}, regenerate } = {}) {
  const first = String(narrative || "");
  if (!first.trim() || typeof regenerate !== "function") {
    return { narrative: first, handlesRetry: 0, retryReplaced: false };
  }
  if (detectHandles(first, scene).verdict !== "missing") {
    return { narrative: first, handlesRetry: 0, retryReplaced: false };
  }
  let retryDraft = "";
  try {
    retryDraft = String((await regenerate()) || "");
  } catch {
    retryDraft = ""; // enforcement must never break a turn
  }
  if (retryDraft.trim()) {
    return { narrative: retryDraft, handlesRetry: 1, retryReplaced: true };
  }
  return { narrative: first, handlesRetry: 1, retryReplaced: false };
}
