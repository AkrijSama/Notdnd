import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  renderSoloConditionsHud,
  renderSoloSceneShell,
  CONDITION_KIND_META,
  formatConditionDuration,
  dispatchSoloClick
} from "../src/components/soloSceneShell.js";

// CONDITIONS HUD v2 (item 1, bucket-2): kind is SERVER-MINTED and rides the
// payload — { id, name, effect, kind, remainingMinutes|null, permanent }.
// Multi-channel encoding (colorblind-safe): color family + mandatory glyph +
// kind word in aria/tooltip. Grouped buffs → marks → neutral → control → debuffs.

const palmMark = {
  id: "palm_mark",
  name: "Palm-Mark",
  effect: "A warm sigil pressed into your palm suppresses the forest's distortion.",
  kind: "mark",
  remainingMinutes: 180,
  permanent: false
};

const sceneWith = (conditions) => ({ location: { name: "T" }, player: { displayName: "Bram", conditions } });

test("chip renders from a server-minted condition with name + duration + kind channel", () => {
  const html = renderSoloConditionsHud(sceneWith([palmMark]));
  assert.match(html, /solo-cond-chip cond-mark/);
  assert.match(html, /solo-cond-name">Palm-Mark</);
  assert.match(html, /solo-cond-time">≈3h</, "180 world-minutes reads ≈3h");
  assert.match(html, /tabindex="0"/, "chip is keyboard-focusable");
});

test("EVERY kind renders its mandatory glyph + color class (color alone is banned)", () => {
  const all = [
    { id: "b", name: "Blessed", effect: "x", kind: "buff" },
    { id: "d", name: "Poisoned", effect: "x", kind: "debuff" },
    { id: "m", name: "Palm-Mark", effect: "x", kind: "mark" },
    { id: "c", name: "Restrained", effect: "x", kind: "control" },
    { id: "n", name: "Soaked", effect: "x", kind: "neutral" }
  ];
  const html = renderSoloConditionsHud(sceneWith(all));
  for (const [kind, meta] of Object.entries(CONDITION_KIND_META)) {
    assert.match(html, new RegExp(`cond-${kind}`), `${kind} color-family class`);
    assert.ok(html.includes(`>${meta.glyph}<`), `${kind} glyph ${meta.glyph} present (color-independent channel)`);
  }
  // screen-reader label carries the kind WORD
  assert.match(html, /aria-label="Blessed\. Buff\./);
  assert.match(html, /aria-label="Poisoned\. Debuff\./);
  assert.match(html, /aria-label="Restrained\. Control\./);
});

test("grouping pinned: buffs → marks → neutral → control → debuffs, never interleaved", () => {
  const shuffled = [
    { id: "d1", name: "Poisoned", kind: "debuff" },
    { id: "b1", name: "Blessed", kind: "buff" },
    { id: "c1", name: "Restrained", kind: "control" },
    { id: "m1", name: "Palm-Mark", kind: "mark" },
    { id: "n1", name: "Soaked", kind: "neutral" },
    { id: "b2", name: "Warded", kind: "buff" }
  ];
  const html = renderSoloConditionsHud(sceneWith(shuffled));
  const order = [...html.matchAll(/cond-(buff|debuff|mark|control|neutral)/g)].map((m) => m[1]);
  assert.deepEqual(order, ["buff", "buff", "mark", "neutral", "control", "debuff"], "grouped in canon order, stable within group");
});

test("tooltip carries full name + KIND WORD + description + remaining duration", () => {
  const html = renderSoloConditionsHud(sceneWith([palmMark]));
  assert.match(html, /solo-cond-tip" role="tooltip"/);
  assert.match(html, /<strong>Palm-Mark · Mark<\/strong>/, "tooltip names the kind");
  assert.match(html, /suppresses the forest(&#0?39;|')s distortion/);
  assert.match(html, /Time remaining: ≈3h\./);
  const perm = renderSoloConditionsHud(sceneWith([{ ...palmMark, permanent: true, remainingMinutes: null }]));
  assert.match(perm, /Lasts until cleared\./);
  assert.doesNotMatch(perm, /solo-cond-time/, "no duration chip when permanent");
});

test("unknown/absent kind falls back to neutral rendering (never crashes, never guesses)", () => {
  const html = renderSoloConditionsHud(sceneWith([{ id: "x", name: "Odd", effect: "?", kind: "banana" }, { id: "y", name: "Old", effect: "?" }]));
  const neutrals = [...html.matchAll(/cond-neutral/g)];
  assert.equal(neutrals.length, 2, "both render as neutral");
});

test("the client word-guessing classifier is DELETED (no import, no regex remains)", () => {
  const src = fs.readFileSync(new URL("../src/components/soloSceneShell.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /classifyConditionHue/, "classifier function gone");
  assert.doesNotMatch(src, /CONDITION_BUFF_RE|CONDITION_DEBUFF_RE/, "word-guess regexes gone");
});

test("chip disappears when the condition sheds (absent from state)", () => {
  const withCond = renderSoloSceneShell({ scene: sceneWith([palmMark]) });
  assert.match(withCond, /Palm-Mark/);
  const shed = renderSoloSceneShell({ scene: sceneWith([]) });
  assert.doesNotMatch(shed, /Palm-Mark/);
  assert.doesNotMatch(shed, /solo-cond-chip/);
});

test("empty state renders NOTHING (no placeholder text)", () => {
  assert.equal(renderSoloConditionsHud(sceneWith([])), "");
  assert.equal(renderSoloConditionsHud({}), "");
  const html = renderSoloSceneShell({ scene: sceneWith([]) });
  assert.doesNotMatch(html, /No effects/i);
  assert.match(html, /data-solo-conditions/, "stable wrapper still present for the fast-path");
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
