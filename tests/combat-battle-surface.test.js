// VN BATTLE SURFACE (D.4 item 8) — render + enemy-art prompt + layout bounding-box.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloBattleSurface, renderSoloCombatPanel, renderSoloInitiativeForecast } from "../src/components/soloSceneShell.js";
import { buildEnemyBodyPrompt } from "../server/solo/imageWorker.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const rule = (selector) => {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `rule ${selector} present`);
  return CSS.slice(i, CSS.indexOf("}", i) + 1);
};
const pxOf = (body, prop) => { const m = new RegExp(prop + ":\\s*(\\d+)px").exec(body); return m ? parseInt(m[1], 10) : null; };
const numOf = (body, prop) => { const m = new RegExp(prop + ":\\s*(\\d+)").exec(body); return m ? parseInt(m[1], 10) : null; };

const battleScene = () => ({
  player: { hitPoints: { current: 5, max: 8 }, portraitUri: "/player.png", inventory: [] },
  combat: {
    status: "active", turn: 3,
    forecast: [
      { actorId: "player", isPlayer: true, displayName: "You", speed: 8 },
      { actorId: "enm_grey", isPlayer: false, displayName: "The Limping Grey", speed: 11 },
      { actorId: "player", isPlayer: true, displayName: "You", speed: 8 }
    ],
    enemies: [{
      id: "enm_grey", npcId: "npc_limping_grey", name: "The Limping Grey", hp: { current: 4, max: 7 }, hpBand: "bloodied",
      intent: { telegraph: "snarls; frost rimes its bared teeth" }, reads: ["a bite that chills"],
      conditions: [{ id: "slow", name: "Chill", kind: "debuff", effect: "Slowed · 2 turns left", remainingMinutes: null }], bodyUri: null
    }]
  }
});

test("UI-14: battle surface is ONE scene — the primary foe fills the strip, nameplate + reads overlay; the forecast is in the panel", () => {
  const scene = battleScene();
  scene.combat.enemies[0].bodyUri = "/grey.png"; // a cooked foe fills the strip (battleScene's default is null → silhouette, covered by the next test)
  const html = renderSoloBattleSurface(scene);
  assert.match(html, /solo-battle\b/);
  // The order-only forecast is portrait chips in the combat PANEL, not a rail here.
  assert.doesNotMatch(html, /solo-battle-forecast|solo-battle-slot/, "the text rail moved off the stage");
  // UI-14: NO tiled per-enemy image cards — the primary foe fills the stage.
  assert.doesNotMatch(html, /solo-battle-enemy-card/, "no framed per-enemy cards tiled in a row (UI-14)");
  assert.match(html, /solo-battle-stage/, "one full-bleed stage");
  assert.match(html, /solo-battle-enemy-img[^>]*object-fit:\s*cover/, "the primary foe fills the strip (no empty band)");
  assert.match(html, /solo-battle-hpband--bloodied/, "wound band, never a raw HP number");
  assert.match(html, /snarls; frost rimes/, "the telegraphed intent, overlaid");
  assert.match(html, /You read: a bite that chills/, "the essence-sight read, overlaid");
  assert.match(html, /Chill/, "the chill status chip");
});

test("UI-14: MULTIPLE foes read as one scene — primary fills, others are compact tokens (not tiled full cards)", () => {
  const scene = battleScene();
  scene.combat.enemies = [
    { id: "w1", name: "Grey Wolf", hp: { current: 5, max: 7 }, hpBand: "steady", bodyUri: "/w1.png", intent: { telegraph: "circles" }, reads: [], conditions: [] },
    { id: "w2", name: "Wolf Two", hp: { current: 3, max: 7 }, hpBand: "bloodied", bodyUri: "/w2.png", intent: { telegraph: "snarls" }, reads: [], conditions: [] }
  ];
  const html = renderSoloBattleSurface(scene);
  assert.doesNotMatch(html, /solo-battle-enemy-card/, "no tiled cards even with multiple foes — the exact UI-14 bug");
  // exactly ONE full-bleed primary image (inset:0), plus compact round tokens for the rest.
  assert.equal((html.match(/solo-battle-enemy-img/g) || []).length, 1, "exactly one filling primary image, not N");
  assert.match(html, /border-radius:\s*50%/, "additional foes are round corner tokens");
  assert.match(html, /Grey Wolf/, "the primary foe is named");
});

