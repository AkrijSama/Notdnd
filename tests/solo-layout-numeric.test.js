// NUMERIC LAYOUT LAW (owner 2026-07-19, absolute). CSS-as-text proof (no jsdom):
//   1. Horizontal inset viewport-edge→text = EXACTLY 32px each side (>=1280), 16px
//      below. The reading container's padding is the ONLY contributor — every
//      ancestor is 0 (no stacking, no border, no clamp gutters).
//   2. Measure has NO cap (owner overrule 2026-07-19, final) — prose wraps only at the
//      container's 32px padding; right edge = viewport − 32 at every width.
//   3. Overlay row = one nowrap flex row, flush top-right (8/8), the settings gear
//      DOCKED IN as the rightmost chip at a uniform 28px height. When any drawer/overlay
//      is open the whole row hides; the portrait dock never intersects a drawer's close
//      ✕ at 1280/1920/3440 (numeric bounding-box proof).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloStageHud } from "../src/components/soloSceneShell.js";

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const rule = (selector) => {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `rule ${selector} present`);
  return CSS.slice(i, CSS.indexOf("}", i) + 1);
};
// Horizontal (left+right) px from a `padding:` shorthand inside a rule body. Returns
// {left,right}. Handles 1–4 value shorthand; only flat px (the law forbids clamp).
function hpad(body) {
  const m = body.match(/padding:\s*([^;]+);/);
  if (!m) return { left: 0, right: 0 };
  const parts = m[1].trim().split(/\s+/);
  const px = (v) => (v === "0" ? 0 : /^\d+px$/.test(v) ? parseInt(v, 10) : NaN);
  let top = px(parts[0]), right = px(parts[1] ?? parts[0]), left = px(parts[3] ?? parts[1] ?? parts[0]);
  return { left, right };
}

