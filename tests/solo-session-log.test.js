import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-sesslog-"));
process.env.NOTDND_LOGS_ROOT = tmpDir;

const { appendTurnLog, runLogPath, logTurnEvent } = await import("../server/logging/sessionLog.js");

test("runLogPath is per-run, findable, and filesystem-safe", () => {
  const p = runLogPath("run_abc-123");
  assert.equal(path.dirname(p), path.join(tmpDir, "runs"));
  assert.equal(path.basename(p), "run_abc-123.log");
  // Path-traversal is neutralized: separators are stripped so the file stays a
  // flat name inside logs/runs (never escapes the directory).
  const evil = runLogPath("../../etc/passwd");
  assert.equal(path.dirname(evil), path.join(tmpDir, "runs"), "stays inside runs/");
  assert.ok(!path.basename(evil).includes("/") && !path.basename(evil).includes("\\"), "no separators in filename");
});

test("appendTurnLog writes a timestamped, human-readable block to the per-run file", () => {
  appendTurnLog("run_write", ["action: attempt", "gate: legitimate", "narration: local (inkborne-gm:8b) in 12849ms"]);
  const body = fs.readFileSync(runLogPath("run_write"), "utf8");
  assert.match(body, /===== TURN .* =====/);
  assert.match(body, /action: attempt/);
  assert.match(body, /narration: local \(inkborne-gm:8b\) in 12849ms/);
});

test("appendTurnLog appends (does not clobber) across turns", () => {
  appendTurnLog("run_multi", "turn one");
  appendTurnLog("run_multi", "turn two");
  const body = fs.readFileSync(runLogPath("run_multi"), "utf8");
  assert.match(body, /turn one/);
  assert.match(body, /turn two/);
  assert.equal((body.match(/===== TURN/g) || []).length, 2);
});

test("logTurnEvent records the formerly-silent fallback line to the transcript", () => {
  logTurnEvent("run_event", "GM narration BACKSTOP-TIMED-OUT after 65000ms — using deterministic template");
  const body = fs.readFileSync(runLogPath("run_event"), "utf8");
  assert.match(body, /BACKSTOP-TIMED-OUT/);
});

test("logging never throws — debugging infra must not break a turn", () => {
  // Bad inputs / a bogus root must be swallowed, not propagated.
  assert.doesNotThrow(() => appendTurnLog(null, null));
  assert.doesNotThrow(() => appendTurnLog(undefined, undefined));
  assert.doesNotThrow(() => logTurnEvent("", { not: "a string" }));
});
