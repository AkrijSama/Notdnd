import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { detectTakeIntent, resolveTakeAction, getTakeableDetails } from "../server/solo/take.js";
import { detectQuestAcceptIntent, resolveQuestAccept } from "../server/solo/questFlow.js";
import { advanceQuests } from "../server/solo/quests.js";
import { buildDeliveryOffer, DELIVERY_QUEST_ID, DELIVERY_CRATE_ID, DELIVERY_PAY_ID } from "../server/campaign/authoredQuests.js";

// ONE COMMITTED VERTICAL LOOP: accept a job -> take a real crate -> deliver -> reward.
// Every step commits server-owned state; nothing is narrated that isn't committed.
// A static/narrate-only run FAILS these by construction.

const T = (n) => `2026-02-01T00:00:0${n}.000Z`;

// A campaign run positioned WITH the quest-giver, who carries a live delivery offer.
function deliveryRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.currentLocationId = "second_location";
  run.locations.second_location.state = { visited: true, discovered: true };
  run.locations.third_location.name = "The Ashen Edge";
  const offer = buildDeliveryOffer(
    { tone: "dark fantasy", name: "Hollowmere" },
    { giverLocationName: "The Market", destinationId: "third_location", destinationName: "The Ashen Edge" }
  );
  run.npcs = {
    npc_quest_giver: {
      npcId: "npc_quest_giver",
      displayName: "A waiting figure",
      role: "stranger",
      currentLocationId: "second_location",
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: ["quest"],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      questOffer: offer
    }
  };
  return run;
}

const invQty = (run, itemId) => {
  const bag = run.inventory || {};
  return bag[itemId] ? bag[itemId].quantity : 0;
};

// ── PART 1: TAKE mechanic ────────────────────────────────────────────────────
test("detectTakeIntent fires ONLY when a real takeable object is present", () => {
  const run = deliveryRun();
  // No takeable yet (crate is placed on accept).
  assert.equal(detectTakeIntent(run, "take the crate"), null, "nothing takeable present -> null (never mint)");
  // Place the crate as the accept step would.
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  assert.equal(accepted.ok, true);
  assert.ok(getTakeableDetails(accepted.run).length === 1, "a takeable crate is now present");
  for (const i of ["take the crate", "grab the strongbox", "pick it up", "pocket the box", "make off with the cargo"]) {
    assert.ok(detectTakeIntent(accepted.run, i), `"${i}" should route to take`);
  }
  for (const i of ["go deeper", "search the area", "examine the crate", "talk to the figure", "climb the wall"]) {
    assert.equal(detectTakeIntent(accepted.run, i), null, `"${i}" is not a take`);
  }
});

test("resolveTakeAction commits the item to inventory and marks the object taken", () => {
  const run = deliveryRun();
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  const detailId = getTakeableDetails(accepted.run)[0].detailId;
  const take = resolveTakeAction(accepted.run, { type: "take", detailId, targetLocationId: "second_location" }, { now: T(2) });
  assert.equal(take.ok, true);
  assert.equal(take.takeResult.itemId, DELIVERY_CRATE_ID);
  assert.equal(invQty(take.run, DELIVERY_CRATE_ID), 1, "crate committed to inventory");
  // Source object marked taken -> not takeable again.
  assert.equal(getTakeableDetails(take.run).length, 0, "the crate can't be taken twice");
  const secondTry = resolveTakeAction(take.run, { type: "take", detailId, targetLocationId: "second_location" }, { now: T(3) });
  assert.equal(secondTry.ok, false, "re-taking a taken object refuses");
});

test("resolveTakeAction refuses a target that isn't present (never mints an item)", () => {
  const run = deliveryRun();
  const take = resolveTakeAction(run, { type: "take", detailId: "no_such_detail", targetLocationId: "second_location" }, { now: T(1) });
  assert.equal(take.ok, false);
  assert.equal(invQty(take.run || run, DELIVERY_CRATE_ID), 0, "nothing was conjured");
});

// ── PART 2: quest lifecycle (accept, deliver predicate, reward) ───────────────
test("detectQuestAcceptIntent requires BOTH a live offer present AND acceptance phrasing", () => {
  const run = deliveryRun();
  for (const i of ["ok, I'll do it", "I accept the job", "sure", "yes", "deal", "count me in"]) {
    assert.ok(detectQuestAcceptIntent(run, i), `"${i}" should accept`);
  }
  for (const i of ["what's the pay?", "who are you?", "no thanks", "tell me more"]) {
    assert.equal(detectQuestAcceptIntent(run, i), null, `"${i}" is not an acceptance`);
  }
  // Accept it -> offer is consumed -> no longer acceptable.
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  assert.equal(detectQuestAcceptIntent(accepted.run, "yes, I'll do it"), null, "an accepted offer is not re-acceptable");
});

