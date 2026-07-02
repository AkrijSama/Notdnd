import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-checkbind-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "cb.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";
process.env.NOTDND_TEST_HOOKS = "true";

const { initializeDatabase, resetDatabase, registerUser, getSoloRun } = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");
const { resolveSoloAction } = await import("../server/solo/actions.js");
const { TRIAL_QUEST_ID, DELIVERY_QUEST_ID, buildTrialQuest } = await import("../server/campaign/authoredQuests.js");

// ── THE ROLL COLLISION (CLI 2's flag) ────────────────────────────────────────
// Two concurrent completion.kind:"check" stages used to share EVERY contested
// roll: in a guided run the trial (failOnMiss) is active from turn one, so the
// FIRST contested roll — e.g. MISSING the delivery road hazard — silently and
// permanently FAILED a quest the player never attempted. The fix binds a check
// stage's resolution to roll RELEVANCE, decided deterministically from server
// state (completion.locationId + completion.subjectKeywords) — the LLM is never
// asked which stage a roll belongs to.

const CHAR = {
  name: "Bram",
  race: "Human",
  characterClass: "Rogue",
  background: "Criminal",
  baseAbilityScores: { strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 }
};

function contestedAttempt(intent, fixedRoll) {
  return {
    type: "attempt",
    actorId: "player",
    intent,
    testHook: {
      fixedRoll,
      providerOutput: {
        summary: `You attempt: ${intent}`,
        recommendedAbility: "dexterity",
        dc: 15,
        needsCheck: true,
        advantage: false,
        disadvantage: false,
        successNarration: "It works.",
        failureNarration: "It goes badly.",
        proposedEffects: []
      }
    }
  };
}

let seq = 0;
async function guidedRunAtGiver() {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: `cb-${seq++}@notdnd.local`, password: "password123", displayName: "CB" });
  const result = await createWorldOnboardingRun(user.id, { world: { tone: "dark fantasy" }, character: CHAR, mode: "campaign" });
  const run = getSoloRun(result.runId);
  // At the giver's place: the trial's check stage AND (after accepting + taking)
  // the delivery hazard stage are BOTH active — the collision setup.
  run.currentLocationId = "second_location";
  run.quests[TRIAL_QUEST_ID].stage = 1;
  return run;
}

// Accept the job + take the crate (both via the real free-text player path) so
// the delivery quest sits on its hazard check stage (stage 1) while the trial
// also sits on its check stage — two concurrent kind:"check" stages.
function armBothCheckStages(run) {
  const accept = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Yes, I'll take the job." });
  assert.ok(accept.questAccepted, "free-text accept instantiates the delivery quest");
  const armed = accept.run;
  armed.quests[TRIAL_QUEST_ID].stage = 1;
  const take = resolveSoloAction(armed, { type: "attempt", actorId: "player", intent: "grab the crate and sling it over my shoulder" });
  assert.equal(take.takeResult?.taken, true, "crate committed");
  const ready = take.run;
  assert.equal(ready.quests[DELIVERY_QUEST_ID].stage, 1, "delivery sits on the hazard check stage");
  assert.equal(ready.quests[TRIAL_QUEST_ID].stage, 1, "trial sits on its decisive check stage");
  return ready;
}

test("COLLISION FIXED: missing the road hazard does NOT fail the trial (both check stages active)", async () => {
  const run = await guidedRunAtGiver();
  const ready = armBothCheckStages(run);

  // The exact incident: the player MISSES the road-hazard roll.
  const miss = resolveSoloAction(ready, contestedAttempt("force my way past whatever watches the road", 1));
  assert.equal(miss.attemptResult.checkResult.success, false, "the hazard roll genuinely missed");
  // The hazard stage HOLDS (no advance on a miss)…
  assert.equal(miss.run.quests[DELIVERY_QUEST_ID].stage, 1, "hazard stage holds on a miss");
  assert.equal(miss.run.quests[DELIVERY_QUEST_ID].status, "active", "delivery is still alive (failOnMiss off)");
  // …and the TRIAL — a quest the player never attempted — is UNTOUCHED.
  assert.equal(miss.run.quests[TRIAL_QUEST_ID].status, "active", "the trial did NOT silently fail on a road roll");
  assert.equal(miss.run.quests[TRIAL_QUEST_ID].stage, 1, "the trial's decisive check is still ahead");

  // PREFIX-COLLISION repro (live-proven leak): "road-WARDens" must not bind the
  // trial via its "ward" stem (from "warded seal" / "blood-ward" — checkRollBinds
  // matches keywords as word-boundary PREFIXES).
  const wardenMiss = resolveSoloAction(miss.run, contestedAttempt("force my way past the road-wardens watching the crossing", 1));
  assert.equal(wardenMiss.attemptResult.checkResult.success, false, "the warden roll genuinely missed");
  const afterWarden = wardenMiss.run || miss.run;
  assert.equal(afterWarden.quests[TRIAL_QUEST_ID].status, "active",
    '"road-wardens" must not fail the trial through the "ward" keyword stem');
});

