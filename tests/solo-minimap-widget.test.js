// U6 — PERSISTENT MINI-MAP WIDGET (walk-2 final clearance). A compact map is ALWAYS on the
// scene (LOCAL by default), the same Local/Region control toggles it IN PLACE, the full-view
// drawer stays. It joins the bounding-box/pairwise-overlap net (pre-mortem c): docked bottom-
// left, it can't intersect the top-left portrait dock or the top-right HUD row, and it hides
// with every drawer exactly like the HUD row. CSS-as-text + render-string proof (no jsdom).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoloMiniMap, renderSoloSceneShell } from "../src/components/soloSceneShell.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "../src/styles.css"), "utf8");
const rule = (selector) => {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `rule ${selector} present`);
  return CSS.slice(i, CSS.indexOf("}", i) + 1);
};
const pxProp = (body, prop) => {
  const m = new RegExp("(?:^|[;{\\s])" + prop + ":\\s*(\\d+)px").exec(body);
  return m ? parseInt(m[1], 10) : null;
};

// A scene with a couple of known nodes so both renderers produce real bodies.
const SCENE = {
  location: { name: "the Waking Mile" },
  battleMap: { width: 4, height: 4, terrain: [] },
  regionMap: {
    nodes: [
      { id: "loc_a", name: "Waking Mile", here: true, x: 0, y: 0 },
      { id: "loc_b", name: "Elkwater", x: 1, y: 1 }
    ],
    edges: [{ from: "loc_a", to: "loc_b" }]
  }
};

test("the widget is PERSISTENT on the scene (rendered into the stage, not only a drawer)", () => {
  const html = renderSoloSceneShell({ scene: SCENE, mapView: "local" });
  assert.match(html, /data-solo-minimap-slot/, "the stage carries a persistent mini-map slot");
  assert.match(html, /data-solo-minimap/, "the mini-map widget is rendered into it (not empty)");
});

test("the Local/Region control toggles the SAME widget in place (local -> presence, region -> region)", () => {
  const local = renderSoloMiniMap(SCENE, { mapView: "local" });
  const region = renderSoloMiniMap(SCENE, { mapView: "region" });
  assert.match(local, /solo-presence/, "local view draws the local presence map");
  assert.doesNotMatch(local, /solo-region-svg/, "local view is NOT the region graph");
  assert.match(region, /solo-region/, "region view draws the region graph");
  assert.match(region, /aria-label="Region map \(mini\)"/, "region view labels itself as the region mini");
  assert.match(local, /aria-label="Local map \(mini\)"/, "local view labels itself as the local mini");
});

test("HONEST to known-map state: an unmapped scene docks nothing (empty-state law), a mapped one docks the widget", () => {
  // region view with no mapped region still renders the renderer's own empty-state (non-null),
  // but the LOCAL default with a shaped ground always docks. The widget is never a blank box.
  const docked = renderSoloMiniMap(SCENE, { mapView: "local" });
  assert.ok(docked.includes("solo-minimap"), "a mapped scene docks the widget");
  // a totally empty scene: local presence renderer still returns its own 'not taken shape' body,
  // so the widget wraps a truthful empty-state rather than a lying blank tile.
  const empty = renderSoloMiniMap({}, { mapView: "local" });
  assert.ok(empty === "" || /solo-presence/.test(empty), "empty scene -> nothing docked OR a truthful empty-state, never a blank box");
});

// ── BOUNDING-BOX / PAIRWISE-OVERLAP NET (pre-mortem c) ────────────────────────
// RE-ANCHORED BOTTOM-RIGHT (walk-3 verdict): the widget left the left column so it is no
// longer under the top-left portrait dock. New contract: right:8/bottom:8, no left, no top.
test("docked BOTTOM-RIGHT: cornered at right:8/bottom:8, with NO top and NO left (a distinct corner, off the portrait column)", () => {
  const mini = rule(".solo-minimap {");
  assert.match(mini, /position:\s*absolute/);
  assert.equal(pxProp(mini, "right"), 8, "right-anchored at 8px (mirrors the HUD/dock 8px inset) — re-anchored to the RIGHT of the stage");
  assert.equal(pxProp(mini, "bottom"), 8, "bottom-anchored at 8px");
  assert.equal(pxProp(mini, "top"), null, "NOT top-anchored (can't share the top-right HUD corner)");
  assert.equal(pxProp(mini, "left"), null, "NOT left-anchored (off the top-left portrait dock's column — the re-anchor point)");
});