test("resolveQuestAccept instantiates a REAL quest, places the crate, reveals the destination", () => {
  const run = deliveryRun();
  assert.equal(Object.keys(run.quests || {}).length, 0, "no quest before accept");
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  assert.equal(accepted.ok, true);
  const quest = accepted.run.quests[DELIVERY_QUEST_ID];
  assert.ok(quest && quest.status === "active", "a real tracked quest now exists (not quests:{})");
  assert.equal(quest.stage, 0);
  assert.equal(getTakeableDetails(accepted.run).length, 1, "the takeable crate was placed in the world");
  assert.equal(accepted.run.locations.third_location.state.discovered, true, "destination revealed (told-of)");
  assert.equal(accepted.run.npcs.npc_quest_giver.questOffer.accepted, true, "offer marked accepted");
});

test("deliver predicate + REWARD: completing the delivery grants pay, consumes the crate, awards xp", () => {
  // Assemble a run already carrying the crate, at the destination, on the deliver stage.
  const base = deliveryRun();
  const accepted = resolveQuestAccept(base, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) }).run;
  const detailId = getTakeableDetails(accepted)[0].detailId;
  const withCrate = resolveTakeAction(accepted, { type: "take", detailId, targetLocationId: "second_location" }, { now: T(2) }).run;

  // Stage 0 (obtain_item) advances now that the crate is held -> the HAZARD stage.
  const afterTake = advanceQuests(withCrate, { attemptResult: { success: true } });
  assert.equal(afterTake.advanced.length, 1, "obtain_item advanced the quest to the hazard stage");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].stage, 1);

  // STAKES: a MISSED check does NOT advance (and, with failOnMiss off, does not
  // fail the quest — the cost of the miss is the attempt's own consequence).
  // The hazard stage is roll-BOUND (quests.js checkRollBinds): the action's
  // intent must reference the road obstacle, so the drive carries one.
  const roadIntent = { intent: "force my way past the road-wardens" };
  const missed = advanceQuests(withCrate, { action: roadIntent, attemptResult: { success: false, checkResult: { success: false } } });
  assert.equal(missed.advanced.length, 0, "a failed check does not clear the road");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].stage, 1, "still at the hazard stage after a miss");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].status, "active", "a miss costs, it does not void the arc");

  // STAKES: a SUCCESSFUL check clears the road -> the deliver stage.
  const cleared = advanceQuests(withCrate, { action: roadIntent, attemptResult: { success: true, checkResult: { success: true } } });
  assert.equal(cleared.advanced.length, 1, "a passed check advances past the hazard");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].stage, 2);

  // Not yet at the destination -> deliver does NOT complete.
  const notThereYet = advanceQuests(withCrate, {});
  assert.equal(notThereYet.completed.length, 0, "deliver requires being AT the destination");

  // Arrive at the destination WITH the crate -> deliver completes + reward fires.
  withCrate.currentLocationId = "third_location";
  const delivered = advanceQuests(withCrate, {});
  assert.equal(delivered.completed.length, 1, "deliver completed at the destination");
  assert.equal(delivered.rewarded.length, 1, "a reward was granted");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].status, "completed");
  assert.equal(invQty(withCrate, DELIVERY_PAY_ID), 1, "PAY committed to inventory");
  assert.equal(invQty(withCrate, DELIVERY_CRATE_ID), 0, "crate consumed on hand-over (delivered for real)");
  assert.equal(delivered.rewarded[0].xp, 120, "reward xp recorded for the resolver to award");
});