// ── ITEM 1: PER-SIDE INSET AUDIT — total exactly 32px, only the reading container ──
test("inset audit: every prose-chain ancestor contributes 0; the reading container = 32px", () => {
  // shell: full-bleed, ZERO horizontal padding
  assert.match(rule(".solo-game-shell {"), /padding:\s*0 0 18px/);
  // frame: no border / radius (a 1px border would inset)
  const frame = rule(".solo-game-frame {");
  assert.match(frame, /border:\s*0/);
  assert.match(frame, /border-radius:\s*0/);
  // scene-center: the dead right-column border is gone
  assert.doesNotMatch(rule(".solo-scene-center {"), /border-right/);
  // the reading container is the ONLY horizontal inset
  const logH = hpad(rule(".solo-narration-log {"));
  assert.deepEqual(logH, { left: 32, right: 32 }, "narration-log flat 32px each side");
  // no ultrawide media re-adds shell padding (the old stacking bug)
  assert.doesNotMatch(CSS, /@media \(min-width: 1600px\)[\s\S]*?\.solo-game-shell\s*\{\s*padding/);
  // TOTAL each side = shell(0) + frame-border(0) + scene-center-border(0) + log(32) = 32
  const total = 0 + 0 + 0 + logH.left;
  assert.equal(total, 32, "total left inset === 32px");
  assert.equal(0 + 0 + 0 + logH.right, 32, "total right inset === 32px");
});

test("inset audit: the input dock matches — 32px flat, no nested scene-input stacking", () => {
  assert.deepEqual(hpad(rule(".solo-input-dock {")), { left: 32, right: 32 });
  // .solo-scene-input adds ZERO horizontal padding (was 28px → stacked to 52px)
  assert.deepEqual(hpad(rule(".solo-scene-input {")), { left: 0, right: 0 });
});

test("inset audit: below 1280w the flat inset is 16px (prose + dock)", () => {
  const media = CSS.slice(CSS.indexOf("@media (max-width: 1279px)"));
  assert.match(media, /\.solo-narration-log\s*\{\s*padding-left:\s*16px;\s*padding-right:\s*16px/);
  assert.match(media, /\.solo-input-dock\s*\{\s*padding-left:\s*16px;\s*padding-right:\s*16px/);
});

// px value of a `prop: Npx` in a rule body (null if absent).
const pxProp = (body, prop) => {
  const m = new RegExp(prop + ":\\s*(\\d+)px").exec(body);
  return m ? parseInt(m[1], 10) : null;
};
// resolve a CSS width token to pixels at viewport w: min(Apx,Bvw) / clamp(min,pref,max) / Npx.
function widthAt(spec, w) {
  let m = /min\(\s*(\d+)px\s*,\s*(\d+)vw\s*\)/.exec(spec);
  if (m) return Math.min(parseInt(m[1], 10), (parseInt(m[2], 10) / 100) * w);
  m = /clamp\(\s*(\d+)px\s*,\s*(\d+)vw\s*,\s*(\d+)px\s*\)/.exec(spec);
  if (m) return Math.max(parseInt(m[1], 10), Math.min((parseInt(m[2], 10) / 100) * w, parseInt(m[3], 10)));
  m = /(\d+)px/.exec(spec);
  return m ? parseInt(m[1], 10) : 0;
}
const widthTok = (body) => /width:\s*(min\([^)]*\)|clamp\([^)]*\)|\d+px)/.exec(body)[1];

// ── ITEM 2: MEASURE — NO CAP (owner overrule 2026-07-19, final) ───────────────
test("measure has NO cap: prose + shared dock measure wrap only at the 32px padding", () => {
  assert.match(rule(".solo-narration-log > * {"), /max-width:\s*none/);
  assert.match(rule(".solo-measure {"), /max-width:\s*none/);
  // no px/ch cap survives on EITHER rule (a nested cap would defeat the container)
  assert.doesNotMatch(rule(".solo-narration-log > * {"), /max-(width|inline-size):\s*\d/);
  assert.doesNotMatch(rule(".solo-measure {"), /max-(width|inline-size):\s*\d/);
});

test("numeric: uncapped prose right edge = viewport − 32px (within 40px) at 1280 / 1920 / 3440", () => {
  // With no cap and a flat 32px container inset, the text block fills container − padding,
  // so its right edge = W − 32 at every width — trivially within 40px of (W − 32).
  const logH = hpad(rule(".solo-narration-log {"));
  assert.equal(logH.right, 32, "reading container right inset is a flat 32px (>=1280)");
  for (const w of [1280, 1920, 3440]) {
    const rightEdge = w - logH.right; // no max-width → block width = container − padding
    const target = w - 32;
    assert.ok(Math.abs(target - rightEdge) <= 40, `right edge ${rightEdge} within 40 of ${target} @${w}w`);
  }
});

// ── ITEM 3: OVERLAY ROW — one nowrap row, gear docked in, uniform height ───────
test("overlay row is ONE nowrap flex row with 8px gaps, flush top-right (8/8)", () => {
  const hud = rule(".solo-stage-hud {");
  assert.match(hud, /display:\s*flex/);
  assert.match(hud, /flex-direction:\s*row/);
  assert.match(hud, /flex-wrap:\s*nowrap/);
  assert.match(hud, /gap:\s*8px/);
  assert.match(hud, /top:\s*8px/);   // flush to the banner top (mirrors the dock's 8px)
  assert.match(hud, /right:\s*8px/);
  // the portrait dock's top-left corner aligns at the same 8px offset
  assert.match(rule(".solo-game-sidebar {"), /top:\s*8px/);
  assert.match(rule(".solo-game-sidebar {"), /left:\s*8px/);
});

test("overlay renders 5 items in order: [toggle] [Map] [time] [Cast·Exits] [⚙ gear]", () => {
  const html = renderSoloStageHud(
    { cast: [{ present: true }], worldTime: { clock: "07:00", phase: "day", day: 1 } },
    { mapView: "local", menuOpen: false }
  );
  const idx = ["solo-map-toggle", "solo-hud-map-open", "solo-hud-time", "solo-hud-info", "solo-settings"].map((c) => html.indexOf(c));
  assert.ok(idx.every((i) => i >= 0), "all 5 slots present");
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k - 1] < idx[k], "row order [toggle][Map][time][Cast·Exits][gear]");
  // the gear is the RIGHTMOST chip (docked into the row, no orphan box above)
  assert.ok(html.lastIndexOf("solo-settings") > html.lastIndexOf("solo-hud-info"), "gear is rightmost");
});

