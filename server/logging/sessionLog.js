// Per-turn solo SESSION TRANSCRIPT — debugging infrastructure for the owner's
// manual playtests. The owner runs the server detached (setsid nohup), so a
// turn's full causal chain must land in a FINDABLE FILE, not stdout that scrolls
// away: one human-readable transcript per run at data/logs/runs/<runId>.log,
// tail-able live.
//
// This exists because docs/FALLBACKS.md flagged several SILENT, player-reachable
// degraded paths (GM-narration timeout #5/#6, interpreter fallback #11/#12,
// onboarding #9): when they fired, nothing useful was logged, so neither the
// owner nor Claude could explain why a turn "went quiet". Every such path now
// writes a LOUD line here.
//
// Never throws — debugging infra must not be able to break a turn.

import fs from "node:fs";
import path from "node:path";

function logsRoot() {
  return process.env.NOTDND_LOGS_ROOT
    ? path.resolve(process.env.NOTDND_LOGS_ROOT)
    : path.resolve(process.cwd(), "data/logs");
}

// Filesystem-safe per-run transcript path: data/logs/runs/<runId>.log
export function runLogPath(runId) {
  const safe = String(runId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  return path.join(logsRoot(), "runs", `${safe}.log`);
}

// Appends a human-readable, timestamped BLOCK to the run's transcript. `block`
// may be a string or an array of lines. Best-effort: a logging failure is
// swallowed so it can never interrupt gameplay.
export function appendTurnLog(runId, block) {
  try {
    const file = runLogPath(runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString();
    const lines = Array.isArray(block) ? block : [String(block ?? "")];
    const body = lines.map((line) => `  ${line}`).join("\n");
    fs.appendFileSync(file, `\n===== TURN ${ts} =====\n${body}\n`, "utf8");
  } catch {
    // Intentionally silent — never let the transcript break a turn.
  }
}

// Loud one-liner for a degraded/fallback event: written to the run transcript
// AND to stdout (so a tailed server log shows it too). Use for the previously
// SILENT paths — a timeout, an interpreter fallback, an empty-narration template.
export function logTurnEvent(runId, message) {
  const text = String(message ?? "");
  try {
    // eslint-disable-next-line no-console
    console.warn(`[turn ${String(runId || "?").slice(0, 14)}] ${text}`);
  } catch {
    // ignore
  }
  appendTurnLog(runId, text);
}