// ── PART 4 (unit slice): FULL LOOP via resolveSoloAction with NATURAL free-text ─
test("PIPELINE: accept -> take -> deliver all commit through natural free-text", () => {
  let run = deliveryRun();

  // 1) ACCEPT (free-text) -> real quest created.
  const r1 = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Alright, I'll do it." }, { now: T(1) });
  assert.equal(r1.ok, true);
  assert.equal(r1.action.type, "quest_accept", "free-text acceptance rerouted to the quest mechanic");
  assert.ok(r1.run.quests[DELIVERY_QUEST_ID], "quest committed (not quests:{})");

  // 2) TAKE (free-text) -> crate committed to inventory; obtain_item advances the quest.
  const r2 = resolveSoloAction(r1.run, { type: "attempt", actorId: "player", intent: "Grab the strongbox and sling it over my shoulder." }, { now: T(2) });
  assert.equal(r2.action.type, "take", "free-text pickup rerouted to the take mechanic");
  assert.equal(invQty(r2.run, DELIVERY_CRATE_ID), 1, "crate in inventory");
  assert.equal(r2.run.quests[DELIVERY_QUEST_ID].stage, 1, "obtain_item advanced to the HAZARD stage");

  // 3) STAKES BEAT (free-text attempt, pinned roll): a real d20 clears the road.
  const rHaz = resolveSoloAction(r2.run, {
    type: "attempt", actorId: "player", intent: "force my way past the road-wardens",
    testHook: { fixedRoll: 20, providerOutput: {
      summary: "You attempt: force past the wardens", recommendedAbility: "strength", dc: 10,
      needsCheck: true, advantage: false, disadvantage: false,
      successNarration: "You push through.", failureNarration: "They throw you back.",
      proposedEffects: [], failureConsequence: null
    } }
  }, { now: T(3) });
  assert.equal(rHaz.attemptResult?.success, true, "the hazard attempt rolled and succeeded");
  assert.equal(rHaz.run.quests[DELIVERY_QUEST_ID].stage, 2, "passing the check advanced to the deliver stage");

  // 4) MOVE to the destination (free-text, named) -> deliver completes + reward.
  const r3 = resolveSoloAction(rHaz.run, { type: "attempt", actorId: "player", intent: "travel to The Ashen Edge" }, { now: T(4) });
  assert.equal(r3.action.type, "move", "free-text travel rerouted to the move mechanic");
  assert.equal(r3.run.currentLocationId, "third_location", "position committed");
  assert.equal(r3.run.quests[DELIVERY_QUEST_ID].status, "completed", "delivery completed on arrival with the crate");
  assert.equal(invQty(r3.run, DELIVERY_PAY_ID), 1, "REWARD committed to inventory");
  assert.equal(invQty(r3.run, DELIVERY_CRATE_ID), 0, "crate handed over (consumed)");
  assert.ok((r3.run.player?.xp || 0) > 0, "reward xp awarded to the player");
});

test("COHERENCE: a take with no object present stays a normal attempt (nothing committed)", () => {
  const run = deliveryRun();
  // No crate placed (never accepted). A pickup intent must NOT commit an item.
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "take the crate" }, { now: T(1) });
  assert.equal(res.ok, true);
  assert.notEqual(res.action.type, "take", "no takeable present -> not routed to take");
  assert.equal(invQty(res.run, DELIVERY_CRATE_ID), 0, "no item conjured from thin air");
});

// ── CLI-1 fixes: narration branches + suggestion ordering ────────────────────
import { buildActionGmMessage } from "../server/gm/actionNarration.js";
import { activeObjective } from "../server/solo/suggestions.js";

test("NARRATION: a committed take gets a real GM beat grounded in the taken item", () => {
  const run = deliveryRun();
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  const detailId = getTakeableDetails(accepted.run)[0].detailId;
  const take = resolveTakeAction(accepted.run, { type: "take", detailId, targetLocationId: "second_location" }, { now: T(2) });
  const msg = buildActionGmMessage(take.run, { action: { type: "take" }, takeResult: take.takeResult });
  assert.ok(msg, "take now produces a GM message (was null -> silent beat)");
  assert.match(msg, /wax-sealed strongbox/i, "grounded in the REAL taken item");
  assert.match(msg, /committed it to their inventory/i, "prose is anchored to committed state");
});

test("NARRATION: a committed quest-accept voices the giver and the first objective", () => {
  const run = deliveryRun();
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  const msg = buildActionGmMessage(accepted.run, {
    action: { type: "quest_accept" },
    questAccepted: accepted.questAccepted
  });
  assert.ok(msg, "quest_accept now produces a GM message (was null -> silent beat)");
  assert.match(msg, /A waiting figure/, "voices the actual giver");
  assert.match(msg, /Deliver to The Ashen Edge/, "names the real accepted quest");
  assert.match(msg, /Take .*strongbox|first step/i, "hands the player the first objective");
});

