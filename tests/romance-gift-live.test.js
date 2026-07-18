// romance-live wiring: (1) the gift intent route makes commitGift live-reachable
// through resolveAttemptAction; (2) dispositionCueText surfaces romance-tier
// CROSSINGS distinctly from the generic warmth line. Reputation math itself is
// read-only here (owner may re-rule thresholds) — these tests assert routing,
// transaction integrity, and cue selection, never tune numbers.
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { resolveAttemptAction, resolveGiftIntent, giftIsContested } from "../server/solo/attempt.js";
import { dispositionCueText } from "../src/components/soloSceneShell.js";

const seq = () => {
  let n = 0;
  return () => `id${++n}`;
};

function provider(over = {}) {
  return () => ({
    summary: "You act.", recommendedAbility: "charisma", dc: 12,
    needsCheck: true, advantage: false, disadvantage: false,
    successNarration: "It lands.", failureNarration: "It does not.",
    proposedEffects: [], failureConsequence: null, ...over
  });
}

function giftRun({ npcExtra = {}, itemExtra = {} } = {}) {
  const run = createDefaultSoloRun({ runId: "gift_test" });
  run.npcs = {
    npc_mara: {
      npcId: "npc_mara", displayName: "Mara", role: "herbalist", status: "present",
      known: true, tags: [], flags: {}, memoryFactIds: [], origin: "hybrid",
      currentLocationId: run.currentLocationId, ageClass: "adult", romanceable: true,
      preferences: [], ...npcExtra
    }
  };
  run.inventory = {
    itm_locket: {
      itemId: "itm_locket", name: "silver locket", description: "a small keepsake",
      quantity: 1, usable: false, consumable: false, tags: [], flags: {}, ...itemExtra
    }
  };
  return run;
}

function attempt(run, intent, options = {}) {
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, {
    attemptProviderFn: provider(),
    idFactory: seq(),
    ...options
  });
}

// ── FIX 1: gift route ─────────────────────────────────────────────────────────

test("gift intent resolves a present NPC + held item; safe gift is automatic (no roll) and commits via commitGift", () => {
  const run = giftRun();
  const resolved = attempt(run, "give the silver locket to Mara");
  assert.equal(resolved.ok, true);
  const r = resolved.attemptResult;
  // no-stakes-no-roll: a friendly/neutral present NPC never rolls for a gift,
  // even though the provider proposed needsCheck:true.
  assert.equal(r.band, "automatic");
  assert.equal(r.checkResult, null);
  const gift = r.giftChange;
  assert.ok(gift, "giftChange committed on the live attempt path");
  assert.equal(gift.targetNpcId, "npc_mara");
  assert.equal(gift.itemId, "itm_locket");
  assert.ok(gift.delta > 0, "affinity moved");
  // single committed transaction: the item left the giver's inventory.
  assert.equal(resolved.run.inventory.itm_locket, undefined, "item left inventory");
  assert.equal(validateSoloRun(resolved.run).ok, true, "run stays schema-valid");
});

test("gift decrements quantity by exactly one (no dupes, no over-removal)", () => {
  const run = giftRun({ itemExtra: { quantity: 3 } });
  const resolved = attempt(run, "offer Mara the silver locket");
  assert.equal(resolved.attemptResult.giftChange.itemId, "itm_locket");
  assert.equal(resolved.run.inventory.itm_locket.quantity, 2, "exactly one unit transferred");
});

test("preference pricing reaches commitGift (loved-tag gift amplifies vs base)", () => {
  const plain = attempt(giftRun(), "give the silver locket to Mara");
  const loved = attempt(
    giftRun({ npcExtra: { preferences: [{ tag: "keepsake", weight: 3 }] }, itemExtra: { tags: ["keepsake"] } }),
    "give the silver locket to Mara"
  );
  const basePriced = plain.attemptResult.giftChange.delta;
  const lovedPriced = loved.attemptResult.giftChange.delta;
  assert.ok(lovedPriced > basePriced, `loved-tag gift (${lovedPriced}) outprices untagged (${basePriced}) — Stardew law reached`);
});

