import assert from "node:assert/strict";
import test from "node:test";
import { classifyInput, renderNarrationLog } from "../src/components/soloSceneShell.js";

// BUG A (owner 2026-07-10) — /ooc was silently ignored. The full server path
// exists (resolver → narrateOocWithGm) but the client dropped the reply. These
// pin: /ooc routes to the OOC path (not the action resolver), and the reply
// renders as a distinct, non-story note.

test("BUG A: /ooc classifies to the OOC mode, marker stripped, not an action", () => {
  const cls = classifyInput("/ooc what is the smoke and what are my options right now");
  assert.equal(cls.mode, "ooc", "routes to OOC, not action");
  assert.equal(cls.intent, "what is the smoke and what are my options right now", "the /ooc marker is stripped from the question");
  // A plain action must NOT be classified as OOC (guards against over-matching).
  assert.equal(classifyInput("open the ooc box").mode, "action");
});

test("BUG A: an OOC log entry renders as a distinct meta note — no YOU header, no roll", () => {
  const html = renderNarrationLog([
    { id: "ooc1", kind: "ooc", text: "The smoke is a signal fire from the ridge. You can head for it, wait, or press north." }
  ]);
  assert.match(html, /solo-log-ooc/, "rendered with the OOC note class");
  assert.match(html, /out of character/i, "labelled as an out-of-character reply");
  assert.match(html, /signal fire from the ridge/, "the GM reply text is shown");
  assert.doesNotMatch(html, /solo-log-you/, "an OOC note is NOT a turn — no YOU badge");
  assert.doesNotMatch(html, /solo-log-roll/, "an OOC note carries no roll tag");
});
