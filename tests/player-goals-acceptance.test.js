import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import {
  captureDeclaredGoal,
  honorGoalsOnAttempt,
  buildGoalsDirective,
  detectGoalIgnored
} from "../server/solo/goals.js";

// The founding acceptance test (player-goals-law): committed storm active, the
// player says "I'm going to build a shelter before the storm hits" — it must be
// captured, resolved, committed, remembered next turn, and achieved. Mirrors the
// exact production sequence in server/index.js (resolve → capture → honor → save).
function stormRun(runId = "run_accept") {
  const run = createDefaultSoloRun({ runId });
  const loc = run.locations[run.currentLocationId];
  loc.flags.objectStates = {
    "the-sky": {
      objectId: "the-sky", label: "the sky", state: "storm-breaking", retryEffect: "harder",
      reason: "wind and stinging rain closing in", matchTokens: ["sky"], targetId: null,
      sourceIntent: "", since: new Date().toISOString()
    }
  };
  return run;
}

const INTENT = "I'm going to build a shelter before the storm hits";

test("ACCEPTANCE: declare → resolve three-band → success commits shelter → next turn remembers → achieved +XP", () => {
  const run = stormRun();
  const beforeXp = run.player.xp || 0;
  const nowMinutes = run.world.time.minutes;

  // Turn 1 — production sequence: resolve the attempt (forced success roll), then
  // capture the declared goal and honor it, all on the resolver's run before save.
  const resolved = resolveSoloAction(run, { type: "attempt", intent: INTENT }, { fixedRoll: 20, now: run.player?.updatedAt });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors || {}));
  const band = resolved.attemptResult?.band;
  assert.ok(["success", "success_at_cost", "automatic"].includes(band), `attempt resolved in a success-family band, got ${band}`);

  const intent = resolved.attemptResult?.intent || INTENT;
  const capture = captureDeclaredGoal(resolved.run, intent, { nowMinutes, turn: 1 });
  assert.ok(capture, "goal captured via the declared door");
  assert.equal(capture.scale, "task");

  const honored = honorGoalsOnAttempt(resolved.run, { intent, attemptResult: resolved.attemptResult, nowMinutes });
  assert.equal(honored.length, 1, "the goal-relevant success was honored");

  // Success wrote a shelter objectState with builder provenance + storm cover.
  const finalRun = resolved.run;
  const os = finalRun.locations[finalRun.currentLocationId].flags.objectStates[honored[0].objectId];
  assert.ok(os, "shelter objectState committed to the location");
  assert.match(os.state, /^built-(sturdy|makeshift)$/);
  assert.equal(os.setBy, "player-goal");
  assert.ok((finalRun.player.conditions || []).some((c) => /shelter/i.test(c.name || c.id || "")), "Sheltered condition granted under the storm");

  // Goal achieved + XP awarded (provisional goal-XP law).
  const goal = Object.values(finalRun.goals)[0];
  assert.equal(goal.state, "achieved");
  assert.ok((finalRun.player.xp || 0) > beforeXp, "goal achievement awarded XP");

  // NEXT TURN: the world remembers — the shelter persists in committed state AND
  // the goals directive surfaces it so the narrator references it, never contradicts.
  const persisted = JSON.parse(JSON.stringify(finalRun)); // saveSoloRun deep-clone equivalent
  assert.equal(validateSoloRun(persisted).ok, true, "the committed run validates for the next turn");
  assert.ok(persisted.locations[persisted.currentLocationId].flags.objectStates[honored[0].objectId], "shelter still in state next turn");
  const directive = buildGoalsDirective(persisted);
  assert.match(directive, /COMMITTED PLAYER ACHIEVEMENTS/);
  assert.match(directive, /shelter/, "next turn's prompt references the built shelter");
});

test("ACCEPTANCE (negative): the goal-ignored auditor would have flagged the original stiff-arm", () => {
  // Reconstruct the pre-honor state: the shelter goal is active and being pursued.
  const run = stormRun("run_accept_neg");
  captureDeclaredGoal(run, INTENT, { nowMinutes: run.world.time.minutes, turn: 1 });
  const intent = "I gather branches and build a shelter against the ravine wall";

  // The original session's shape: the GM ignored the build and steered to town.
  const flagged = detectGoalIgnored(
    "The wind picks up, cold and wet. You'd be smart to head back to town before it breaks — the tavern keeper keeps a dry room and a warm hearth.",
    run,
    { intent, attemptResult: { band: "success" } }
  );
  assert.equal(flagged.length, 1, "town-steering over an actively-pursued build goal is flagged");
  assert.match(flagged[0].summary, /shelter/);

  // Contrast: a narration that engages the build does NOT flag.
  assert.deepEqual(
    detectGoalIgnored("You wedge the frame against the ravine wall; the shelter takes shape as the first rain spits down.", run, { intent }),
    []
  );
});
