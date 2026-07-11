import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// gm-transcript-persistence: one JSONL record per GM generation. These tests
// drive recordGmGeneration directly (the writer the runGmPipeline capture site
// calls) — the shape, the retry-vs-draft distinction, best-effort failure, and
// the kill-switch. Each test isolates the output dir via NOTDND_GM_TRANSCRIPTS_DIR.

function freshDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gm-transcripts-${label}-`));
  process.env.NOTDND_GM_TRANSCRIPTS_DIR = dir;
  delete process.env.INKBORNE_GM_TRANSCRIPTS;
  delete process.env.INKBORNE_GM_TRANSCRIPTS_MAX_PROMPT_BYTES;
  return dir;
}

function readRecords(dir, runId) {
  const file = path.join(dir, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const SAMPLE_MESSAGES = [
  { role: "system", content: "You are the GM. Ground everything in committed state." },
  { role: "user", content: "I force the cellar door." }
];

// (a) a mocked pipeline call writes a record with ALL fields
test("(a) writes one record with every field populated", async () => {
  const dir = freshDir("a");
  const { recordGmGeneration } = await import(`../server/logging/gmTranscript.js?a=${Date.now()}`);
  const ok = recordGmGeneration({
    runId: "run_alpha",
    campaignId: "camp_alpha",
    turnRef: 7,
    callType: "narration",
    model: "deepseek/deepseek-v4-flash",
    finishReason: "stop",
    promptMessages: SAMPLE_MESSAGES,
    rawOutput: "The door splinters. \"Who's there?\" a voice rasps.",
    trimmedOutput: null,
    latencyMs: 4213,
    trimApplied: false,
    handlesRetry: false
  });
  assert.equal(ok, true);
  const [rec] = readRecords(dir, "run_alpha");
  assert.ok(rec, "a record was written");
  for (const field of ["ts", "runId", "campaignId", "turnRef", "callType", "model", "provider", "finishReason", "promptMessages", "rawOutput", "trimmedOutput", "latencyMs", "trimApplied", "handlesRetry"]) {
    assert.ok(field in rec, `field "${field}" present`);
  }
  assert.equal(rec.runId, "run_alpha");
  assert.equal(rec.turnRef, 7);
  assert.equal(rec.callType, "narration");
  assert.equal(rec.model, "deepseek/deepseek-v4-flash");
  assert.equal(rec.provider, "openrouter", "provider derived from the model id");
  assert.deepEqual(rec.promptMessages, SAMPLE_MESSAGES, "FULL prompt array persisted verbatim");
  assert.match(rec.rawOutput, /Who's there/);
  assert.equal(rec.handlesRetry, false);
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/, "ISO timestamp");
});

// (b) a handles-retry turn writes TWO records (draft + retry) distinguished by callType
test("(b) draft + handles-retry write two records with distinct callType", async () => {
  const dir = freshDir("b");
  const { recordGmGeneration } = await import(`../server/logging/gmTranscript.js?b=${Date.now()}`);
  // draft
  recordGmGeneration({ runId: "run_beta", campaignId: "camp_beta", callType: "narration", model: "m", promptMessages: SAMPLE_MESSAGES, rawOutput: "draft prose", handlesRetry: false });
  // retry (the pipeline detects the corrective clause and tags it)
  recordGmGeneration({ runId: "run_beta", campaignId: "camp_beta", callType: "handles-retry", model: "m", promptMessages: SAMPLE_MESSAGES, rawOutput: "retry prose with handles", handlesRetry: true });
  const recs = readRecords(dir, "run_beta");
  assert.equal(recs.length, 2, "two records appended to the same run file");
  assert.equal(recs[0].callType, "narration");
  assert.equal(recs[0].handlesRetry, false);
  assert.equal(recs[1].callType, "handles-retry");
  assert.equal(recs[1].handlesRetry, true);
});

// (c) a write failure does NOT throw (best-effort; never fails a turn)
test("(c) a write failure returns false and never throws", async () => {
  freshDir("c");
  const { recordGmGeneration } = await import(`../server/logging/gmTranscript.js?c=${Date.now()}`);
  // point the dir at a path that cannot be created (a FILE where a dir is needed)
  const clash = path.join(os.tmpdir(), `gm-clash-${Date.now()}`);
  fs.writeFileSync(clash, "i am a file, not a directory");
  process.env.NOTDND_GM_TRANSCRIPTS_DIR = path.join(clash, "nested"); // mkdir under a file → EEXIST/ENOTDIR
  let threw = false;
  let result;
  try {
    result = recordGmGeneration({ runId: "run_gamma", promptMessages: SAMPLE_MESSAGES, rawOutput: "x" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "recordGmGeneration must never throw into the turn path");
  assert.equal(result, false, "a failed write reports false");
});

// (d) the kill-switch produces zero writes
test("(d) INKBORNE_GM_TRANSCRIPTS=false disables all capture", async () => {
  const dir = freshDir("d");
  process.env.INKBORNE_GM_TRANSCRIPTS = "false";
  const { recordGmGeneration } = await import(`../server/logging/gmTranscript.js?d=${Date.now()}`);
  const ok = recordGmGeneration({ runId: "run_delta", promptMessages: SAMPLE_MESSAGES, rawOutput: "should not persist" });
  assert.equal(ok, false, "capture reports it did not write");
  assert.equal(readRecords(dir, "run_delta").length, 0, "no file/line written when disabled");
  delete process.env.INKBORNE_GM_TRANSCRIPTS;
});

// size guard: an oversized prompt is truncated with a marker, record still written
test("size guard: an oversized promptMessages is truncated with a marker, not dropped", async () => {
  const dir = freshDir("size");
  process.env.INKBORNE_GM_TRANSCRIPTS_MAX_PROMPT_BYTES = "2048";
  const { recordGmGeneration } = await import(`../server/logging/gmTranscript.js?s=${Date.now()}`);
  const huge = [{ role: "system", content: "x".repeat(50000) }, { role: "user", content: "go" }];
  const ok = recordGmGeneration({ runId: "run_size", promptMessages: huge, rawOutput: "ok" });
  assert.equal(ok, true, "record still written");
  const [rec] = readRecords(dir, "run_size");
  assert.equal(rec.promptTruncated, true);
  assert.match(JSON.stringify(rec.promptMessages), /TRUNCATED/, "truncation marker present");
});
