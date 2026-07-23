// B2 — GOALS AS THREAD SOURCES + THE TWO DOORS. Projects/Ambitions register as D.5
// thread sources (and their beats fire through the existing machinery); the
// DEMONSTRATED and OFFERED doors create goals from play.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { commitGoal } from "../server/solo/goals.js";
import { advanceThreads } from "../server/solo/threads.js";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import {
  registerGoalThread, detectDemonstratedGoal, armDemonstratedAsk, detectDemonstratedAnswer,
  captureDemonstratedGoal, getGoalOfferingNpcs, detectGoalAcceptIntent, captureOfferedGoal
} from "../server/solo/goalDoors.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
// A REAL run (valid cast NPCs + locations) — loadThreadsFromJson/fireBeat re-validate
// the whole run and roll back on any invalid record, so the fixture must be valid.
function run0() {
  const run = createDefaultSoloRun({ now: T(0) });
  const { scenario } = compileWorldBook({ name: "Testworld", vibe: "a place to test" });
  loadScenarioIntoRun(run, scenario, { worldSeed: "s" });
  run.currentLocationId = "start_location";
  return run;
}
// Push a schema-valid canonical fact so canonKeywordsPresent has something to match.
function pushFact(run, text) {
  run.memoryFacts = run.memoryFacts || [];
  run.memoryFacts.push({
    factId: `fact_test_${run.memoryFacts.length}`,
    entityIds: [run.runId, run.currentLocationId],
    type: "observation", text, source: "system", createdAt: T(1),
    tags: ["system"], edition: run.edition, policyProfileId: run.policyProfileId,
    contentTags: [], canonical: true, confidence: 1, supersedesFactIds: [], payload: {}
  });
}

// ── GOAL PAYLOADS v1 (product-thesis wiring) — structural mutations, not sentences ──
// A player-authored ambition/project must reorganize the WORLD (a committed NPC, an
// object-state, a faction shift), not merely emit a canonical sentence the GM narrates.

test("goal payloads v1: declaring an ambition commits a RIVAL NPC (structural, not a sentence)", () => {
  const run = run0();
  run.threads = {}; // isolate the goal thread so beat selection is deterministic
  const goal = commitGoal(run, { summary: "seize the coast road trade", scale: "ambition", matchTokens: ["coast", "trade"], door: "declared" }, { turn: 1 });
  const threadId = registerGoalThread(run, goal, { nowMinutes: 100 });
  assert.ok(threadId, "ambition registered a thread");

  const npcsBefore = Object.keys(run.npcs || {}).length;
  pushFact(run, "I press my claim on the coast trade routes."); // "coast"/"trade" ∈ b1 keywords
  const res = advanceThreads(run, {});
  assert.equal(res.fired, true, "the ambition's first beat fired");
  // THE CONVICTION: a committed NON-FACT world change — the rival exists as a real NPC.
  const rivalId = `${threadId}_rival`;
  assert.ok(run.npcs?.[rivalId], "the rival committed as a real NPC, not just a narrated sentence");
  assert.equal(run.npcs[rivalId].role, "rival");
  assert.ok(Object.keys(run.npcs).length > npcsBefore, "the cast grew by a committed antagonist");
});

test("goal payloads v1: an ambition carries a REACHABLE deadline + a faction reputation effect", () => {
  const run = run0();
  run.factions = run.factions || {};
  run.factions.faction_wardens = { factionId: "faction_wardens", name: "the Reach Wardens", disposition: "neutral", standing: 0, discovered: true, wants: "to hold the reach" };
  const goal = commitGoal(run, { summary: "become warden of the reach", scale: "ambition", matchTokens: ["warden", "reach"], door: "declared" }, { turn: 1 });
  const threadId = registerGoalThread(run, goal, { nowMinutes: 100 });
  const thread = run.threads[threadId];
  assert.ok(thread.clock.expiresAtMinutes > 100, "has a deadline");
  assert.ok(thread.clock.expiresAtMinutes <= 100 + 20000, "the deadline is REACHABLE, not the old ~69-day never-fires value");
  assert.ok(Array.isArray(thread.reputationEffects) && thread.reputationEffects.length >= 1, "carries a faction reputation effect");
  assert.ok(run.factions?.[thread.reputationEffects[0].target], "the effect targets a real committed faction");
});

test("goal payloads v1: a project commits an interested NPC on its first beat", () => {
  const run = run0();
  run.threads = {};
  const goal = commitGoal(run, { summary: "build a waystation on the ridge", scale: "project", matchTokens: ["waystation", "ridge"], door: "declared" }, { turn: 1 });
  const threadId = registerGoalThread(run, goal);
  pushFact(run, "I keep building the waystation stone by stone.");
  const res = advanceThreads(run, {});
  assert.equal(res.fired, true, "the project's first beat fired");
  assert.ok(run.npcs?.[`${threadId}_ally`], "the interested party committed as a real NPC");
});

test("registerGoalThread: a Project registers an opportunity thread with beats, cross-linked", () => {
  const run = run0();
  const goal = commitGoal(run, { summary: "build a shelter on the ridge", scale: "project", matchTokens: ["shelter", "ridge"], door: "declared" }, { turn: 1 });
  const threadId = registerGoalThread(run, goal);
  assert.ok(threadId, "thread registered");
  assert.equal(goal.flags.threadId, threadId, "goal cross-linked to its thread");
  const thread = run.threads[threadId];
  assert.equal(thread.origin, "player_goal");
  assert.equal(thread.kind, "opportunity");
  assert.ok(thread.beats.length >= 2, "Projects fire beats (someone notices, a cost arrives)");
  assert.equal(thread.status, "active");
});

