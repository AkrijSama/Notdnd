import assert from "node:assert/strict";
import test from "node:test";
import { renderNarrationLog, resolveTurnHeaderIntent } from "../src/components/soloSceneShell.js";

// BUG B (owner 2026-07-10) — the YOU badge must render the player's VERBATIM
// words, NEVER a GM-generated beat title. Live report: the player typed
// "sprint towards the north…" and the YOU badge showed "Smoke on the horizon",
// a GM beat title. resolveTurnHeaderIntent is the provenance rule in isolation.

test("BUG B: the player's submitted words win over a GM beat title", () => {
  const intent = resolveTurnHeaderIntent({
    submitted: "sprint towards the north road",
    attemptResult: null,
    // the committed event carries a GM narration title — the exact failure mode
    lastEvent: { type: "move", title: "Smoke on the horizon", payload: { intent: "sprint towards the north road" } },
    isFirst: false
  });
  assert.equal(intent, "sprint towards the north road");
  assert.notEqual(intent, "Smoke on the horizon");
});

test("BUG B: a GM title is never used even when the client lost the raw submit", () => {
  // No `submitted` (e.g. after a resync) — the server-preserved payload.intent is
  // used; the GM `title` is still never a source.
  const intent = resolveTurnHeaderIntent({
    submitted: "",
    attemptResult: null,
    lastEvent: { type: "search", title: "Smoke on the horizon", payload: { intent: "search the north road" } },
    isFirst: false
  });
  assert.equal(intent, "search the north road");
});

test("BUG B: attempt turns use the attempt intent (also the player's words)", () => {
  const intent = resolveTurnHeaderIntent({
    submitted: "",
    attemptResult: { intent: "force the door" },
    lastEvent: { type: "attempt", title: "Attempt Succeeded" },
    isFirst: false
  });
  assert.equal(intent, "force the door");
});

test("BUG B: a click-driven affordance with no words falls back to a deterministic label, never a GM title", () => {
  const intent = resolveTurnHeaderIntent({
    submitted: "",
    attemptResult: null,
    lastEvent: { type: "move", title: "Smoke on the horizon", payload: {} },
    isFirst: false
  });
  assert.equal(intent, "Move on", "the deterministic action label, not the GM title");
});

test("BUG B: the opening (isFirst) has no player action and no header", () => {
  assert.equal(resolveTurnHeaderIntent({ submitted: "anything", isFirst: true }), "");
});

test("BUG B: the YOU line renders verbatim; long input truncates for layout but keeps the full text on hover", () => {
  const long = "sprint towards the north road " + "and keep going ".repeat(20);
  const html = renderNarrationLog([{ id: "n1", intent: long, text: "You run north." }]);
  assert.match(html, /class="solo-log-you">You</, "YOU badge present");
  assert.match(html, /solo-log-intent" title="sprint towards the north road/, "full text preserved in the title (hover) attribute");
  assert.match(html, /…<\/span>/, "display is ellipsis-truncated when over the limit");
  // a short action renders verbatim with no truncation
  const short = renderNarrationLog([{ id: "n2", intent: "sprint towards the north", text: "You run." }]);
  assert.match(short, /solo-log-intent" title="sprint towards the north">sprint towards the north</);
  assert.doesNotMatch(short, /…/);
});
