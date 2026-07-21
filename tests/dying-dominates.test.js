// C3 — DYING DOMINATES (walk-2 #16). At 0 HP the simulation belongs to the dying
// player: casual momentum (weather beats, ambient one-offs) SUSPENDS; only the death
// loop advances. Forensics: run_bbcb7b08 fired "The weather turns" at 0/9 HP. The fix
// gates momentum's fire on isDying via suppressFire — the death loop still progresses
// (never a deadlock).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { advanceMomentum } from "../server/solo/momentum.js";

const T = (n) => `2026-03-01T00:00:${String(n).padStart(2, "0")}.000Z`;
function freshRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_dying_dominates";
  return run;
}
const quiet = { attemptResult: { success: true, needsCheck: false } };

test("casual momentum FIRES on a stall turn when the player is healthy", () => {
  const run = freshRun();
  advanceMomentum(run, quiet, { now: T(1) });
  advanceMomentum(run, quiet, { now: T(2) });
  const t3 = advanceMomentum(run, quiet, { now: T(3) });
  assert.ok(t3.fired, "a healthy stall fires a world event (weather etc.)");
});

test("DYING suppresses casual momentum: the same stall fires NOTHING (weather suspended)", () => {
  const run = freshRun();
  advanceMomentum(run, quiet, { now: T(1) });
  advanceMomentum(run, quiet, { now: T(2) });
  // the C3 gate: at 0 HP the action path passes suppressFire — casual fire is suspended
  const t3 = advanceMomentum(run, quiet, { now: T(3), suppressFire: true });
  assert.equal(t3.fired, null, "no weather/casual event fires while dying");
});

test("the fix is wired: resolveSoloAction suppresses momentum fire when isDying", () => {
  const src = fs.readFileSync(path.resolve("server/solo/actions.js"), "utf8");
  // the momentum call gates suppressFire on the dying state
  assert.match(src, /suppressFire:\s*driverFired\s*\|\|\s*isDying\(result\.run\)/, "suppressFire gates on isDying");
  assert.match(src, /import \{[\s\S]*isDying[\s\S]*\} from "\.\/death\.js"/, "isDying is imported from the death spine");
});
