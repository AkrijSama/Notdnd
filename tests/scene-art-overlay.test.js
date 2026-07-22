// JOB 3: the image-gen wait message lives ON the pending art slot, not a pinned page-level
// banner — and it resolves to a REAL end state. A pending "painting…" that never becomes a
// success or a failure is worse than no message. These lock the three overlay states.
import assert from "node:assert/strict";
import test from "node:test";
import { renderSoloSceneArt } from "../src/components/soloSceneShell.js";

test("READY: a resolved image renders the <img>, no pending/failed overlay", () => {
  const html = renderSoloSceneArt("/data/assets/run_x/location/base.png", { status: "ready" });
  assert.match(html, /solo-scene-art-img|<img/, "the image renders");
  assert.doesNotMatch(html, /solo-scene-art-pending|solo-scene-art-failed/, "no overlay once the art has arrived (lifetime tied to the asset's ready state)");
});

test("GENERATING: the pending overlay carries the 'appears as it's ready' copy + a spinner, on the slot", () => {
  const html = renderSoloSceneArt(null, { status: "generating" });
  assert.match(html, /solo-scene-art-pending/, "the overlay is on the art slot, not a page banner");
  assert.match(html, /appears here as it.s ready/i, "carries the message the old page-level banner used to");
  assert.match(html, /solo-scene-art-spinner/, "a spinner, not a static line");
  assert.doesNotMatch(html, /solo-scene-art-failed/, "not the failed state while cooking");
});

test("FAILED: a failed cook shows a FAILED state with a retry — never an eternal 'painting…' (JOB 3.3 / pre-mortem c)", () => {
  const html = renderSoloSceneArt(null, { status: "failed" });
  assert.match(html, /solo-scene-art-failed/, "the failed end-state renders");
  assert.match(html, /data-scene-redo/, "with a retry control");
  assert.doesNotMatch(html, /Painting the scene/, "the pending promise does NOT hang — it resolves to failed");
});