test("SUGGESTIONS: an explicitly-ACCEPTED job outranks the ambient main quest in the objective feed", () => {
  const run = deliveryRun();
  // Give the run a main quest too (the ambient spine).
  run.quests = {
    quest_main: {
      questId: "quest_main", status: "active", isMain: true, title: "Blood Debt",
      stages: [{ objective: "Travel to the crossing.", completion: { kind: "reach_location", targetId: "second_location" } }],
      stage: 0, objective: "Travel to the crossing.", completion: { kind: "reach_location", targetId: "second_location" },
      relatedEntityIds: [], memoryFactIds: [], flags: {}
    }
  };
  assert.match(activeObjective(run), /Travel to the crossing/, "main quest surfaces before any acceptance");
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  assert.match(activeObjective(accepted.run), /Take .*strongbox/i, "the accepted delivery objective now leads");
});

test("SUGGESTIONS: the objective tracks the quest's ACTUAL stage index (not stuck on stage 0)", () => {
  const run = deliveryRun();
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) }).run;
  const detailId = getTakeableDetails(accepted)[0].detailId;
  const withCrate = resolveTakeAction(accepted, { type: "take", detailId, targetLocationId: "second_location" }, { now: T(2) }).run;
  advanceQuests(withCrate, { attemptResult: { success: true } }); // obtain_item -> hazard stage
  assert.match(activeObjective(withCrate), /The way to The Ashen Edge is not clear/i,
    "after taking the crate the chip objective is the HAZARD stage, not the already-done take stage");
  // hazard -> deliver: the bound hazard stage needs a road-directed intent.
  advanceQuests(withCrate, { action: { intent: "force my way past the road-wardens" }, attemptResult: { success: true, checkResult: { success: true } } });
  assert.match(activeObjective(withCrate), /Carry .*the rest of the way to The Ashen Edge/i,
    "after clearing the road the chip objective is the DELIVER stage");
});

// ── CLI-2 fixes: the offer is spoken (F2) + the UI can start a campaign (F1) ──
import { buildOpenJobOffers } from "../server/solo/scene.js";
import { buildProviderPromptMessages } from "../server/solo/gmProvider.js";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

test("F2: open offers from PRESENT NPCs surface in the scene payload and vanish once accepted", () => {
  const run = deliveryRun();
  const open = buildOpenJobOffers(run);
  assert.equal(open.length, 1, "the un-accepted offer is exposed");
  assert.match(open[0].offerText, /paid on delivery/i, "carries the actual pitch");
  assert.match(open[0].offerText, /road-wardens/i, "the pitch discloses the road hazard (stakes are honest)");
  const accepted = resolveQuestAccept(run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(1) });
  assert.equal(buildOpenJobOffers(accepted.run).length, 0, "an accepted offer is no longer pitched");
});

test("F2: the GM provider prompt voices a REAL open offer and forbids inventing others", () => {
  const messages = buildProviderPromptMessages({
    runId: "r1", edition: "mainline", location: {},
    openJobOffers: [{ npcName: "A waiting figure", offerText: '"I need a crate carried. Say the word."' }]
  });
  const system = messages[0].content;
  assert.match(system, /REAL work is on offer here/, "the offer note is in the system prompt");
  assert.match(system, /A waiting figure offers: "I need a crate carried/, "grounded in the actual NPC + pitch");
  assert.match(system, /Do NOT invent any other job or reward/, "invention stays forbidden");
  const noOffer = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: {} });
  assert.doesNotMatch(noOffer[0].content, /REAL work is on offer/, "no offer -> no note");
});

test("F1: a custom world picks its start-mode at creation (wizard review), sandbox default, guided selectable", () => {
  const sandboxHtml = renderOnboardingFlow({ step: "character", worldDef: { userWorldId: "uw_x" }, character: { step: 6 } });
  assert.match(sandboxHtml, /How do you want to play\?/);
  assert.match(sandboxHtml, /class="onb-chip active" data-world-mode="sandbox"/, "sandbox is the active default");
  assert.match(sandboxHtml, /data-world-mode="guided"/, "guided adventure is offered");
  const guidedHtml = renderOnboardingFlow({ step: "character", worldDef: { userWorldId: "uw_x", startMode: "guided" }, character: { step: 6 } });
  assert.match(guidedHtml, /class="onb-chip active" data-world-mode="guided"/, "guided selection is reflected");
});
