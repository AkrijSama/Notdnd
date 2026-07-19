// ISSUE 2 (owner ruling 2026-07-19): NO reserved left column, ever. The reading
// area spans full viewport width minus the right rail; the character/portrait dock
// FLOATS top-left as an overlay over the prose. String-based (HTML + CSS as text;
// no jsdom) — the layout is CSS-driven, so the CSS rules ARE the cross-width proof.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloSceneShell, renderSoloStageHud, dispatchSoloClick } from "../src/components/soloSceneShell.js";

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
  // MEASURE LAW AMENDMENT (owner 2026-07-19): the cap is RAISED to 1856px (= 1920 −
   // 2×32px padding) so lines fill common desktop; ultrawide caps, container full-bleed.
  const measure = rule(".solo-measure {");
  assert.match(measure, /max-width:\s*1856px/);
  assert.match(measure, /text-align:\s*left/);
});

test("no centered max-width FRAME: the game surface kills #app's 1400px band", () => {
  // The whole viewport is used when the game shell is mounted (owner 2026-07-19).
  const kill = rule("#app:has(.solo-game-shell) {");
  assert.match(kill, /max-width:\s*none/);
  assert.match(kill, /padding:\s*0/);
});

test("prose is LEFT-ANCHORED at the measure, never a centered column (the ultrawide bands)", () => {
  // The measured column hugs the padded LEFT edge — margin-left:0, not auto.
  const child = rule(".solo-narration-log > * {");
  assert.match(child, /max-width:\s*1856px/); // raised measure (amendment 2026-07-19)
  assert.match(child, /margin-left:\s*0/);
  assert.doesNotMatch(child, /margin-left:\s*auto/);
  assert.match(rule(".solo-log-entry {"), /margin:\s*0 0 34px/);
});

test("the right-rail CSS is fully gone (no orphan column cruft); mobile still stacks the dock", () => {
  // The owner ruled the right column dead (2026-07-19). The container CSS must not
  // linger — a dead .solo-game-rail rule would green a "rail survives" test while
  // nothing renders it. Its former contents live in .solo-info-drawer now.
  assert.ok(!CSS.includes(".solo-game-rail"), "no .solo-game-rail rules remain in the stylesheet");
  // At <=1080px the frame stacks and the floating dock returns to normal flow —
  // still no reserved LEFT column (it's a full-width top band on mobile).
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 1080px)"));
  assert.match(mobile, /\.solo-game-sidebar[\s\S]*?position:\s*static/);
});

test("NO right column: dock + full-width main + stage HUD + drawers, rail absent", () => {
  const html = renderSoloSceneShell({ scene: { locationImageUri: null }, narrationLog: [{ id: "n1", text: "A beat." }] });
  assert.match(html, /solo-portrait-dock-aside/); // the floating dock (top-left)
  assert.match(html, /solo-game-main/); // the full-width reading area
  assert.doesNotMatch(html, /solo-game-rail/); // the right rail is GONE (owner 2026-07-19)
  assert.match(html, /solo-stage-hud/); // map + time/weather float on the banner
  assert.match(html, /solo-info-drawer/); // cast/exits are an on-demand drawer
  assert.match(html, /solo-map-drawer/); // the full map is an on-demand drawer
});

const clickTarget = (attrs) => ({
  closest: (sel) => {
    const key = sel.replace(/^\[|\]$/g, "");
    return key in attrs ? { getAttribute: (a) => attrs[a === key ? key : a] ?? null } : null;
  }
});

test("the stage-HUD toggles open the map / info drawers (open + close routes)", () => {
  const calls = {};
  const h = {
    onSceneMap: () => { calls.map = true; },
    onSceneMapClose: () => { calls.mapClose = true; },
    onSceneInfo: () => { calls.info = true; },
    onSceneInfoClose: () => { calls.infoClose = true; },
    onMapView: (x) => { calls.view = x.view; }
  };
  dispatchSoloClick(clickTarget({ "data-solo-scene-map": "" }), h);
  dispatchSoloClick(clickTarget({ "data-solo-scene-map-close": "" }), h);
  dispatchSoloClick(clickTarget({ "data-solo-scene-info": "" }), h);
  dispatchSoloClick(clickTarget({ "data-solo-scene-info-close": "" }), h);
  dispatchSoloClick(clickTarget({ "data-solo-map-view": "region" }), h);
  assert.deepEqual(calls, { map: true, mapClose: true, info: true, infoClose: true, view: "region" });
});

test("empty-state law: no dead boxes — the time chip hides with no clock, HUD stays compact", () => {
  const noClock = renderSoloStageHud({ cast: [], regionMap: { current: "a", nodes: [], edges: [] } }, { mapView: "local" });
  assert.doesNotMatch(noClock, /solo-hud-time/);
  assert.match(noClock, /solo-hud-info/); // exits always exist → the toggle stays
  assert.doesNotMatch(noClock, /Cast \d/);
  const full = renderSoloStageHud({ cast: [{ present: true }], worldTime: { clock: "07:00", phase: "day", day: 1 } }, { mapView: "local" });
  assert.match(full, /solo-hud-time/);
  assert.match(full, /Cast 1/);
});