test("pairwise: the mini-map (bottom-right) is vertically clear of the HUD row (top-right) for any real frame", () => {
  // Both now share the RIGHT edge, so non-overlap is purely vertical.
  // HUD: top:8, height 28  -> its bottom edge sits 36px from the frame top.
  // Mini-map: bottom:8, max-height:42% -> its TOP edge sits at frameH - 8 - height,
  //   with height <= 0.42*frameH. Non-overlap needs HUD.bottom(36) < miniMap.top:
  //     36 < frameH - 8 - 0.42*frameH  ->  frameH > 44/0.58 ~= 75.9px.
  // The stage art frame is always far taller than 76px, so they never intersect.
  const mini = rule(".solo-minimap {");
  const mh = /max-height:\s*(\d+)%/.exec(mini);
  assert.ok(mh, "the mini-map caps its height so the bound holds");
  const frac = parseInt(mh[1], 10) / 100;
  const hudBottom = 8 + 28; // HUD top + uniform chip height
  const minFrame = Math.ceil((hudBottom + 8) / (1 - frac)); // frameH threshold
  assert.ok(minFrame < 400, `clears the HUD for any frame taller than ${minFrame}px (stage is >>400px)`);
  // and its right origin equals the HUD inset, so nothing drifts under a neighbour
  assert.equal(pxProp(mini, "right"), 8);
});

// 2.2 — bounding-box net: no overlap with the portrait dock (left column) or the
// narration column (a separate grid row below), at ANY viewport the client supports.
test("bounding-box: right-anchored + max-width<=40% keeps the widget in the right portion, clear of the portrait dock at every width", () => {
  const mini = rule(".solo-minimap {");
  const mw = /max-width:\s*(\d+)%/.exec(mini);
  assert.ok(mw, "the mini-map caps its width as a fraction of the frame");
  const frac = parseInt(mw[1], 10) / 100;
  // Portrait dock: left-anchored, width clamp(120px,12vw,172px) -> at most 12vw of the
  // FRAME... it is the left column. The mini-map is right-anchored and spans at most
  // `frac` of the frame from the right edge, so its LEFT edge sits at >= (1-frac) of the
  // frame width. Non-overlap with a left column of width <= `dock` needs (1-frac) >= dock.
  // The dock caps at 12vw ~= 0.12 of the frame; (1-0.40)=0.60 >> 0.12 at every width.
  const dockMaxFrac = 0.12; // 12vw ceiling of the portrait dock
  assert.ok(1 - frac >= dockMaxFrac, `mini-map left edge (${((1 - frac) * 100).toFixed(0)}%) clears the portrait dock column (<=${dockMaxFrac * 100}%) at every width`);
});

test("bounding-box: the mini-map lives INSIDE the stage zone, never in the narration column (structural non-overlap)", () => {
  const html = renderSoloSceneShell({ scene: SCENE, mapView: "local" });
  // The minimap slot must sit within the pinned stage (data-solo-stage), which is a
  // SEPARATE grid row from the scrollable narration log (data-solo-log) below it — so
  // the widget can never overlap the narration column regardless of viewport height.
  const stageStart = html.indexOf("data-solo-stage");
  const logStart = html.indexOf("data-solo-log");
  const miniSlot = html.indexOf("data-solo-minimap-slot");
  assert.ok(stageStart >= 0 && logStart >= 0 && miniSlot >= 0, "stage, log, and minimap-slot all render");
  assert.ok(miniSlot > stageStart && miniSlot < logStart, "the minimap slot is inside the stage zone, above the narration log (never over it)");
});

test("z-order: below the HUD (30) and well below the full-view drawers (46) so an open drawer overlays it", () => {
  const mini = rule(".solo-minimap {");
  const zm = /z-index:\s*(\d+)/.exec(mini);
  assert.ok(zm, "the mini-map sets an explicit z-index");
  const z = parseInt(zm[1], 10);
  assert.ok(z < 30, `mini-map z-index ${z} sits below the HUD (30)`);
  assert.ok(z < 46, "and below the drawer band (46)");
});

test("hides with EVERY drawer, exactly like the HUD row (never floats over an open drawer)", () => {
  // the same :has(...is-open) family that hides .solo-stage-hud must also hide .solo-minimap
  for (const layer of ["solo-scene-drawer", "solo-char-tab", "solo-roll-history-layer"]) {
    const sel = `:has(.${layer}.is-open) .solo-minimap`;
    assert.ok(CSS.includes(sel), `the ${layer} open-state hides the mini-map (${sel})`);
  }
});
