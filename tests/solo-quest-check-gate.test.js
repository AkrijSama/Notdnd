import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-checkgate-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "cg.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";
process.env.NOTDND_TEST_HOOKS = "true";

const { initializeDatabase, resetDatabase, registerUser, getSoloRun } = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");
const { resolveSoloAction } = await import("../server/solo/actions.js");
const { TRIAL_QUEST_ID, buildTrialQuest } = await import("../server/campaign/authoredQuests.js");

const CHAR = {
  name: "Bram",
  race: "Human",
  characterClass: "Rogue",
  background: "Criminal",
  baseAbilityScores: { strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 }
};

// An attempt test-hook that forces the d20 and provides a contested (checked)
// interpretation, so the check-gated quest stage sees a deterministic pass/fail.
function checkAttempt(fixedRoll) {
  return {
    type: "attempt",
    actorId: "player",
    intent: "break the ancient warded seal",
    testHook: {
      fixedRoll,
      providerOutput: {
        summary: "You attempt the seal.",
        recommendedAbility: "dexterity",
        dc: 15,
        needsCheck: true,
        advantage: false,
        disadvantage: false,
        successNarration: "The ward yields.",
        failureNarration: "The ward flares and collapses.",
        proposedEffects: []
      }
    }
  };
}

async function freshCampaignRun(email) {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email, password: "password123", displayName: "CG" });
  const result = await createWorldOnboardingRun(user.id, { world: { tone: "dark fantasy" }, character: CHAR, mode: "campaign" });
  return getSoloRun(result.runId);
}

// ── CONTENT: a real campaign run actually contains a check-gated, failable stage ─
test("a campaign run seeds a check-gated, failOnMiss trial quest (the primitive is now in content)", async () => {
  const run = await freshCampaignRun("cg-content@notdnd.local");
  const trial = run.quests[TRIAL_QUEST_ID];
  assert.ok(trial, "trial quest exists on a campaign run");
  assert.equal(trial.isMain, false, "trial is a side-quest — never wins/loses the run");
  assert.equal(trial.status, "active");
  // Stage 1 is the decisive check.
  const checkStage = trial.stages[1];
  assert.equal(checkStage.completion.kind, "check", "final stage gates on a d20");
  assert.equal(checkStage.failOnMiss, true, "a miss FAILS the quest");
});

test("buildTrialQuest shape is genuine (2 stages: reach -> check+failOnMiss)", () => {
  const q = buildTrialQuest({ tone: "cosmic horror" }, { secondLocationName: "the drowned shrine" });
  assert.equal(q.stages.length, 2);
  assert.equal(q.stages[0].completion.kind, "reach_location");
  assert.equal(q.stages[1].completion.kind, "check");
  assert.equal(q.stages[1].failOnMiss, true);
  assert.match(q.stages[1].objective, /ONE try/i, "objective warns the attempt is decisive");
});

// ── FAIL -> LOSE (tracked state, not just narrated) ─────────────────────────────
test("reaching the check stage and MISSING the check FAILS the quest in tracked state", async () => {
  const run = await freshCampaignRun("cg-fail@notdnd.local");
  // Reach the check stage (stage 1) — the reach setup already proven separately.
  // The decisive roll is BOUND to the trial's place + subject (roll-collision
  // fix), so the attempt happens AT the trial location with a seal-directed intent.
  run.quests[TRIAL_QUEST_ID].stage = 1;
  run.currentLocationId = "second_location";

  const before = getSoloRun(run.runId); // eslint-disable-line no-unused-vars
  const resolved = resolveSoloAction(run, checkAttempt(1)); // forced botch
  assert.equal(resolved.ok, true, "the turn resolves");
  assert.equal(resolved.attemptResult.checkResult.success, false, "the check genuinely missed");
  // The quest is LOST in tracked state — not narrated, actually flipped.
  assert.equal(resolved.run.quests[TRIAL_QUEST_ID].status, "failed", "quest status -> failed");
  assert.ok(resolved.questFailed, "the resolver surfaces questFailed");
  assert.equal(resolved.questFailed.questId, TRIAL_QUEST_ID);
  // isMain:false -> the run is NOT lost, just the trail.
  assert.notEqual(resolved.runDied, true);
});

// ── PASS -> ADVANCE/COMPLETE (the pass path still works) ────────────────────────
test("passing the check COMPLETES the trial (final stage) in tracked state", async () => {
  const run = await freshCampaignRun("cg-pass@notdnd.local");
  run.quests[TRIAL_QUEST_ID].stage = 1;
  run.currentLocationId = "second_location";

  const resolved = resolveSoloAction(run, checkAttempt(20)); // forced success
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attemptResult.checkResult.success, true, "the check genuinely passed");
  assert.equal(resolved.run.quests[TRIAL_QUEST_ID].status, "completed", "quest status -> completed");
  assert.notEqual(resolved.run.quests[TRIAL_QUEST_ID].status, "failed");
});

// ── FULL PATH: the reach stage gates BEFORE the check (so a stray turn-1 attempt
// doesn't trigger the decisive roll) ────────────────────────────────────────────
test("the check stage is reached only after the reach stage (full path is grounded)", async () => {
  const run = await freshCampaignRun("cg-path@notdnd.local");
  const trial = run.quests[TRIAL_QUEST_ID];
  assert.equal(trial.stage, 0, "starts on the reach stage");
  assert.equal(trial.stages[0].completion.kind, "reach_location");

  // A contested attempt made BEFORE reaching must not fail/complete the trial —
  // stage 0 is a reach predicate, not a check, so the d20 doesn't touch it.
  const early = resolveSoloAction(run, checkAttempt(1));
  assert.equal(early.run.quests[TRIAL_QUEST_ID].status, "active", "an early botch does NOT lose the trial");
  assert.equal(early.run.quests[TRIAL_QUEST_ID].stage, 0, "still on the reach stage");

  // Now reach the second location -> the reach stage advances to the check stage.
  const arrived = getSoloRun(run.runId);
  arrived.currentLocationId = "second_location";
  arrived.quests[TRIAL_QUEST_ID] = { ...early.run.quests[TRIAL_QUEST_ID] };
  const move = resolveSoloAction(arrived, { type: "search", actorId: "player" });
  assert.equal(move.run.quests[TRIAL_QUEST_ID].stage, 1, "reaching the second location advances to the check stage");
  assert.equal(move.run.quests[TRIAL_QUEST_ID].status, "active", "still active — now at the decisive check");
});
