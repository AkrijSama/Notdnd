import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { detectPlayerGoal, capturePlayerObjective, getQuestPayload } from "../server/solo/quests.js";

// Track A / Problem 1 — STATE owns NARRATIVE truth: a durable goal the player
// DECLARES, and the world AGREES to, becomes a tracked objective on the run —
// not a success paragraph that mutates nothing.

const scripted = (extra = {}) => ({
  summary: "You steady yourself and focus your will.",
  recommendedAbility: "wisdom",
  dc: 10,
  needsCheck: false,
  advantage: false,
  disadvantage: false,
  successNarration: "You resolve to make this ground your own.",
  failureNarration: "The thought slips away.",
  proposedEffects: [],
  ...extra
});

function attempt(run, intent, providerExtra = {}) {
  return resolveSoloAction(
    run,
    { type: "attempt", actorId: "player", intent },
    { attemptProviderFn: () => scripted(providerExtra), fixedRoll: 18, now: "2026-01-01T00:00:00.000Z" }
  );
}
const playerQuestIds = (run) => Object.keys(run.quests || {}).filter((k) => k.startsWith("quest_player_"));

// ── detectPlayerGoal: explicit durable intent qualifies ──────────────────────
const GOALS = [
  "I want to make this place my own, meditate on what it would take",
  "I claim this ruin as my own",
  "My goal is to rebuild this keep and rule it",
  "I intend to establish a stronghold here",
  "I will reclaim my family's throne",
  "I'm going to take over this fort and hold this ground"
];
for (const intent of GOALS) {
  test(`detectPlayerGoal POSITIVE: "${intent.slice(0, 32)}…"`, () => {
    assert.ok(detectPlayerGoal(intent), "an explicit durable goal must be detected");
  });
}

// ── flavor / ordinary actions are NOT goals (bounded — not every sentence) ────
const NOT_GOALS = [
  "I climb the crumbling wall",
  "I search the room for hidden levers",
  "I meditate on the silence of the ruins",
  "I attack the ogre with my sword",
  "I want to rest by the fire",
  "I look around the chamber",
  "force the warped door open",
  "I want to find a torch"
];
for (const intent of NOT_GOALS) {
  test(`detectPlayerGoal NEGATIVE: "${intent.slice(0, 32)}"`, () => {
    assert.equal(detectPlayerGoal(intent), null, "flavor / ordinary action is not a durable goal");
  });
}

test("objective is rewritten to 2nd-person and trailing flavor is trimmed", () => {
  const goal = detectPlayerGoal("I want to make this place my own, meditate on what it would take");
  assert.equal(goal.description, "Make this place your own.");
});

// ── capturePlayerObjective: the world must AGREE ─────────────────────────────
test("capture: a declared goal on a real SUCCESS becomes a tracked player-authored objective", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const q = capturePlayerObjective(run, { intent: "I want to make this place my own", attemptResult: { success: true } });
  assert.ok(q, "objective created");
  assert.equal(q.authoredBy, "player");
  assert.equal(q.isMain, false);
  assert.equal(q.status, "active");
  assert.equal(q.objective, "Make this place your own.");
  assert.equal(q.completion, null, "no auto-completion predicate — an open, tracked aim");
  assert.ok(run.quests[q.questId], "persisted on run.quests");
});

test("capture: NO objective on a non-success / gate / refusal / unpossessed claim (gate's domain, not authorship)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(capturePlayerObjective(run, { intent: "I claim the throne", attemptResult: { success: false } }), null);
  assert.equal(capturePlayerObjective(run, { intent: "I claim the throne", attemptResult: { success: true, gated: true } }), null);
  assert.equal(capturePlayerObjective(run, { intent: "I claim the throne", attemptResult: { success: true, consequence: { type: "refused" } } }), null);
  assert.equal(capturePlayerObjective(run, { intent: "I claim the throne", attemptResult: { success: true, unpossessed: true } }), null);
  assert.equal(playerQuestIds(run).length, 0, "nothing was written");
});

test("capture: flavor never creates an objective even on a success", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(capturePlayerObjective(run, { intent: "I climb the wall", attemptResult: { success: true } }), null);
  assert.equal(playerQuestIds(run).length, 0);
});

test("capture: an identical re-declared goal is de-duped (one objective, not many)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.ok(capturePlayerObjective(run, { intent: "I will claim this keep as my own", attemptResult: { success: true } }));
  assert.equal(capturePlayerObjective(run, { intent: "I claim this keep as my own", attemptResult: { success: true } }), null);
  assert.equal(playerQuestIds(run).length, 1, "the same goal is captured once");
});

// ── end-to-end through the action pipeline (the repro) ───────────────────────
test("PIPELINE: declaring a goal that succeeds surfaces a player objective in the scene quest payload", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const res = attempt(run, "I want to make this place my own, meditate on what it would take");
  assert.equal(res.ok, true);
  assert.ok(res.playerObjectiveCaptured, "capture is flagged on the action result");
  const { activeQuests } = getQuestPayload(res.run);
  assert.ok(
    activeQuests.some((q) => q.authoredBy === "player" && q.objective === "Make this place your own."),
    "the declared goal is now a tracked, surfaced objective"
  );
});

test("PIPELINE: an ordinary action creates no objective (no false positives in the loop)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const res = attempt(run, "I search the chamber for hidden levers");
  assert.equal(res.ok, true);
  assert.equal(res.playerObjectiveCaptured, undefined, "no goal captured for a plain search");
  assert.equal(playerQuestIds(res.run).length, 0);
});
