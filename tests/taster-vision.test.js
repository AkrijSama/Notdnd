import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visionAssess,
  estimateVisionCostUsd,
  registerVisionAssessor,
  TASTER_VISION_MODEL,
  TASTER_VISION_PRICING,
  DEFAULT_SETTING_ERA
} from "../server/ai/tasterVision.js";
import { tasteAsync, taste, getAssessor, registerAssessor } from "../server/solo/fridgeTaster.js";

// Every test here is HERMETIC: a stub fetchImpl stands in for OpenRouter, so the
// suite never makes a paid call. (The real calls are made only by the operator
// tool scripts/art/taste-quarantine.mjs.)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function stubFetch(payload, { capture = null, failFirst = false } = {}) {
  let calls = 0;
  return async (url, opts) => {
    calls += 1;
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(opts.body);
      capture.calls = calls;
    }
    const content = failFirst && calls === 1 ? '{"observedSubject": "truncated mid' : JSON.stringify(payload);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1300, completion_tokens: 120 }
      })
    };
  };
}

const PASS_PAYLOAD = {
  observedSubject: "a man with a beard",
  checks: [
    { question: "single head?", ok: true, note: "one head" },
    { question: "human-when-declared-human?", ok: true, note: "human" },
    { question: "clothed?", ok: true, note: "clothed" }
  ],
  verdict: "pass",
  reason: "clean"
};

test("cost math matches the published per-million pricing", () => {
  assert.equal(TASTER_VISION_MODEL, "google/gemini-2.5-flash-lite");
  const cost = estimateVisionCostUsd({ prompt: 1_000_000, completion: 0 });
  assert.equal(Number(cost.toFixed(6)), TASTER_VISION_PRICING.promptPerM);
  const out = estimateVisionCostUsd({ prompt: 0, completion: 1_000_000 });
  assert.equal(Number(out.toFixed(6)), TASTER_VISION_PRICING.completionPerM);
  // A realistic per-image call stays well under a tenth of a cent.
  assert.ok(estimateVisionCostUsd({ prompt: 1600, completion: 150 }) < 0.001);
});

test("a clean image PASSES and reports the observed subject", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const r = await visionAssess({ id: "a", bytes: PNG, kind: "portrait", fetchImpl: stubFetch(PASS_PAYLOAD) });
  assert.equal(r.verdict, "pass");
  assert.equal(r.observedSubject, "a man with a beard");
  assert.equal(r.model, TASTER_VISION_MODEL);
  assert.ok(r.costUsd > 0);
});

test("ANY failed check forces suspect even when the model says pass (verdict is derived)", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const contradictory = {
    ...PASS_PAYLOAD,
    checks: [{ question: "expected subject present?", ok: false, note: "a wolf, not a marketplace" }],
    verdict: "pass" // the model contradicts itself
  };
  const r = await visionAssess({ id: "b", bytes: PNG, kind: "scene", fetchImpl: stubFetch(contradictory) });
  assert.equal(r.verdict, "suspect", "a failed check must win over the model's own verdict");
  assert.match(r.reason, /wolf/);
});

test("the committed SETTING and the conditional-question law ride in the prompt", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const cap = {};
  await visionAssess({
    id: "c",
    bytes: PNG,
    kind: "portrait",
    expectedSubject: "a wolf — a four-legged animal, NOT a human",
    fetchImpl: stubFetch(PASS_PAYLOAD, { capture: cap })
  });
  const text = cap.body.messages[1].content.find((c) => c.type === "text").text;
  // Without the setting, "no modern-city UNLESS COMMITTED" is unanswerable — this
  // was a live calibration miss (a fantasy scene with train tracks passed).
  assert.ok(text.includes(DEFAULT_SETTING_ERA), "the committed setting must be stated");
  // Without the conditional law, a correct animal portrait is failed for being
  // non-human and unclothed.
  assert.match(text, /NOT APPLICABLE/);
  assert.match(text, /declared non-human/);
  assert.equal(cap.body.model, TASTER_VISION_MODEL);
  assert.equal(cap.body.temperature, 0);
});

test("an unparseable body RETRIES once before failing (a false quarantine costs a good image)", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const cap = {};
  const r = await visionAssess({
    id: "d",
    bytes: PNG,
    kind: "portrait",
    fetchImpl: stubFetch(PASS_PAYLOAD, { capture: cap, failFirst: true })
  });
  assert.equal(cap.calls, 2, "must retry exactly once on a malformed body");
  assert.equal(r.verdict, "pass");
});

test("no API key is a hard error, never a silent pass", async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => visionAssess({ id: "e", bytes: PNG, kind: "portrait" }), /OPENROUTER_API_KEY/);
  if (prior !== undefined) process.env.OPENROUTER_API_KEY = prior;
});

test("THE FENCE: importing the adapter registers nothing; the seat arms it", () => {
  const priorSeat = process.env.NOTDND_TASTER_MODEL;
  const priorKey = process.env.OPENROUTER_API_KEY;
  // Seat unset -> mock, and registerVisionAssessor is a no-op.
  delete process.env.NOTDND_TASTER_MODEL;
  assert.equal(registerVisionAssessor(), null, "no seat => not armed");
  assert.equal(getAssessor().model, "mock");
  // Seat set but no key -> STILL the mock (never a silent paid call).
  process.env.NOTDND_TASTER_MODEL = TASTER_VISION_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(registerVisionAssessor(), null, "no key => not armed");
  assert.equal(getAssessor().model, "mock");
  // Seat + key -> armed.
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(registerVisionAssessor(), TASTER_VISION_MODEL);
  assert.equal(getAssessor().model, TASTER_VISION_MODEL);
  if (priorSeat === undefined) delete process.env.NOTDND_TASTER_MODEL;
  else process.env.NOTDND_TASTER_MODEL = priorSeat;
  if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = priorKey;
});

test("tasteAsync awaits an async assessor; sync taste() fails CLOSED on one", async () => {
  const priorSeat = process.env.NOTDND_TASTER_MODEL;
  process.env.NOTDND_TASTER_MODEL = "async-probe";
  registerAssessor("async-probe", async () => ({ verdict: "pass", checks: [], reason: "async ok" }));

  const good = await tasteAsync({ id: "z", kind: "scene", defaultRating: "keep" });
  assert.equal(good.verdict, "pass");
  assert.equal(good.rating, "keep");
  assert.equal(good.quarantine, null);

  // The sync door must never auto-keep on a pending promise.
  const viaSync = taste({ id: "z", kind: "scene", defaultRating: "keep" });
  assert.equal(viaSync.verdict, "suspect");
  assert.ok(viaSync.quarantine, "a thenable must quarantine, not auto-keep");
  assert.match(viaSync.reason, /tasteAsync/);

  if (priorSeat === undefined) delete process.env.NOTDND_TASTER_MODEL;
  else process.env.NOTDND_TASTER_MODEL = priorSeat;
});

test("a throwing assessor fails SAFE to quarantine (never an unreviewed auto-keep)", async () => {
  const priorSeat = process.env.NOTDND_TASTER_MODEL;
  process.env.NOTDND_TASTER_MODEL = "boom-probe";
  registerAssessor("boom-probe", async () => {
    throw new Error("upstream 500");
  });
  const r = await tasteAsync({ id: "q", kind: "portrait", defaultRating: "keep" });
  assert.equal(r.verdict, "suspect");
  assert.equal(r.rating, null);
  assert.match(r.reason, /upstream 500/);
  if (priorSeat === undefined) delete process.env.NOTDND_TASTER_MODEL;
  else process.env.NOTDND_TASTER_MODEL = priorSeat;
});
