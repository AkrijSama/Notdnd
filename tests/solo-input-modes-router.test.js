import test from "node:test";
import assert from "node:assert/strict";

import { classifyInputMode, resolveSoloAction } from "../server/solo/actions.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

// SERVER-SIDE input-mode router (#37/#38). The client (solo-input-modes.test.js)
// classifies for the UI; this proves the SERVER honors action.mode, falls back to
// text signaling, and routes OOC / speech / action correctly through resolveSoloAction.

test("classifyInputMode honors an explicit client mode", () => {
  assert.deepEqual(classifyInputMode({ mode: "speech", intent: '"hello there"' }), { mode: "speech", cleanIntent: '"hello there"' });
  assert.deepEqual(classifyInputMode({ mode: "action", intent: "open the door" }), { mode: "action", cleanIntent: "open the door" });
  assert.deepEqual(classifyInputMode({ mode: "ooc", intent: "/ooc how much HP do I have?" }), { mode: "ooc", cleanIntent: "how much HP do I have?" });
});

test("classifyInputMode falls back to text signaling when mode is absent/invalid", () => {
  assert.equal(classifyInputMode({ intent: "/ooc remind me of the plan" }).mode, "ooc");
  assert.equal(classifyInputMode({ intent: "/ooc remind me of the plan" }).cleanIntent, "remind me of the plan");
  assert.equal(classifyInputMode({ intent: '"I yield!"' }).mode, "speech");
  assert.equal(classifyInputMode({ intent: "“smart quote speech”" }).mode, "speech");
  assert.equal(classifyInputMode({ intent: "climb the wall" }).mode, "action");
  assert.equal(classifyInputMode({ mode: "garbage", intent: "climb the wall" }).mode, "action");
});

test("resolveSoloAction routes OOC to a meta result — no state change, no turn", () => {
  const run = createDefaultSoloRun();
  const before = JSON.stringify(run);
  const res = resolveSoloAction(run, { type: "attempt", mode: "ooc", intent: "/ooc what are my options here?" });
  assert.equal(res.ok, true);
  assert.equal(res.code, "OOC");
  assert.equal(res.actionType, "ooc");
  assert.equal(res.run, null, "OOC never mutates state");
  assert.equal(res.ooc.question, "what are my options here?");
  assert.ok(Array.isArray(res.availableMoves));
  assert.equal(JSON.stringify(run), before, "input run untouched");
});

test("resolveSoloAction OOC works from bare text signaling too", () => {
  const run = createDefaultSoloRun();
  const res = resolveSoloAction(run, { type: "attempt", intent: "/ooc recap the last scene please" });
  assert.equal(res.code, "OOC");
  assert.equal(res.ooc.question, "recap the last scene please");
});

test("resolveSoloAction tags a SPEECH attempt on the result", () => {
  const run = createDefaultSoloRun();
  const res = resolveSoloAction(run, { type: "attempt", mode: "speech", intent: '"Well met, traveler."' });
  assert.equal(res.ok, true);
  assert.equal(res.attemptResult.inputMode, "speech");
});

test("a plain action defaults to inputMode 'action'", () => {
  const run = createDefaultSoloRun();
  const res = resolveSoloAction(run, { type: "attempt", intent: "search the desk drawers" });
  assert.equal(res.ok, true);
  assert.equal(res.attemptResult.inputMode, "action");
});