test("combat PANEL surfaces the engine: the five-action menu, the portrait forecast, and player HP", () => {
  const html = renderSoloCombatPanel(battleScene(), {});
  // JOB 2 — the genre-standard five, always present, enabled by state.
  for (const kind of ["attack", "guard", "skills", "items", "escape"]) {
    assert.match(html, new RegExp(`data-solo-combat="${kind}"`), `the ${kind} button is present`);
  }
  // The standalone `disabled>` attribute (not the aria-disabled="…" flag which contains the substring).
  assert.match(html, /data-solo-combat="skills"[^>]*\sdisabled>/, "Skills is DISABLED (canon: no skills yet), not hidden");
  assert.match(html, /data-solo-combat="items"[^>]*\sdisabled>/, "Items is disabled when the bag is empty");
  assert.doesNotMatch(html, /data-solo-combat="attack"[^>]*\sdisabled>/, "Attack is always enabled");
  // JOB 1.2 — player HP in the panel, and JOB 3 — portrait chips.
  assert.match(html, /solo-combat-hp-num[^>]*>5\/8</, "the player's HP is shown");
  assert.match(html, /solo-init-forecast/, "the initiative forecast is in the panel");
  assert.equal((html.match(/solo-init-chip/g) || []).length, 3, "3 forecast portrait chips");
  assert.match(html, /solo-init-chip is-next is-you/, "the next actor (you) is highlighted");
  // JOB 3.2 — hover shows name + speed (order-only; speed is a stat, not a raw tick).
  assert.match(html, /Speed 8/, "the player's speed on hover");
  assert.match(html, /The Limping Grey · Speed 11/, "the foe's name + speed on hover");
});

test("initiative forecast joins each slot to a committed face; a missing portrait falls back to an initial (never blocks)", () => {
  const withFaces = renderSoloInitiativeForecast(battleScene());
  assert.match(withFaces, /solo-init-face-img[^>]*src="\/player\.png"/, "the player's committed portrait");
  assert.match(withFaces, /solo-init-face-fallback/, "the foe has no cooked body yet → an initial glyph, not a broken image");
});

test("battle surface: empty-state silhouette while the enemy art cooks; empty out of combat", () => {
  assert.match(renderSoloBattleSurface(battleScene()), /solo-battle-enemy-pending/, "no bodyUri → silhouette, never a broken image");
  const withArt = battleScene(); withArt.combat.enemies[0].bodyUri = "data:image/png;base64,AAAA";
  assert.match(renderSoloBattleSurface(withArt), /solo-battle-enemy-img/, "cooked art renders when present");
  assert.equal(renderSoloBattleSurface({}), "", "no live fight → nothing (no dead box over the art)");
  assert.equal(renderSoloBattleSurface({ combat: { status: "won" } }), "");
});

test("enemy-art prompt is minted deterministically from the bestiary row (base animal + tier corruption + rider cue)", () => {
  const grey = resolveStatBlock("limping_grey");
  const p1 = buildEnemyBodyPrompt(grey, "modern arcane");
  const p2 = buildEnemyBodyPrompt(grey, "modern arcane");
  assert.equal(p1, p2, "deterministic — same row → same prompt (cache-keyable)");
  assert.match(p1, /grey wolf/, "the base-animal chassis");
  assert.match(p1, /wounded|limping/, "the injured behavior marker");
  assert.match(p1, /corrupted/, "tier-scaled corruption");
  assert.match(p1, /frost/, "the chill-rider visual cue");
  assert.equal(buildEnemyBodyPrompt(null), null, "no block → no prompt (never mints a phantom)");
});

test("bounding-box: the battle overlay is full-bleed, below the HUD/drawers", () => {
  const battle = rule(".solo-battle {");
  assert.match(battle, /position:\s*absolute/);
  assert.match(battle, /inset:\s*0/);
  const battleZ = numOf(battle, "z-index");
  const hudZ = numOf(rule(".solo-stage-hud {"), "z-index");
  const drawerZ = numOf(rule(".solo-scene-drawer {"), "z-index");
  assert.ok(battleZ < hudZ, `battle z(${battleZ}) below the HUD row z(${hudZ})`);
  assert.ok(battleZ < drawerZ, `battle z(${battleZ}) below drawers z(${drawerZ})`);
});
