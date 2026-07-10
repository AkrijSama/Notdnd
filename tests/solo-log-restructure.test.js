import assert from "node:assert/strict";
import test from "node:test";
import {
  renderNarrationLog,
  renderSoloSceneInputBar,
  dispatchSoloClick,
  normalizeLogScale
} from "../src/components/soloSceneShell.js";

// #44/#46/#47 — the log renders delineated TURN UNITS with a prominent player anchor.

test("a turn with an action renders a prominent player-action anchor + has-action unit", () => {
  const html = renderNarrationLog([
    { id: "n1", intent: "force the door", checkResult: { total: 18, dc: 12 }, band: "success", text: "The door gives way." }
  ]);
  assert.match(html, /solo-log-entry has-action/, "turn is a delineated unit");
  assert.match(html, /class="solo-log-you">You</, "YOU badge present");
  // Bug B (2026-07-10): the intent renders verbatim, with the full text also in the
  // title attr for hover (long inputs truncate the display only).
  assert.match(html, /solo-log-intent" title="force the door">force the door</, "intent shown prominently");
  assert.match(html, /solo-log-roll band-success/, "band-coded roll present");
});

test("the opening / ambient entry (no action) is NOT a false turn boundary", () => {
  const html = renderNarrationLog([{ id: "n1", intent: "", text: "The tavern breathes smoke and old ash." }]);
  assert.doesNotMatch(html, /has-action/, "no turn divider for headerless prose");
  assert.doesNotMatch(html, /solo-log-you/, "no YOU badge on the opening");
  assert.match(html, /solo-log-prose/, "prose still renders");
});

test("every action turn gets a header — a no-roll action still shows its anchor", () => {
  const html = renderNarrationLog([{ id: "n2", intent: "Search the area", checkResult: null, text: "You find a loose flagstone." }]);
  assert.match(html, /has-action/);
  assert.match(html, /solo-log-intent" title="Search the area">Search the area</);
  assert.doesNotMatch(html, /solo-log-roll/, "no roll tag when there was no check");
});

// #48 — narration font-size control.

test("normalizeLogScale clamps to the readable band and quantizes to 0.1", () => {
  assert.equal(normalizeLogScale(0.5), 0.8);
  assert.equal(normalizeLogScale(2), 1.6);
  assert.equal(normalizeLogScale(1.15), 1.2);
  assert.equal(normalizeLogScale("1.3"), 1.3);
  assert.equal(normalizeLogScale(NaN), 1);
  assert.equal(normalizeLogScale(undefined), 1);
});

test("the input bar exposes the A−/A+ narration text-size control", () => {
  const html = renderSoloSceneInputBar({ attemptDraft: "" });
  assert.match(html, /data-solo-logfont="down"/);
  assert.match(html, /data-solo-logfont="up"/);
});

test("dispatchSoloClick routes the font-size buttons to onLogFontScale", () => {
  const dirs = [];
  dispatchSoloClick({ closest: (s) => (s === "[data-solo-logfont]" ? { getAttribute: () => "up" } : null) }, { onLogFontScale: (a) => dirs.push(a) });
  dispatchSoloClick({ closest: (s) => (s === "[data-solo-logfont]" ? { getAttribute: () => "down" } : null) }, { onLogFontScale: (a) => dirs.push(a) });
  assert.deepEqual(dirs, [{ dir: "up" }, { dir: "down" }]);
});