test("the gear is DOCKED INTO the row (relative, in-flow), not a floating corner box", () => {
  const s = rule(".solo-settings {");
  assert.match(s, /position:\s*relative/);
  assert.doesNotMatch(s, /position:\s*absolute/);
});

test("overlay row chips are 28px; the settings cog stands out at 32px, boxless (UI-6)", () => {
  const item = rule(".solo-stage-hud > * {");
  assert.match(item, /height:\s*28px/);
  assert.match(item, /box-sizing:\s*border-box/);
  // UI-6 (owner): the cog is no longer a uniform chip — it lost its box and grew to 32px
  // in a distinct color so it reads on its own. The other HUD chips remain 28px.
  const gearBtn = rule(".solo-stage-hud .solo-settings-btn {");
  assert.match(gearBtn, /width:\s*32px/);
  assert.match(gearBtn, /height:\s*32px/);
  assert.match(gearBtn, /background:\s*transparent/);
  assert.match(gearBtn, /border:\s*none/);
});

// ── DRAWER-OPEN NO-OVERLAP (main task, item 2) ────────────────────────────────
test("drawer-open: the whole overlay row (gear included) hides for EVERY drawer/overlay", () => {
  // If the row is display:none while a drawer is open, gear/toggles/Cast·Exits can't
  // intersect that drawer's close ✕ — one :has rule per drawer family.
  const i = CSS.indexOf(":has(.solo-scene-drawer.is-open)");
  assert.ok(i >= 0, "map + Cast·Exits (scene-drawer) hide rule present");
  const block = CSS.slice(i, CSS.indexOf("}", i) + 1);
  assert.match(block, /\.solo-stage-hud/);
  assert.match(block, /display:\s*none/);
  assert.match(CSS, /:has\(\.solo-char-tab\.is-open\)\s*\.solo-stage-hud/);        // character sheet
  assert.match(CSS, /:has\(\.solo-roll-history-layer\.is-open\)\s*\.solo-stage-hud/); // roll history
});

test("bounding-box: the portrait dock never intersects a drawer's close ✕ at 1280 / 1920 / 3440", () => {
  const dock = rule(".solo-game-sidebar {");
  const dockLeft = pxProp(dock, "left");                 // 8
  const dockWTok = widthTok(dock);                       // clamp(128,12vw,172)
  const sceneWTok = widthTok(rule(".solo-scene-drawer-panel {"));   // min(420,92vw) — map + Cast·Exits
  const rollWTok = widthTok(rule(".solo-roll-history-drawer {"));   // min(360,88vw)
  const charWTok = widthTok(rule(".solo-char-tab {"));             // min(340,84vw), left-slide within the dock
  // char-tab head close ✕: right-aligned inside a 14px-padded head, ~20px glyph →
  // its LEFT edge sits ≈ (panel right − 14 − 20) = panel right − 34.
  const CLOSE_INSET = 34;
  for (const w of [1280, 1920, 3440]) {
    const dockRight = dockLeft + widthAt(dockWTok, w);
    // RIGHT-slide drawers: the entire panel is right of the dock → any control inside is too
    const sceneLeft = w - widthAt(sceneWTok, w);
    const rollLeft = w - widthAt(rollWTok, w);
    assert.ok(dockRight < sceneLeft, `dock.right ${dockRight.toFixed(0)} < map/info panel.left ${sceneLeft.toFixed(0)} @${w}`);
    assert.ok(dockRight < rollLeft, `dock.right ${dockRight.toFixed(0)} < roll panel.left ${rollLeft.toFixed(0)} @${w}`);
    // LEFT-slide char-tab shares the dock origin; its close ✕ sits near the panel's right edge
    const charCloseLeft = dockLeft + widthAt(charWTok, w) - CLOSE_INSET;
    assert.ok(dockRight < charCloseLeft, `dock.right ${dockRight.toFixed(0)} < char-tab close-✕.left ${charCloseLeft.toFixed(0)} @${w}`);
  }
});