test("non-romanceable NPC still receives gifts: affinity applies, romanceTier stays null", () => {
  const resolved = attempt(giftRun({ npcExtra: { romanceable: false } }), "give the silver locket to Mara");
  const gift = resolved.attemptResult.giftChange;
  assert.ok(gift.delta > 0, "affinity applied");
  assert.equal(gift.romanceTier, null, "romanceTier stays null per reputation.js gate");
});

test("contested gift (hostile NPC) routes through the normal gate; a failed roll transfers nothing", () => {
  const run = giftRun({ npcExtra: { tags: ["hostile"] } });
  assert.equal(giftIsContested(run, run.npcs.npc_mara), true);
  const resolved = attempt(run, "give the silver locket to Mara", { fixedRoll: 1 });
  const r = resolved.attemptResult;
  assert.notEqual(r.band, "automatic", "hostile gift is not swept into the automatic tier");
  assert.equal(r.success, false);
  assert.equal(r.giftChange, null, "no commit on failure");
  assert.ok(resolved.run.inventory.itm_locket, "item never left inventory on the failure path");
});

test("gift grounding fails OPEN: no held-item match / absent NPC / inverted direction -> null", () => {
  const run = giftRun();
  assert.equal(resolveGiftIntent(run, { intent: "give Mara the ruby amulet" }), null, "unheld item: no gift grounding (possession gate owns the refusal)");
  assert.equal(resolveGiftIntent(run, { intent: "give me the silver locket" }), null, "inverted direction is not a gift");
  const empty = createDefaultSoloRun({ runId: "gift_none" });
  empty.npcs = {};
  assert.equal(resolveGiftIntent(empty, { intent: "give the silver locket to Mara" }), null, "no present NPC: no grounding");
});

test("a specifically-named unheld gift item is refused pre-roll by the existing possession gate", () => {
  // "silver dagger" is a recognized ITEM-KIND claim (category noun) with a
  // distinctive descriptor — the shape the possession gate refuses when unheld.
  const run = giftRun();
  delete run.inventory.itm_locket;
  const resolved = attempt(run, "hand over my silver dagger to Mara");
  assert.equal(resolved.ok, true);
  const r = resolved.attemptResult;
  assert.equal(r.success, false, "refused, not narrated");
  assert.equal(r.checkResult, null, "no roll was thrown");
  assert.ok(r.warnings.includes("ATTEMPT_ITEM_UNPOSSESSED"), "the possession gate owned the refusal");
  assert.ok(!r.giftChange, "nothing was gifted");
});

// ── FIX 2: tier-crossing cue ──────────────────────────────────────────────────

test("cue: a romance-tier PROMOTION supersedes the generic warmth line", () => {
  const text = dispositionCueText({
    targetName: "Mara", meter: "affection", delta: 3,
    romanceTierBefore: "friendly", romanceTier: "close"
  });
  assert.equal(text, "Something has shifted between you and Mara.");
});

test("cue: a romance-tier DEMOTION renders the cooled line", () => {
  const text = dispositionCueText({
    targetName: "Mara", meter: "affection", delta: -2,
    romanceTierBefore: "courting", romanceTier: "close"
  });
  assert.equal(text, "Something has cooled between you and Mara.");
});

test("cue: no crossing -> the generic line is unchanged (and null tiers never crash)", () => {
  const same = dispositionCueText({
    targetName: "Mara", meter: "affection", delta: 3,
    romanceTierBefore: "friendly", romanceTier: "friendly"
  });
  assert.equal(same, "Mara seems to warm to you.");
  const nullTier = dispositionCueText({ targetName: "Mara", meter: "trust", delta: 3, romanceTierBefore: null, romanceTier: null });
  assert.equal(nullTier, "Mara seems to trust you a little more.");
});
