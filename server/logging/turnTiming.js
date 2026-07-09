// PER-TURN LATENCY INSTRUMENTATION (item 7). Turns span ~3-20s and nobody could
// say which stage eats the slow ones. Each solo action turn collects a sequential
// stage breakdown — interpreter / commit / gm / auditor / renderReady — and on
// finish (a) appends one greppable line to the run log (data/logs/runs/<id>.log)
// and (b) retains the record in memory for /api/debug/status (`turnTiming`).
//
// Stage semantics (sequential segments, ms since the previous mark):
//   interpreter  — buildLiveAttemptOptions (incl. the roll-gating interpreter call)
//   commit       — resolveSoloAction + saveSoloRun (resolve + persist the turn)
//   gm           — the narration call (narrateActionWithGm ∥ suggestions refresh)
//   auditor      — transcript + dialogue attribution + #27/B2/#41 audit-and-commit
//   renderReady  — everything after the auditor until the response is written
//                  (victory/death beats when they fire, synth turn, serialization)
//
// Deliberately NOT in server/runtimeStatus.js (CLI 1 owns that file); this module
// is self-contained and the debug-status handler in server/index.js reads it.
import { logTurnEvent } from "./sessionLog.js";

// Last completed turn + a small ring of recent turns (debug status shows both, so
// a slow outlier is still visible after a fast turn overwrites "last").
const RECENT_LIMIT = 10;
const recent = [];
let last = null;

export function startTurnTiming(runId, actionType = "") {
  const t0 = Date.now();
  let prev = t0;
  const stages = {};
  let finished = false;
  return {
    mark(stage) {
      const now = Date.now();
      stages[stage] = now - prev;
      prev = now;
    },
    finish() {
      if (finished) {
        return last;
      }
      finished = true;
      const totalMs = Date.now() - t0;
      const record = {
        runId: String(runId || ""),
        actionType: String(actionType || ""),
        stages: { ...stages },
        totalMs,
        at: new Date().toISOString()
      };
      last = record;
      recent.push(record);
      if (recent.length > RECENT_LIMIT) {
        recent.splice(0, recent.length - RECENT_LIMIT);
      }
      try {
        const parts = Object.entries(stages).map(([k, v]) => `${k}=${v}ms`);
        logTurnEvent(record.runId, `turnTiming ${parts.join(" ")} total=${totalMs}ms (${record.actionType || "action"})`);
      } catch {
        // timing must never break a turn
      }
      return record;
    }
  };
}

export function getLastTurnTiming() {
  return last;
}

export function getRecentTurnTimings() {
  return [...recent];
}