test("COLLISION FIXED: passing the road hazard advances ONLY the delivery, not the trial", async () => {
  const run = await guidedRunAtGiver();
  const ready = armBothCheckStages(run);

  const pass = resolveSoloAction(ready, contestedAttempt("sneak past the toll watchers on the road", 20));
  assert.equal(pass.attemptResult.checkResult.success, true, "the hazard roll passed");
  assert.equal(pass.run.quests[DELIVERY_QUEST_ID].stage, 2, "delivery advanced to the deliver stage");
  assert.equal(pass.run.quests[TRIAL_QUEST_ID].status, "active", "the trial was not completed by a road roll");
  assert.equal(pass.run.quests[TRIAL_QUEST_ID].stage, 1, "the trial still awaits its own attempt");
});

test("the trial resolves on a vault-directed attempt at ITS location — pass completes it", async () => {
  const run = await guidedRunAtGiver();
  const pass = resolveSoloAction(run, contestedAttempt("break the blood-ward on the reliquary door", 20));
  assert.equal(pass.attemptResult.checkResult.success, true);
  assert.equal(pass.run.quests[TRIAL_QUEST_ID].status, "completed", "a seal-directed pass completes the trial");
});

test("the trial resolves on a vault-directed attempt at ITS location — miss FAILS it (teeth intact)", async () => {
  const run = await guidedRunAtGiver();
  const miss = resolveSoloAction(run, contestedAttempt("break the blood-ward on the reliquary door", 1));
  assert.equal(miss.attemptResult.checkResult.success, false);
  assert.equal(miss.run.quests[TRIAL_QUEST_ID].status, "failed", "a seal-directed miss still LOSES the trial");
});

test("a vault-directed attempt at the WRONG location does not resolve the trial", async () => {
  const run = await guidedRunAtGiver();
  run.currentLocationId = "start_location"; // seal-words, wrong place
  const away = resolveSoloAction(run, contestedAttempt("break the blood-ward on the reliquary door", 1));
  assert.equal(away.run.quests[TRIAL_QUEST_ID].status, "active", "no failure from a roll made elsewhere");
  assert.equal(away.run.quests[TRIAL_QUEST_ID].stage, 1);
});

test("an UNRELATED contested roll at the trial's location neither completes nor fails it", async () => {
  const run = await guidedRunAtGiver();
  // A consequence-free turn may return no mutated run — fall back to the input.
  const climb = resolveSoloAction(run, contestedAttempt("climb the crumbling wall to the ledge", 1));
  const afterMiss = climb.run || run;
  assert.equal(afterMiss.quests[TRIAL_QUEST_ID].status, "active", "a random botch is not the decisive roll");
  const climb20 = resolveSoloAction(afterMiss, contestedAttempt("climb the crumbling wall to the ledge", 20));
  const afterPass = climb20.run || afterMiss;
  assert.equal(afterPass.quests[TRIAL_QUEST_ID].status, "active", "a random success does not complete the trial");
});

test("LEGACY: a check stage with NO binding fields keeps the old any-roll semantics", async () => {
  const run = await guidedRunAtGiver();
  run.quests.q_legacy = {
    questId: "q_legacy",
    status: "active",
    isMain: false,
    stage: 0,
    stages: [{ objective: "Prove yourself.", completion: { kind: "check" } }],
    objective: "Prove yourself.",
    completion: { kind: "check" },
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: {}
  };
  const pass = resolveSoloAction(run, contestedAttempt("climb the crumbling wall to the ledge", 20));
  assert.equal(pass.run.quests.q_legacy.status, "completed", "unbound check stage still consumes any roll");
});

test("trial subjectKeywords never include road-hazard words (the gate/toll-gate overlap is excluded)", () => {
  const q = buildTrialQuest({ tone: "sword & sorcery" }, {});
  const kws = q.stages[1].completion.subjectKeywords;
  assert.ok(Array.isArray(kws) && kws.length > 0, "trial carries subject keywords");
  assert.ok(!kws.includes("gate"), `"gate" (a road word) must not bind the trial: ${JSON.stringify(kws)}`);
  assert.ok(kws.includes("rune") || kws.includes("iron") || kws.includes("barrow"), `distinct trial nouns remain: ${JSON.stringify(kws)}`);
});
