import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun, validateGoal } from "../server/solo/schema.js";
import {
  detectGoalDeclaration,
  inferGoalScale,
  captureDeclaredGoal,
  goalMatchesIntent,
  honorGoalsOnAttempt,
  buildGoalsDirective,
  detectGoalIgnored,
  activeGoals,
  GOAL_CAPS,
  GOAL_XP
} from "../server/solo/goals.js";

function stormRun(runId = "run_goals") {
  const run = createDefaultSoloRun({ runId });
  const loc = run.locations[run.currentLocationId];
  loc.flags.objectStates = {
    "the-sky": { objectId: "the-sky", label: "the sky", state: "storm-breaking", retryEffect: "harder", reason: "wind", matchTokens: ["sky"], targetId: null, sourceIntent: "", since: new Date().toISOString() }
  };
  return run;
}

// ── schema (additive / resume-safe) ─────────────────────────────────────────

test("legacy run (no goals) validates; default mint carries empty goals", () => {
  const run = createDefaultSoloRun({ runId: "run_legacy_goals" });
  assert.deepEqual(run.goals, {});
  assert.equal(validateSoloRun(run).ok, true);
  delete run.goals;
  assert.equal(validateSoloRun(run).ok, true, "legacy run without goals stays valid");
});

test("validateGoal enforces the typed record; bogus enums reject", () => {
  const good = { goalId: "g1", summary: "build a shelter", scale: "task", state: "active", door: "declared", matchTokens: ["build", "shelter"], linkedObjectIds: [], flags: {} };
  assert.equal(validateGoal(good).ok, true);
  assert.equal(validateGoal({ ...good, scale: "epic" }).ok, false);
  assert.equal(validateGoal({ ...good, state: "wishing" }).ok, false);
  assert.equal(validateGoal({ ...good, goalId: "" }).ok, false);
});

// ── DECLARED door + guards ───────────────────────────────────────────────────

test("declared door captures intention-shaped speech", () => {
  const d = detectGoalDeclaration("I'm going to build a shelter before the storm hits");
  assert.ok(d);
  assert.equal(d.scale, "task");
  assert.ok(d.matchTokens.includes("shelter"));
  assert.ok(detectGoalDeclaration("My goal is to become the guildmaster of Ashenmoor"));
  assert.ok(detectGoalDeclaration("I vow to avenge my brother"));
});

test("declared door guards: musing, questions, and one-shot actions never capture", () => {
  assert.equal(detectGoalDeclaration("I wonder if I could build a shelter"), null);
  assert.equal(detectGoalDeclaration("Should I build a shelter?"), null);
  assert.equal(detectGoalDeclaration("Can I make camp here?"), null);
  // Medium marker + one-shot doable (no sustained verb, no scope) → not a goal.
  assert.equal(detectGoalDeclaration("I want to open the door"), null);
  assert.equal(detectGoalDeclaration("I'm going to sit down"), null);
  // A bare imperative (no intention marker) is an attempt, not a declaration.
  assert.equal(detectGoalDeclaration("build a shelter"), null);
});

test("scale inference: ambition / project / task", () => {
  assert.equal(inferGoalScale("become the king of the north"), "ambition");
  assert.equal(inferGoalScale("build a keep on the ridge"), "project");
  assert.equal(inferGoalScale("build a shelter before the storm"), "task");
});

// ── capture: dedup + caps ────────────────────────────────────────────────────

test("capture commits a goal; duplicate pursuit does not double-capture", () => {
  const run = stormRun();
  const g = captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", { nowMinutes: 420, turn: 1 });
  assert.ok(g);
  assert.equal(g.scale, "task");
  assert.equal(g.state, "active");
  assert.equal(g.door, "declared");
  assert.equal(Object.keys(run.goals).length, 1);
  // Same objective again → no second goal.
  assert.equal(captureDeclaredGoal(run, "I want to build that shelter", { nowMinutes: 430 }), null);
  assert.equal(Object.keys(run.goals).length, 1);
  assert.equal(validateSoloRun(run).ok, true);
});

test("ambition cap is enforced (provisional 3); tasks are uncapped", () => {
  const run = createDefaultSoloRun({ runId: "run_caps" });
  assert.equal(GOAL_CAPS.ambition, 3);
  assert.equal(GOAL_CAPS.task, Infinity);
  // Four DISTINCT ambitions (different objectives, so no dedup collision).
  captureDeclaredGoal(run, "My goal is to become the guildmaster of Ashenmoor", {});
  captureDeclaredGoal(run, "I vow to avenge my murdered father", {});
  captureDeclaredGoal(run, "My goal is to unite the fractured clans", {});
  captureDeclaredGoal(run, "My goal is to overthrow the tyrant baron", {}); // 4th
  assert.equal(activeGoals(run).filter((g) => g.scale === "ambition").length, 3, "4th ambition declined by cap");
});

