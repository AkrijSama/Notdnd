// ESSENCE-SIGHT v1 — CLIENT surface (verdance-region-v1 §law-5). String-based,
// no jsdom (house idiom): render fns return HTML strings; CSS is asserted by
// reading styles.css as text. Proves the STATUS WINDOW trace chips (multi-channel
// glyph + band + direction) and the region-map trail edge-glow + fog-safe
// silhouette next-node.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderSoloTraceChips,
  renderSoloSightBlockInner,
  renderSoloRegionMap,
  renderBabelStatusWindow,
  characterFromScenePlayer,
  TRACE_CHIP_META,
  TRACE_BAND_WORD
} from "../src/components/soloSceneShell.js";

const STYLES = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");

function sightScene() {
  return {
    sight: {
      traces: [
        { id: "t1", kind: "trail", band: "bright", followable: true, direction: "The Tithing Mill", meta: {} },
        { id: "t2", kind: "mark", band: "clear", followable: false, direction: null, meta: { handlerScent: "a cold oil-and-ash hand" } }
      ],
      followable: true
    }
  };
}

// ── STATUS WINDOW trace chips: multi-channel encoding ─────────────────────────
test("trace chips carry band class + kind glyph + band word + direction + scent tip", () => {
  const html = renderSoloTraceChips(sightScene());
  assert.match(html, /solo-trace-chip trace-bright/);
  assert.match(html, /solo-trace-chip trace-clear/);
  assert.ok(html.includes(TRACE_CHIP_META.trail.glyph), "trail glyph rendered");
  assert.ok(html.includes(TRACE_CHIP_META.mark.glyph), "mark glyph rendered");
  assert.match(html, /Bright/);
  assert.match(html, /toward The Tithing Mill/);
  assert.ok(html.includes("a cold oil-and-ash hand"), "handler-scent rides the tooltip");
  assert.match(html, /role="group" aria-label="Essence-sight traces"/);
});

test("every trace kind encodes a mandatory glyph (colorblind-safe multi-channel rule)", () => {
  for (const [kind, meta] of Object.entries(TRACE_CHIP_META)) {
    const scene = { sight: { traces: [{ id: `x_${kind}`, kind, band: "bright", followable: false, meta: {} }] } };
    const html = renderSoloTraceChips(scene);
    assert.ok(html.includes(meta.glyph), `${kind} emits its glyph`);
    assert.ok(html.includes(meta.word), `${kind} emits its kind word`);
  }
});

test("the sight block reads a quiet empty state when the WINDOW shows no trace", () => {
  assert.equal(renderSoloTraceChips({}), "");
  assert.match(renderSoloSightBlockInner({}), /The sight is quiet here/);
  assert.match(renderSoloSightBlockInner(sightScene()), /solo-trace-chip/);
});

test("the Babel STATUS WINDOW carries the Essence-sight block with a fast-path hook", () => {
  const character = characterFromScenePlayer({ babel: { stats: [] }, displayName: "Cal" }, { variant: "babel" });
  const html = renderBabelStatusWindow(character, { scene: sightScene() });
  assert.match(html, /Essence-sight/);
  assert.match(html, /data-solo-sight/, "fast-path repaint hook present");
  assert.ok(html.includes(TRACE_CHIP_META.trail.glyph));
});

// ── REGION MAP: edge glow + fog-safe silhouette ───────────────────────────────
function regionScene() {
  return {
    regionMap: {
      current: "a",
      nodes: [
        { id: "a", name: "The Warm House", type: "interior", visited: true, isCurrent: true, reachable: false, unexploredExits: 0 },
        { id: "b", name: "", type: null, visited: false, isCurrent: false, reachable: true, unexploredExits: 0, sightReveal: "bright" }
      ],
      edges: [{ a: "a", b: "b", trail: "bright" }],
      goalPins: []
    }
  };
}

test("a followed trail draws a banded glow edge on the region map", () => {
  const html = renderSoloRegionMap(regionScene());
  assert.match(html, /solo-region-edge is-followed trail-bright/);
});

test("a sight-revealed next node renders as a fog-safe, tappable silhouette (no place-name)", () => {
  const html = renderSoloRegionMap(regionScene());
  assert.match(html, /is-silhouette sight-bright/);
  assert.match(html, /data-solo-action="move" data-location-id="b"/, "tappable to follow the trail");
  assert.match(html, /Follow the bright essence trail/);
  assert.ok(!html.includes("The Tithing Mill"), "the undiscovered place-name never leaks");
});

// ── CSS: the band families + glow + silhouette rules ship ─────────────────────
test("styles.css defines the trace band color families and the edge-glow + silhouette rules", () => {
  for (const band of ["bright", "clear", "faint", "cold"]) {
    assert.match(STYLES, new RegExp(`\\.solo-trace-chip\\.trace-${band}`), `trace-${band} chip color`);
    assert.match(STYLES, new RegExp(`\\.solo-region-edge\\.is-followed\\.trail-${band}`), `trail-${band} edge glow`);
    assert.match(STYLES, new RegExp(`\\.solo-region-node\\.is-silhouette\\.sight-${band}`), `sight-${band} silhouette`);
  }
  assert.match(STYLES, /\.solo-trace-chip:hover \.solo-trace-tip/, "trace tooltip reveal");
  assert.deepEqual(Object.keys(TRACE_BAND_WORD), ["bright", "clear", "faint", "cold"]);
});
