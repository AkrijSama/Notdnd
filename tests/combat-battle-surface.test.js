// VN BATTLE SURFACE (D.4 item 8) — render + enemy-art prompt + layout bounding-box.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloBattleSurface } from "../src/components/soloSceneShell.js";
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
  combat: {
    status: "active", turn: 3,
    forecast: [{ isPlayer: true, displayName: "You" }, { isPlayer: false, displayName: "The Limping Grey" }, { isPlayer: true, displayName: "You" }],
    enemies: [{
      id: "enm_grey", npcId: "npc_limping_grey", name: "The Limping Grey", hpBand: "bloodied",
      intent: { telegraph: "snarls; frost rimes its bared teeth" }, reads: ["a bite that chills"],
      conditions: [{ id: "slow", name: "Chill", kind: "debuff", effect: "Slowed · 2 turns left", remainingMinutes: null }], bodyUri: null
    }]
  }
});

test("battle surface renders the forecast rail, enemy card, intent, wound-band, and sight-read", () => {
  const html = renderSoloBattleSurface(battleScene());
  assert.match(html, /solo-battle\b/);
  assert.match(html, /solo-battle-forecast/);
  assert.equal((html.match(/solo-battle-slot/g) || []).length, 3, "3 forecast slots");
  assert.match(html, /solo-battle-slot is-next is-you/, "the next actor (you) is highlighted");
  assert.match(html, /solo-battle-enemy-card/);
  assert.match(html, /solo-battle-hpband--bloodied/, "wound band, never a raw HP number");
  assert.doesNotMatch(html, /\bHP\b|\d+\s*damage/, "no raw HP/damage numbers on the surface");
  assert.match(html, /snarls; frost rimes/, "the telegraphed intent");
  assert.match(html, /You read: a bite that chills/, "the essence-sight read on the card");
  assert.match(html, /Chill/, "the chill status chip");
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

test("bounding-box: the battle overlay is full-bleed, below the HUD/drawers, and the forecast rail clears the HUD row", () => {
  const battle = rule(".solo-battle {");
  assert.match(battle, /position:\s*absolute/);
  assert.match(battle, /inset:\s*0/);
  const battleZ = numOf(battle, "z-index");
  const hudZ = numOf(rule(".solo-stage-hud {"), "z-index");
  const drawerZ = numOf(rule(".solo-scene-drawer {"), "z-index");
  assert.ok(battleZ < hudZ, `battle z(${battleZ}) below the HUD row z(${hudZ})`);
  assert.ok(battleZ < drawerZ, `battle z(${battleZ}) below drawers z(${drawerZ})`);
  // the forecast rail sits BELOW the top-right HUD row (top:8 + ~28px tall ⇒ bottom 36)
  const railTop = pxOf(rule(".solo-battle-forecast {"), "margin-top");
  const hudTop = pxOf(rule(".solo-stage-hud {"), "top");
  const hudChip = pxOf(rule(".solo-stage-hud > * {"), "height");
  assert.ok(railTop >= hudTop + hudChip, `forecast rail top(${railTop}) clears the HUD row bottom(${hudTop + hudChip})`);
});
