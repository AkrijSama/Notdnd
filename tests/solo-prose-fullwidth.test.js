// ISSUE 2 (owner ruling 2026-07-19): NO reserved left column, ever. The reading
// area spans full viewport width minus the right rail; the character/portrait dock
// FLOATS top-left as an overlay over the prose. String-based (HTML + CSS as text;
// no jsdom) — the layout is CSS-driven, so the CSS rules ARE the cross-width proof.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloSceneShell } from "../src/components/soloSceneShell.js";

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const rule = (selector) => {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `rule ${selector} present`);
  return CSS.slice(i, CSS.indexOf("}", i) + 1);
};

test("the character dock is a FLOATING OVERLAY (absolute), not a reserved column", () => {
  // The specific dock rule (the one that wins the cascade) is absolute-positioned.
  const dock = rule(".solo-game-sidebar.solo-portrait-dock-aside {");
  assert.match(dock, /position:\s*absolute/);
  // The frame is the positioning anchor for the overlay.
  assert.match(rule(".solo-game-frame {"), /position:\s*relative/);
  // The base sidebar rule also floats (top-left, drawer-tier z), never a column.
  const base = rule(".solo-game-sidebar {");
  assert.match(base, /position:\s*absolute/);
  assert.match(base, /left:\s*8px/);
  assert.match(base, /z-index:\s*40/);
});

test("the reading area spans full width; the sealed measure still governs line length", () => {
  // main is flex:1 — with the dock out of flow it fills page-edge to the rail.
  assert.match(rule(".solo-game-main {"), /flex:\s*1/);
  // The sealed measure is UNCHANGED (edge-to-edge, left-anchored — owner 2026-07-09).
  const measure = rule(".solo-measure {");
  assert.match(measure, /max-width:\s*none/);
  assert.match(measure, /text-align:\s*left/);
});

test("the right rail remains a real column; mobile stacks (no floating dock)", () => {
  assert.ok(CSS.includes(".solo-game-rail"), "right rail column present");
  // At <=1080px the frame stacks and the dock returns to normal flow — still no
  // reserved LEFT column (it's a full-width top band on mobile).
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 1080px)"));
  assert.match(mobile, /\.solo-game-sidebar[\s\S]*?position:\s*static/);
});

test("the shell renders dock + full-width main + rail (structure holds at every width)", () => {
  const html = renderSoloSceneShell({ scene: { locationImageUri: null }, narrationLog: [{ id: "n1", text: "A beat." }] });
  assert.match(html, /solo-portrait-dock-aside/); // the floating dock
  assert.match(html, /solo-game-main/); // the full-width reading area
  assert.match(html, /solo-game-rail/); // the right rail column
});
