import assert from "node:assert/strict";
import test from "node:test";

import { renderSoloPresenceMap, renderSoloMapTab } from "../src/components/soloSceneShell.js";

// C.15: presence-map feature markers were ambiguous — a bare ◆ with no visible
// tooltip (aria-label is screen-reader-only; the CSS killed the `title` tooltip via
// pointer-events:none) and no legend. The markup now carries a hoverable title AND
// a legend that names only features that actually exist.

const sceneWithFeatures = {
  location: { name: "The Sunken Ruins", tags: ["ruins"] },
  player: { displayName: "Bram" },
  battleMap: {
    width: 12,
    height: 12,
    tokens: [{ kind: "player", entityId: "player:bram", x: 6, y: 6 }],
    features: [
      { kind: "site", x: 3, y: 3, name: "Broken Altar" },
      { kind: "exit", x: 0, y: 5, name: "North Passage" }
    ]
  }
};

test("each placed feature carries a hoverable title (not only aria-label)", () => {
  const html = renderSoloPresenceMap(sceneWithFeatures);
  assert.match(html, /class="solo-presence-feature[^"]*"[^>]*title="Broken Altar"/);
  assert.match(html, /title="North Passage"/);
});

test("a legend names ONLY the features that exist (honest to state)", () => {
  const html = renderSoloPresenceMap(sceneWithFeatures);
  assert.match(html, /solo-presence-legend/);
  assert.match(html, /solo-presence-legend-item[^>]*>.*Broken Altar/s);
  assert.match(html, /North Passage/);
  // Nothing invented: a feature kind that was never placed must not appear.
  assert.doesNotMatch(html, /Hazard|Shrine|Loot/);
});

test("no features placed → no legend rendered (nothing invented)", () => {
  const html = renderSoloPresenceMap({
    location: { name: "Empty" },
    player: { displayName: "Bram" },
    battleMap: { width: 12, height: 12, tokens: [{ kind: "player", entityId: "player:bram", x: 6, y: 6 }], features: [] }
  });
  assert.doesNotMatch(html, /solo-presence-legend/);
});

// Presentation-honesty: the tactical Map tab must not over-promise a combat system
// that the backend doesn't own (no server terrain/LOS/cover/ranges yet).
test("the Map tab copy is honest about being a positioning sketch, not tactical combat", () => {
  const html = renderSoloMapTab(
    { player: { displayName: "Bram", speed: 30 }, battleMap: { width: 12, height: 12, tokens: [{ kind: "player", entityId: "player:bram", x: 6, y: 6 }] } },
    {}
  );
  assert.match(html, /Positioning sketch/);
  assert.match(html, /line-of-sight, cover and ranges aren't modelled yet/);
  // The old over-promising "legal tiles glow" claim is gone.
  assert.doesNotMatch(html, /legal tiles glow/);
});
