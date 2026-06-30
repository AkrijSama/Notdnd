import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildBattleMapPayload } from "../server/solo/scene.js";

// C.12 — the presence/minimap feature bridge: buildBattleMapPayload projects the
// CURRENT location's searchDetails (in-location features) onto the token grid as
// battleMap.features, which the "Where you are" renderer paints. Derived from a
// single source (searchDetails), so the two maps cannot drift; honest to state.

function runWithSearchDetails(details) {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.locations[run.currentLocationId].searchDetails = details;
  return run;
}

test("projects each searchDetail into a positioned, named, kind-typed feature", () => {
  const run = runWithSearchDetails([
    { detailId: "start_location_ruins_hall", label: "The Collapsed Hall", revealed: false },
    { detailId: "start_location_old_well", label: "The Old Well", revealed: false },
    { detailId: "start_location_watch", label: "The Broken Watchpoint", revealed: false },
    { detailId: "start_location_cache", label: "An Ash-Buried Cache", revealed: false }
  ]);
  const { features } = buildBattleMapPayload(run);
  assert.equal(features.length, 4, "one feature per searchDetail");
  const byName = Object.fromEntries(features.map((f) => [f.name, f]));
  assert.equal(byName["The Collapsed Hall"].kind, "ruins", "ruins/hall -> ruins glyph");
  assert.equal(byName["The Old Well"].kind, "water", "well -> water glyph");
  assert.equal(byName["The Broken Watchpoint"].kind, "structure", "watchpoint -> structure glyph");
  assert.equal(byName["An Ash-Buried Cache"].kind, "loot", "cache -> loot glyph");
  for (const f of features) {
    assert.ok(Number.isInteger(f.x) && f.x >= 0 && f.x <= 11, "x on the 12-grid");
    assert.ok(Number.isInteger(f.y) && f.y >= 0 && f.y <= 11, "y on the 12-grid");
  }
});

test("positions are deterministic (stable across rebuilds — no flicker)", () => {
  const details = [{ detailId: "d1", label: "Old Well" }, { detailId: "d2", label: "Buried Cache" }];
  const a = buildBattleMapPayload(runWithSearchDetails(details)).features;
  const b = buildBattleMapPayload(runWithSearchDetails(details)).features;
  assert.deepEqual(a, b, "same searchDetails -> identical feature positions");
});

test("HONEST to state: feature count mirrors searchDetails exactly (none invented, none dropped)", () => {
  // An empty / absent searchDetails projects ZERO features.
  assert.deepEqual(buildBattleMapPayload(runWithSearchDetails([])).features, [], "empty list -> none");
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  delete run.locations[run.currentLocationId].searchDetails;
  assert.deepEqual(buildBattleMapPayload(run).features, [], "absent searchDetails -> none");
  // When the location genuinely has features, exactly that many are projected.
  assert.equal(buildBattleMapPayload(runWithSearchDetails([{ detailId: "a", label: "A" }, { detailId: "b", label: "B" }])).features.length, 2);
});

test("features and tokens share the same grid frame (player centred, features around)", () => {
  const run = runWithSearchDetails([{ detailId: "d", label: "The Old Well" }]);
  const { tokens, features } = buildBattleMapPayload(run);
  const player = tokens.find((t) => t.kind === "player");
  assert.ok(player, "player token present");
  assert.notDeepEqual({ x: features[0].x, y: features[0].y }, { x: player.x, y: player.y }, "feature is not under the player");
});
