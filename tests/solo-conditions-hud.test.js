import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSoloConditionsHud,
  renderSoloSceneShell,
  classifyConditionHue,
  formatConditionDuration,
  dispatchSoloClick
} from "../src/components/soloSceneShell.js";

// CONDITIONS HUD (#26 made visible). Shape from conditionStatusPayload:
//   { id, name, effect, remainingMinutes|null, permanent }

const palmMark = {
  id: "palm_mark",
  name: "Palm-Mark",
  effect: "A warm sigil pressed into your palm suppresses the forest's distortion.",
  remainingMinutes: 180,
  permanent: false
};

const sceneWith = (conditions) => ({ location: { name: "T" }, player: { displayName: "Bram", conditions } });

// (a) chip renders from a mock condition with name/duration
test("chip renders from a mock condition with name + duration", () => {
  const html = renderSoloConditionsHud(sceneWith([palmMark]));
  assert.match(html, /solo-cond-chip/);
  assert.match(html, /solo-cond-name">Palm-Mark</);
  assert.match(html, /solo-cond-time">≈3h</, "180 world-minutes reads ≈3h");
  assert.match(html, /tabindex="0"/, "chip is keyboard-focusable");
  assert.match(html, /cond-buff/, "suppresses → buff hue (presentation heuristic)");
});

// (b) tooltip content matches the condition description
test("tooltip carries full name + description + remaining duration", () => {
  const html = renderSoloConditionsHud(sceneWith([palmMark]));
  assert.match(html, /solo-cond-tip" role="tooltip"/);
  assert.match(html, /<strong>Palm-Mark<\/strong>/);
  assert.match(html, /suppresses the forest(&#0?39;|')s distortion/);
  assert.match(html, /Time remaining: ≈3h\./);
  // permanent variant reads "until cleared"
  const perm = renderSoloConditionsHud(sceneWith([{ ...palmMark, permanent: true, remainingMinutes: null }]));
  assert.match(perm, /Lasts until cleared\./);
  assert.doesNotMatch(perm, /solo-cond-time/, "no duration chip when permanent");
});

// (c) chip disappears when the condition is absent from state
test("chip disappears when the condition sheds (absent from state)", () => {
  const withCond = renderSoloSceneShell({ scene: sceneWith([palmMark]) });
  assert.match(withCond, /Palm-Mark/);
  const shed = renderSoloSceneShell({ scene: sceneWith([]) });
  assert.doesNotMatch(shed, /Palm-Mark/);
  assert.doesNotMatch(shed, /solo-cond-chip/);
});

// (d) empty state renders nothing visible
test("empty state renders NOTHING (no placeholder text)", () => {
  assert.equal(renderSoloConditionsHud(sceneWith([])), "");
  assert.equal(renderSoloConditionsHud({}), "");
  const html = renderSoloSceneShell({ scene: sceneWith([]) });
  assert.doesNotMatch(html, /No effects/i);
  assert.match(html, /data-solo-conditions/, "stable wrapper still present for the fast-path");
});

// hue semantics + duration formatting
test("hue heuristic: debuff words red, buff words green, unknown neutral (data gap flagged)", () => {
  assert.equal(classifyConditionHue({ name: "Exhausted", effect: "" }), "debuff");
  assert.equal(classifyConditionHue({ name: "Blessed", effect: "" }), "buff");
  assert.equal(classifyConditionHue({ name: "Marked", effect: "something opaque" }), "neutral");
});

test("duration formatting: minutes → m/h/d", () => {
  assert.equal(formatConditionDuration(45), "45m");
  assert.equal(formatConditionDuration(180), "≈3h");
  assert.equal(formatConditionDuration(2880), "≈2d");
  assert.equal(formatConditionDuration(null), "");
});

// interactive spot-check (the f3ae7eb rule): dock input, sizer, VN controls intact
test("spot-check: sizer + VN + exit dispatch still fire; input bar renders", async () => {
  const T = (m) => ({ closest: (s) => (s in m ? { getAttribute: (a) => (m[s] || {})[a] ?? null } : null) });
  let fired = 0;
  dispatchSoloClick(T({ "[data-solo-logfont]": { "data-solo-logfont": "up" } }), { onLogFontScale: () => fired++ });
  dispatchSoloClick(T({ "[data-solo-dialogue-reply-submit]": {} }), { onDialogueReply: () => fired++ });
  dispatchSoloClick(T({ "[data-solo-exit]": {} }), { onExit: () => fired++ });
  assert.equal(fired, 3);
  const { renderSoloSceneInputBar } = await import("../src/components/soloSceneShell.js");
  assert.match(renderSoloSceneInputBar({ attemptDraft: "" }), /data-solo-attempt-input/);
});
