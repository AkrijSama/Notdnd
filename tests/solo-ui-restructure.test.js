import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  characterFromScenePlayer,
  renderSoloCharacterSidebar,
  renderBabelStatusWindow,
  renderSoloConditionsHud,
  renderSoloRollBanner,
  renderSoloRollHistory,
  renderSoloSceneShell,
  dispatchSoloClick
} from "../src/components/soloSceneShell.js";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function player(extra = {}) {
  return {
    displayName: "Rell",
    abilities: { strength: 10, dexterity: 12, constitution: 11, intelligence: 10, wisdom: 11, charisma: 10 },
    resources: { hp: { current: 9, max: 11 }, mp: { current: 0, max: 0 } },
    inventory: [{ id: "item_tonic", name: "Field tonic", qty: 2, description: "Bitter herbs.", usable: true }],
    conditions: [],
    ...extra
  };
}
const sceneWithConds = (conditions) => ({ player: { displayName: "Rell", conditions } });
const rollScene = {
  attemptHistory: [
    { eventId: "e1", intent: "force the door", checkResult: { total: 8, dc: 12, success: false } },
    { eventId: "e2", intent: "charm the guard", checkResult: { total: 17, dc: 12, success: true } }
  ]
};

// ── CHARACTER TAB (portrait badge → drawer) ─────────────────────────────────