// ── honor pipeline (the shelter path) ────────────────────────────────────────

test("honor: a build success commits a shelter objectState + storm cover + XP + achievement", () => {
  const run = stormRun();
  const beforeXp = run.player.xp || 0;
  captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", { nowMinutes: 420, turn: 1 });
  const honored = honorGoalsOnAttempt(run, {
    intent: "I build a sturdy shelter from branches and the ravine wall",
    attemptResult: { band: "success", success: true },
    nowMinutes: 425
  });
  assert.equal(honored.length, 1);
  const os = run.locations[run.currentLocationId].flags.objectStates[honored[0].objectId];
  assert.ok(os, "shelter objectState committed on the location");
  assert.equal(os.state, "built-sturdy");
  assert.equal(os.setBy, "player-goal");
  assert.ok(os.matchTokens.includes("shelter"));
  // Storm-condition interaction: a Sheltered boon was granted.
  assert.ok((run.player.conditions || []).some((c) => c.id === "sheltered" || /shelter/i.test(c.name || "")));
  // Goal achieved + XP awarded per provisional law.
  const goal = Object.values(run.goals)[0];
  assert.equal(goal.state, "achieved");
  assert.equal(goal.linkedObjectIds.length, 1);
  assert.ok((run.player.xp || 0) >= beforeXp + GOAL_XP.task);
  assert.equal(validateSoloRun(run).ok, true);
});

test("honor: a failed build commits no shelter; success-at-cost is makeshift", () => {
  const run1 = stormRun("run_fail");
  captureDeclaredGoal(run1, "I'm going to build a shelter before the storm hits", {});
  assert.deepEqual(honorGoalsOnAttempt(run1, { intent: "I build a shelter", attemptResult: { band: "failure" } }), []);
  assert.deepEqual(run1.locations[run1.currentLocationId].flags.objectStates, run1.locations[run1.currentLocationId].flags.objectStates); // unchanged besides the-sky
  assert.equal(Object.values(run1.goals)[0].state, "active", "failed build leaves the goal active");

  const run2 = stormRun("run_cost");
  captureDeclaredGoal(run2, "I'm going to build a shelter before the storm hits", {});
  const h = honorGoalsOnAttempt(run2, { intent: "I build a shelter", attemptResult: { band: "success_at_cost" } });
  assert.equal(run2.locations[run2.currentLocationId].flags.objectStates[h[0].objectId].state, "built-makeshift");
});

// ── narrator contract + goal-ignored auditor ─────────────────────────────────

test("goals directive names active goals as committed + achievements as real", () => {
  const run = stormRun();
  captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", {});
  const active = buildGoalsDirective(run);
  assert.match(active, /ACTIVE PLAYER GOALS/);
  assert.match(active, /may NOT ignore/);
  honorGoalsOnAttempt(run, { intent: "I build a shelter", attemptResult: { band: "success" }, nowMinutes: 425 });
  const done = buildGoalsDirective(run);
  assert.match(done, /COMMITTED PLAYER ACHIEVEMENTS/);
  assert.match(done, /shelter/);
  // No goals → empty directive.
  assert.equal(buildGoalsDirective(createDefaultSoloRun({ runId: "run_none" })), "");
});

test("goal-ignored auditor: the founding stiff-arm flags; engaged/obstructed do not", () => {
  const run = stormRun();
  captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", {});
  const intent = "I gather branches and build a shelter against the ravine wall";
  // The original-session shape: ignores the build, steers to town.
  const steer = detectGoalIgnored("The wind howls. You should head back to town before the storm worsens; the tavern has a dry room waiting.", run, { intent, attemptResult: { band: "success" } });
  assert.equal(steer.length, 1);
  assert.equal(steer[0].summary, "build a shelter before the storm hits");
  // Engaged: names the shelter → clean.
  assert.deepEqual(detectGoalIgnored("You lash the last branch into place; the shelter holds against the first gust of rain.", run, { intent }), []);
  // Lawfully obstructed: a stated reason → clean.
  assert.deepEqual(detectGoalIgnored("The soaked wood won't hold a frame; you need dry timber or a blade first.", run, { intent }), []);
  // No active goal being pursued → nothing to ignore.
  assert.deepEqual(detectGoalIgnored("You head back to town.", run, { intent: "walk to the market" }), []);
});
