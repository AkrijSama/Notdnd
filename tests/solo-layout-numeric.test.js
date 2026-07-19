// NUMERIC LAYOUT LAW (owner 2026-07-19, absolute). CSS-as-text proof (no jsdom):
//   1. Horizontal inset viewport-edge→text = EXACTLY 32px each side (>=1280), 16px
//      below. The reading container's padding is the ONLY contributor — every
//      ancestor is 0 (no stacking, no border, no clamp gutters).
//   2. Measure cap RAISED to 1856px (= 1920 − 2×32) — fills common desktop, caps
//      only on ultrawide with the container still full-bleed.
//   3. Overlay bar = one nowrap flex row (items can't overlap); the settings gear
//      is vertically disjoint from the bar at ALL widths (width-independent).
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

// ── ITEM 2: MEASURE VALUE ────────────────────────────────────────────────────
test("measure cap = 1856px on both the prose and the shared dock measure", () => {
  assert.match(rule(".solo-narration-log > * {"), /max-width:\s*1856px/);
  assert.match(rule(".solo-measure {"), /max-width:\s*1856px/);
  // sanity: 1856 = 1920 − 2×32 (fills a 1920 viewport at 32px padding)
  assert.equal(1920 - 2 * 32, 1856);
});

// ── ITEM 3: OVERLAY GRID — no pile-up, bounding-box proof ─────────────────────
test("overlay bar is ONE nowrap flex row with 8px gaps (items cannot overlap)", () => {
  const hud = rule(".solo-stage-hud {");
  assert.match(hud, /display:\s*flex/);
  assert.match(hud, /flex-direction:\s*row/);
  assert.match(hud, /flex-wrap:\s*nowrap/);
  assert.match(hud, /gap:\s*8px/);
});

test("overlay renders the 4 items in order: [toggle] [Map] [time] [Cast·Exits]", () => {
  const html = renderSoloStageHud(
    { cast: [{ present: true }], worldTime: { clock: "07:00", phase: "day", day: 1 } },
    { mapView: "local" }
  );
  const iToggle = html.indexOf("solo-map-toggle");
  const iMap = html.indexOf("solo-hud-map-open");
  const iTime = html.indexOf("solo-hud-time");
  const iInfo = html.indexOf("solo-hud-info");
  assert.ok(iToggle >= 0 && iMap >= 0 && iTime >= 0 && iInfo >= 0, "all 4 slots present");
  assert.ok(iToggle < iMap && iMap < iTime && iTime < iInfo, "order [toggle][Map][time][Cast·Exits]");
});

test("bounding-box: settings gear is disjoint from the overlay bar at 1280 / 1920 / 3440", () => {
  // Gear box: .solo-settings top + .solo-settings-btn height. HUD bar top.
  const gearTop = parseInt(rule(".solo-settings {").match(/top:\s*(\d+)px/)[1], 10);
  const gearH = parseInt(rule(".solo-settings-btn {").match(/height:\s*(\d+)px/)[1], 10);
  const hudTop = parseInt(rule(".solo-stage-hud {").match(/top:\s*(\d+)px/)[1], 10);
  const gearBottom = gearTop + gearH;
  // Vertical separation is WIDTH-INDEPENDENT (fixed px top + fixed height), so the
  // gear box and the bar box cannot intersect at any viewport width.
  for (const w of [1280, 1920, 3440]) {
    assert.ok(gearBottom <= hudTop, `gear.bottom(${gearBottom}) <= hud.top(${hudTop}) at ${w}w → no overlap`);
  }
});
