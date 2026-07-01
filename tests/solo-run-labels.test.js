import assert from "node:assert/strict";
import test from "node:test";

import { runFlags, soloRunActionLabel } from "../src/state/runLabels.js";

// C.16: the saved-runs list must label the action honestly by run-state. The bug
// was "View ending" on ABANDONED runs — implying a resolution that never happened.

test("completed runs (a real ending exists) → 'View ending'", () => {
  assert.equal(soloRunActionLabel({ status: "completed" }), "View ending");
});

test("abandoned runs → 'View' (NOT 'View ending' — nothing concluded, and non-resumable)", () => {
  const label = soloRunActionLabel({ status: "abandoned" });
  assert.equal(label, "View");
  assert.notEqual(label, "View ending", "an abandoned run has no ending to view");
});

test("dead runs → 'View death' (terminal)", () => {
  assert.equal(soloRunActionLabel({ status: "dead" }), "View death");
  // isDead also derivable from flags, not just status.
  assert.equal(soloRunActionLabel({ isDead: true }), "View death");
  assert.equal(soloRunActionLabel({ player: { status: "dead" } }), "View death");
});

test("active runs → 'Continue' (or the primary hero-copy variant)", () => {
  assert.equal(soloRunActionLabel({ status: "active" }), "Continue");
  assert.equal(soloRunActionLabel({ status: "active" }, { primary: true }), "Continue your adventure");
});

test("runFlags distinguishes completed vs abandoned vs in-progress (they are NOT collapsed)", () => {
  assert.deepEqual(
    { ...runFlags({ status: "abandoned" }) },
    { status: "abandoned", isDead: false, isCompleted: false, isAbandoned: true, finished: true }
  );
  assert.equal(runFlags({ status: "completed" }).isCompleted, true);
  assert.equal(runFlags({ status: "completed" }).isAbandoned, false);
  assert.equal(runFlags({ status: "active" }).finished, false);
});