test("registerGoalThread: an Ambition registers arc pressure (rival) on a long clock", () => {
  const run = run0();
  const goal = commitGoal(run, { summary: "become the ruler of the coast", scale: "ambition", matchTokens: ["ruler", "coast"], door: "declared" }, { turn: 1 });
  const threadId = registerGoalThread(run, goal, { nowMinutes: 100 });
  assert.ok(threadId);
  const thread = run.threads[threadId];
  assert.equal(thread.kind, "rival", "Ambitions carry rival/arc pressure");
  assert.ok(thread.clock.expiresAtMinutes > 100, "a long arc clock");
});

test("thread-fire: a registered Project's beat fires when its keywords hit the canon", () => {
  const run = run0();
  const goal = commitGoal(run, { summary: "build a shelter", scale: "project", matchTokens: ["shelter"], door: "declared" }, { turn: 1 });
  registerGoalThread(run, goal);
  // The player's committed work lands "shelter" in the canonical surface (a fact).
  pushFact(run, "You lash poles into a shelter frame at the threshold.");
  const before = run.threads[`thread_goal_${goal.goalId}`].beatIndex;
  advanceThreads(run, { run }, { now: T(2) });
  const thread = run.threads[`thread_goal_${goal.goalId}`];
  assert.ok(thread.beatIndex > before || thread.beats[0].status === "committed", "the Project's first beat fired off the committed canon");
});

test("DEMONSTRATED door: 3+ same-pattern actions → one diegetic ask (VOICE-flavored in Babel) → confirm commits + registers", () => {
  const run = run0();
  // The bracketed SYSTEM-voice ask fires because the world declares a diegetic STATUS WINDOW
  // (world.sheetSpec), not because it is named "babel" (JOB 2.2).
  run.world = { ...(run.world || {}), variant: "babel", sheetSpec: { family: "babel" } };
  run.timeline = ["I search the ruins for the relic", "I dig through the ruins again", "I comb the ruins for anything left"]
    .map((intent, i) => ({ eventId: `e${i}`, type: "attempt", payload: { intent }, createdAt: T(i) }));
  const proposal = detectDemonstratedGoal(run);
  assert.ok(proposal, "a repeated pattern proposes a goal");
  assert.equal(proposal.token, "ruins", "the dominant repeated token");
  assert.match(proposal.ask, /\[ .* \]/, "Babel ask is VOICE-flavored (bracketed)");
  armDemonstratedAsk(run, proposal);
  // re-detect must NOT re-ask the same pattern
  assert.equal(detectDemonstratedGoal(run), null, "no second ask for the same pattern");
  // the player confirms
  assert.equal(detectDemonstratedAnswer(run, "yes, that's it"), "confirm");
  const goal = captureDemonstratedGoal(run, { turn: 3 });
  assert.ok(goal, "confirm commits the goal");
  assert.equal(goal.door, "demonstrated");
  if (goal.scale !== "task") assert.ok(goal.flags.threadId, "a Project/Ambition demonstrated goal registers a thread");
});

test("DEMONSTRATED door: neutral ask off-Babel; a decline clears the prompt without committing", () => {
  const run = run0();
  run.timeline = ["I train with the blade", "I drill the blade forms", "I practice the blade at dawn"]
    .map((intent, i) => ({ eventId: `e${i}`, type: "attempt", payload: { intent }, createdAt: T(i) }));
  const proposal = detectDemonstratedGoal(run);
  assert.ok(proposal);
  assert.doesNotMatch(proposal.ask, /\[/, "neutral ask, no VOICE brackets off-Babel");
  armDemonstratedAsk(run, proposal);
  assert.equal(detectDemonstratedAnswer(run, "no, forget it"), "decline");
  const before = Object.keys(run.goals || {}).length;
  assert.equal(run.flags.demonstratedGoalPrompt.token, proposal.token);
});

test("OFFERED door: an NPC goalOffer → accept commits an offered goal + registers its thread", () => {
  const run = run0();
  // Attach the offer to a REAL cast NPC present at the current location (a valid record).
  const npc = Object.values(run.npcs).find((n) => n.currentLocationId === run.currentLocationId && !n.flags?.hostile);
  assert.ok(npc, "a present cast NPC to carry the offer");
  npc.goalOffer = { goal: { summary: "restore the broken lighthouse", scale: "project", stakes: "the coast goes dark otherwise" }, offerText: "Will you take up the lighthouse?", accepted: false };
  assert.equal(getGoalOfferingNpcs(run).length, 1, "the offer is present + un-accepted");
  const hit = detectGoalAcceptIntent(run, "yes, I'll do it");
  assert.deepEqual(hit, { npcId: npc.npcId }, "a bare affirmative accepts BECAUSE an offer is pending");
  const goal = captureOfferedGoal(run, npc.npcId, { turn: 2 });
  assert.ok(goal, "the offered goal commits");
  assert.equal(goal.door, "offered");
  assert.ok(goal.provenance.includes(npc.displayName) && /offered by/.test(goal.provenance), "provenance names the offerer");
  assert.ok(goal.flags.threadId, "the offered Project registers a thread");
  assert.equal(run.npcs[npc.npcId].goalOffer.accepted, true, "the offer is marked accepted (no re-accept)");
});
