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

  // Stage 0 (obtain_item) advances now that the crate is held.
  const afterTake = advanceQuests(withCrate, { attemptResult: { success: true } });
  assert.equal(afterTake.advanced.length, 1, "obtain_item advanced the quest to the deliver stage");
  assert.equal(withCrate.quests[DELIVERY_QUEST_ID].stage, 1);

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
  assert.equal(r2.run.quests[DELIVERY_QUEST_ID].stage, 1, "obtain_item advanced to the deliver stage");

  // 3) MOVE to the destination (free-text, named) -> deliver completes + reward.
  const r3 = resolveSoloAction(r2.run, { type: "attempt", actorId: "player", intent: "travel to The Ashen Edge" }, { now: T(3) });
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
