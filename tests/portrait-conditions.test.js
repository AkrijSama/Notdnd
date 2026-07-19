// PORTRAIT CONDITION CHIPS (owner append 2026-07-19): buff/debuff chips anchor to the
// portrait's TOP-LEFT corner as a downward column, each a solid dark pill + 1px light
// border so it reads against ANY portrait palette (a yellow portrait swallowed the old
// translucent chip). The char-tab badge keeps TOP-RIGHT; cap 4 visible + "+N" overflow
// into the character sheet. String-based (HTML + CSS as text; no jsdom).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloConditionsHud } from "../src/components/soloSceneShell.js";

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const rule = (selector) => {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `rule ${selector} present`);
  return CSS.slice(i, CSS.indexOf("}", i) + 1);
};
const sixConds = {
  player: {
    conditions: [
      { id: "c1", name: "Blessed", kind: "buff", effect: "+2 resolve", remainingMinutes: 30 },
      { id: "c2", name: "Bleeding", kind: "debuff", effect: "lose 1/min", remainingMinutes: 10, stacks: 2 },
      { id: "c3", name: "Marked", kind: "mark", effect: "the Stag knows you" },
      { id: "c4", name: "Hidden", kind: "neutral", effect: "unseen" },
      { id: "c5", name: "Rooted", kind: "control", effect: "cannot move", remainingMinutes: 2 },
      { id: "c6", name: "Inspired", kind: "buff", effect: "+1 next roll" }
    ]
  }
};

test("compact chips cap at 4 visible + a '+N' overflow pill that opens the character sheet", () => {
  const html = renderSoloConditionsHud(sixConds, { compact: true });
  const chipCount = (html.match(/solo-cond-chip/g) || []).length;
  assert.equal(chipCount, 5, "4 condition chips + 1 overflow pill");
  assert.match(html, /solo-cond-overflow[^>]*data-solo-char-tab/, "the overflow pill routes into the character sheet");
  assert.match(html, />\+2</, "the pill shows the hidden count (+2)");
});

test("a stacked condition shows its count; the tooltip carries name + duration", () => {
  // a small set so the stacked chip is within the visible cap (debuffs group last)
  const html = renderSoloConditionsHud(
    { player: { conditions: [{ id: "c2", name: "Bleeding", kind: "debuff", effect: "lose 1/min", remainingMinutes: 10, stacks: 2 }] } },
    { compact: true }
  );
  assert.match(html, /solo-cond-count[^>]*>2</, "the x2 stack renders a count");
  assert.match(html, /Time remaining: 10m\./, "duration is in the tooltip body");
});

test("non-compact (sheet/rail) shows ALL conditions, no overflow pill", () => {
  const html = renderSoloConditionsHud(sixConds, { compact: false });
  assert.equal((html.match(/solo-cond-chip/g) || []).length, 6, "all six, no cap");
  assert.doesNotMatch(html, /solo-cond-overflow/);
});

test("CSS: the chip column anchors TOP-LEFT and stacks downward, clear of the badge corner", () => {
  const conds = rule(".solo-portrait-conds {");
  assert.match(conds, /top:\s*4px/);
  assert.match(conds, /left:\s*4px/);
  assert.match(conds, /right:\s*auto/);
  assert.match(conds, /bottom:\s*auto/);
  assert.match(conds, /max-width:\s*calc\(100% - 44px\)/, "reserves the top-right badge corner");
  const col = rule(".solo-conditions-portrait {");
  assert.match(col, /flex-direction:\s*column/);
  assert.match(col, /flex-wrap:\s*nowrap/);
  // the badge keeps the top-right corner
  const badge = rule(".solo-portrait-badge {");
  assert.match(badge, /top:\s*6px/);
  assert.match(badge, /right:\s*6px/);
});

test("CSS: each compact chip has the solid-contrast backing (opaque dark pill + light border)", () => {
  const chip = rule(".solo-portrait-conds .solo-cond-chip.is-compact {");
  // opaque dark pill (alpha 0.92, not the old translucent color-mix that vanished)
  assert.match(chip, /background:\s*rgba\(10, 10, 12, 0\.92\)/);
  assert.doesNotMatch(chip, /color-mix/, "no translucent color-mix backing");
  assert.match(chip, /border:\s*1px solid rgba\(232, 234, 240, 0\.55\)/, "1px light border");
  assert.match(chip, /border-radius:\s*999px/, "pill");
  // accent: buffs = ok, debuffs = warn
  assert.match(rule(".solo-portrait-conds .solo-cond-chip.is-compact.cond-buff {"), /border-color:\s*rgba\(150, 210, 140/);
  assert.match(rule(".solo-portrait-conds .solo-cond-chip.is-compact.cond-debuff {"), /border-color:\s*rgba\(232, 130, 130/);
});

// ── PAIRWISE BOUNDING-BOX (portrait-dock state): badge ∩ chip column = ∅ ──────────
test("bounding-box: the badge (top-right) never intersects the chip column (top-left) at 1280 / 1920 / 3440", () => {
  // portrait is square, width clamp(120,12vw,172). badge: right:6, width 30 → left = W-36.
  // chip column: left:4, max-width calc(100% - 44px) → right ≤ 4 + (W-44) = W-40.
  // W-40 < W-36 by 4px at EVERY width — the max-width guard makes it width-independent.
  const clamp = /width:\s*clamp\((\d+)px,\s*(\d+)vw,\s*(\d+)px\)/.exec(rule(".solo-game-sidebar.solo-portrait-dock-aside {"))
    || /width:\s*clamp\((\d+)px,\s*(\d+)vw,\s*(\d+)px\)/.exec(rule(".solo-game-sidebar {"));
  const [min, vw, max] = [Number(clamp[1]), Number(clamp[2]), Number(clamp[3])];
  const badgeRight = 6, badgeW = 30, chipLeft = 4, reserve = 44;
  for (const vp of [1280, 1920, 3440]) {
    const W = Math.max(min, Math.min((vw / 100) * vp, max)); // portrait (square) width
    const badgeLeft = W - badgeRight - badgeW; // 30px badge, 6px inset
    const chipColRight = chipLeft + (W - reserve); // capped by max-width
    assert.ok(chipColRight < badgeLeft, `chipCol.right ${chipColRight} < badge.left ${badgeLeft} @${vp} (portrait ${Math.round(W)}px)`);
  }
});