test("portrait carries the character-tab badge; the sheet body lives in the tab drawer", () => {
  const character = characterFromScenePlayer(player(), null);
  const closed = renderSoloCharacterSidebar(character, { open: false, scene: {} });
  // Compact dock aside + a badge ON the portrait.
  assert.match(closed, /solo-game-sidebar solo-portrait-dock-aside/);
  assert.match(closed, /solo-portrait-badge[^>]*data-solo-char-tab/);
  // The tab panel exists but is closed (no is-open, aria-hidden true).
  assert.match(closed, /solo-char-tab" data-solo-char-tab-panel/);
  assert.match(closed, /aria-hidden="true"/);
  assert.doesNotMatch(closed, /solo-char-tab is-open/);
  assert.doesNotMatch(closed, /solo-char-tab-backdrop/);
  // The sheet content (abilities/inventory) is inside the tab, not the dock.
  assert.match(closed, /solo-char-tab-body[\s\S]*Abilities/);
  assert.match(closed, /solo-char-tab-body[\s\S]*data-solo-action="use_item"/);

  const open = renderSoloCharacterSidebar(character, { open: true, scene: {} });
  assert.match(open, /solo-char-tab is-open/);
  assert.match(open, /aria-hidden="false"/);
  assert.match(open, /solo-char-tab-backdrop" data-solo-char-tab-close/);
});

test("Babel status window moves rank/origin/attributes into the tab, keeps the portrait", () => {
  const character = characterFromScenePlayer(player({ rank: "E", babelStats: [{ label: "STR", ability: "strength", score: 10 }] }), { variant: "babel" });
  const html = renderBabelStatusWindow(character, { open: false, scene: {} });
  assert.match(html, /solo-portrait-badge[^>]*data-solo-char-tab/);
  assert.match(html, /solo-char-tab-body[\s\S]*RANK/);
  assert.match(html, /solo-char-tab-body[\s\S]*Attributes/);
});

// ── CONDITIONS ON THE PORTRAIT ──────────────────────────────────────────────

test("conditions render as compact chips overlaid on the portrait, not a bar", () => {
  const character = characterFromScenePlayer(player(), null);
  const scene = sceneWithConds([{ id: "burn", name: "Burning", effect: "3 dmg/turn", kind: "debuff", remainingMinutes: 30 }]);
  const html = renderSoloCharacterSidebar(character, { open: false, scene });
  // The conditions live inside the portrait (data-solo-conditions in .solo-portrait).
  assert.match(html, /solo-portrait[\s\S]*data-solo-conditions[\s\S]*solo-conditions-portrait/);
  assert.match(html, /solo-cond-chip cond-debuff is-compact/);
  // Compact chips drop the inline name (it stays in the tooltip/aria).
  assert.doesNotMatch(html, /solo-cond-name/);
  assert.match(html, /aria-label="Burning\. Debuff/);
});

test("compact conditions HUD omits the measure column; default HUD keeps it", () => {
  const scene = sceneWithConds([{ id: "b", name: "Blessed", kind: "buff", effect: "x" }]);
  assert.match(renderSoloConditionsHud(scene, { compact: true }), /solo-conditions solo-conditions-portrait/);
  assert.match(renderSoloConditionsHud(scene), /solo-conditions solo-measure/);
});

// ── ROLL BANNER + HISTORY ───────────────────────────────────────────────────

test("roll banner shows the latest roll inline with a history magnifier", () => {
  const html = renderSoloRollBanner(rollScene);
  assert.match(html, /solo-roll-banner/);
  assert.match(html, /charm the guard/, "most-recent roll first");
  assert.doesNotMatch(html, /force the door/, "only the latest surfaces in the banner");
  assert.match(html, /solo-roll-history-btn[^>]*data-solo-roll-history/);
  assert.equal(renderSoloRollBanner({}), "", "no rolls yet → no banner");
});

test("roll history drawer lists all rolls; hidden until open", () => {
  const closed = renderSoloRollHistory(rollScene, false);
  assert.match(closed, /solo-roll-history-layer" data-solo-roll-history-layer/);
  assert.doesNotMatch(closed, /solo-roll-history-layer is-open/);
  assert.doesNotMatch(closed, /solo-roll-history-backdrop/);
  const open = renderSoloRollHistory(rollScene, true);
  assert.match(open, /solo-roll-history-layer is-open/);
  assert.match(open, /solo-roll-history-backdrop" data-solo-roll-history-close/);
  assert.match(open, /force the door/);
  assert.match(open, /charm the guard/);
  assert.match(open, /data-solo-roll-history-close/);
});

// ── SHELL COMPOSITION: full-bleed prose, rail without rolls, banner in dock ──

test("shell: input dock carries the roll banner (not a conditions bar); rail drops recent-rolls; history layer present", () => {
  const html = renderSoloSceneShell({
    scene: { runId: "r1", location: { name: "X" }, player: player(), attemptHistory: rollScene.attemptHistory },
    narrationLog: []
  });
  // The input dock's conditions bar is gone; the roll banner took its slot.
  assert.match(html, /solo-input-dock[\s\S]*data-solo-roll-banner/);
  assert.doesNotMatch(html, /solo-input-dock[\s\S]*data-solo-conditions/);
  // The rail no longer holds a Recent Rolls panel.
  assert.doesNotMatch(html, /Recent Rolls/);
  // The roll-history overlay is mounted at shell level.
  assert.match(html, /data-solo-roll-history-layer/);
  // Prose main + compact dock both present (full-bleed prose reclaims the column).
  assert.match(html, /solo-game-main solo-scene-main/);
  assert.match(html, /solo-portrait-dock-aside/);
});

// ── DISPATCH WIRING ─────────────────────────────────────────────────────────

test("dispatch routes the tab badge, history magnifier, and their close buttons", () => {
  const calls = [];
  const mk = (sel) => ({ closest: (s) => (s === sel ? { getAttribute: () => null } : null) });
  const handlers = {
    onCharTab: () => calls.push("charTab"),
    onCharTabClose: () => calls.push("charTabClose"),
    onRollHistory: () => calls.push("rollHistory"),
    onRollHistoryClose: () => calls.push("rollHistoryClose")
  };
  dispatchSoloClick(mk("[data-solo-char-tab]"), handlers);
  dispatchSoloClick(mk("[data-solo-char-tab-close]"), handlers);
  dispatchSoloClick(mk("[data-solo-roll-history]"), handlers);
  dispatchSoloClick(mk("[data-solo-roll-history-close]"), handlers);
  assert.deepEqual(calls, ["charTab", "charTabClose", "rollHistory", "rollHistoryClose"]);
});

// ── REDUCED MOTION / VARS ────────────────────────────────────────────────────

test("drawers use display toggles (no motion) and reuse theme vars", () => {
  // display-based show/hide → nothing to animate, reduced-motion safe by construction.
  assert.match(CSS, /\.solo-char-tab\s*\{[^}]*display:\s*none/s);
  assert.match(CSS, /\.solo-char-tab\.is-open\s*\{[^}]*display:\s*flex/s);
  assert.match(CSS, /\.solo-roll-history-layer\s*\{[^}]*display:\s*none/s);
  // Reuses existing theme custom properties, no hard-coded brand palette.
  assert.match(CSS, /\.solo-portrait-badge[\s\S]*var\(--accent/);
});
