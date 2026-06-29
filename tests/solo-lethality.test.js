import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  applyDamage,
  attemptRevive,
  findRevivalMeans,
  isDead,
  isDying,
  markDead,
  rollDeathSave,
  revivePlayer
} from "../server/solo/death.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { resolveUseItemAction } from "../server/solo/useItem.js";
import { advanceQuests } from "../server/solo/quests.js";
import { awardXp, levelForXp } from "../server/solo/progression.js";

function freshRun() {
  return createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
}

function setHp(run, current, max = 10) {
  run.player.resources.hitPoints = { current, max };
  run.player.health = current;
  run.player.maxHealth = max;
}

// --- Real HP / damage → dying -----------------------------------------------

test("damage reduces HP and reaching 0 sets the player dying (not safe)", () => {
  const run = freshRun();
  setHp(run, 10, 10);
  const rec = applyDamage(run, 4);
  assert.equal(run.player.resources.hitPoints.current, 6);
  assert.equal(rec.dying, false);
  assert.equal(run.player.status, "alive");

  const rec2 = applyDamage(run, 6);
  assert.equal(run.player.resources.hitPoints.current, 0);
  assert.equal(run.player.status, "dying");
  assert.equal(rec2.dying, true);
  assert.deepEqual(run.player.deathSaves, { successes: 0, failures: 0 });
  assert.equal(validateSoloRun(run).ok, true, "dying run still validates");
});

// --- Death saving throws ----------------------------------------------------

test("death save: 3 failures kills the player permanently and terminates the run", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";

  const a = rollDeathSave(run, { fixedRoll: 5 }); // fail
  assert.equal(a.outcome, "fail");
  assert.equal(run.player.deathSaves.failures, 1);
  const b = rollDeathSave(run, { fixedRoll: 5 }); // fail
  assert.equal(run.player.deathSaves.failures, 2);
  assert.equal(isDead(run), false);
  const c = rollDeathSave(run, { fixedRoll: 5 }); // fail → dead
  assert.equal(c.dead, true);
  assert.equal(run.player.status, "dead");
  assert.equal(run.status, "dead", "run.status is the terminal 'dead'");
  assert.equal(validateSoloRun(run).ok, true);
});

test("death save: 3 successes stabilizes (still 0 HP, no longer rolling)", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";

  rollDeathSave(run, { fixedRoll: 12 });
  rollDeathSave(run, { fixedRoll: 12 });
  const third = rollDeathSave(run, { fixedRoll: 12 });
  assert.equal(third.stabilized, true);
  assert.equal(run.player.status, "stable");
  assert.equal(run.player.resources.hitPoints.current, 0);
  assert.equal(isDead(run), false);
});

test("death save: natural 20 regains 1 HP and returns the player to alive", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  run.player.deathSaves = { successes: 1, failures: 2 };

  const rec = rollDeathSave(run, { fixedRoll: 20 });
  assert.equal(rec.outcome, "nat20_revive");
  assert.equal(run.player.status, "alive");
  assert.equal(run.player.resources.hitPoints.current, 1);
  assert.deepEqual(run.player.deathSaves, { successes: 0, failures: 0 });
});

test("death save: natural 1 counts as two failures", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  const rec = rollDeathSave(run, { fixedRoll: 1 });
  assert.equal(rec.outcome, "nat1_double_fail");
  assert.equal(run.player.deathSaves.failures, 2);
});

test("taking damage at 0 HP is a death-save failure; a crit is two", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  applyDamage(run, 2); // 1 failure
  assert.equal(run.player.deathSaves.failures, 1);
  applyDamage(run, 2, { crit: true }); // 2 failures → 3 total → dead
  assert.equal(run.player.status, "dead");
  assert.equal(run.status, "dead");
});

// --- Instant death (massive damage) -----------------------------------------

test("massive damage at 0 HP is instant death (skips saves)", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  const rec = applyDamage(run, 10); // >= max HP
  assert.equal(rec.instantDeath, true);
  assert.equal(rec.dead, true);
  assert.equal(run.player.status, "dead");
  assert.equal(run.status, "dead");
});

test("massive overkill on the dropping blow is instant death", () => {
  const run = freshRun();
  setHp(run, 4, 10); // 4 HP; 14 damage → 10 overkill ≥ max
  const rec = applyDamage(run, 14);
  assert.equal(rec.instantDeath, true);
  assert.equal(run.player.status, "dead");
});

// --- Permadeath is terminal -------------------------------------------------

test("a dead run is terminal: no further damage, no further actions", () => {
  const run = freshRun();
  markDead(run);
  assert.equal(isDead(run), true);
  const rec = applyDamage(run, 5);
  assert.equal(rec.dead, true);
  assert.equal(rec.amount, 0, "no HP movement on a corpse");

  const resolved = resolveSoloAction(run, { type: "attempt", intent: "stand up and fight" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "RUN_TERMINAL");
});

// --- Possession-gated revival -----------------------------------------------

test("revival requires a POSSESSED means; absent one, the player stays dead", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  assert.equal(findRevivalMeans(run), null);
  // The killing blow with no means → permadeath.
  run.player.deathSaves = { successes: 0, failures: 2 };
  rollDeathSave(run, { fixedRoll: 3 }); // 3rd failure
  assert.equal(run.player.status, "dead");
  // Even an explicit revive attempt fails with no means.
  const revive = attemptRevive(run);
  assert.equal(revive.ok, false);
  assert.equal(revive.reason, "NO_REVIVAL_MEANS");
  assert.equal(run.player.status, "dead");
});

test("a held revival item pre-empts death once, then is consumed (gone)", () => {
  const run = freshRun();
  run.inventory = {
    revive_scroll: {
      itemId: "revive_scroll",
      name: "Scroll of Revivify",
      quantity: 1,
      usable: true,
      consumable: true,
      tags: ["revival"],
      flags: {},
      use: { effectType: "revive", amount: 1 }
    }
  };
  setHp(run, 0, 10);
  run.player.status = "dying";
  run.player.deathSaves = { successes: 0, failures: 2 };

  const means = findRevivalMeans(run);
  assert.deepEqual(means, { kind: "item", itemId: "revive_scroll" });

  // The 3rd failure would kill — but the possessed item revives instead.
  const rec = rollDeathSave(run, { fixedRoll: 2 });
  assert.equal(rec.dead, false);
  assert.equal(rec.revived, true);
  assert.equal(run.player.status, "alive");
  assert.equal(run.player.resources.hitPoints.current, 1);
  assert.equal(run.inventory.revive_scroll.quantity, 0, "item consumed");

  // No second life: the same death now sticks.
  setHp(run, 0, 10);
  run.player.status = "dying";
  run.player.deathSaves = { successes: 0, failures: 2 };
  rollDeathSave(run, { fixedRoll: 2 });
  assert.equal(run.player.status, "dead");
});

test("use_item revive: a dying player plays the scroll to come back; item gone", () => {
  const run = freshRun();
  run.inventory = {
    revive_scroll: {
      itemId: "revive_scroll",
      name: "Scroll of Revivify",
      quantity: 1,
      usable: true,
      consumable: true,
      tags: ["revival"],
      flags: {},
      use: { effectType: "revive", amount: 3 }
    }
  };
  setHp(run, 0, 10);
  run.player.status = "dying";

  const result = resolveUseItemAction(run, { type: "use_item", itemId: "revive_scroll" });
  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.revived, true);
  assert.equal(result.run.player.status, "alive");
  assert.equal(result.run.player.resources.hitPoints.current, 3);
  assert.equal(result.run.inventory.revive_scroll.quantity, 0);
});

test("use_item consume decrements the state-contract player.inventory[] mirror in sync", () => {
  // A granted item lives in BOTH the authoritative run.inventory (object) and the
  // player.inventory[] array the scene renders from. Consuming it must drop the
  // qty in BOTH — otherwise a spent item keeps showing on the sheet (the bug
  // Opus 2 flagged: authoritative decremented, mirror did not).
  const run = freshRun();
  run.inventory = {
    torch: {
      itemId: "torch",
      name: "Pitch Torch",
      quantity: 2,
      usable: true,
      consumable: true,
      tags: [],
      flags: {},
      use: { effectType: "message", summary: "You spark the torch." }
    }
  };
  run.player.inventory = [{ id: "torch", name: "Pitch Torch", qty: 2 }];

  const result = resolveUseItemAction(run, { type: "use_item", itemId: "torch" });
  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.consumed, true);
  // Authoritative store decremented…
  assert.equal(result.run.inventory.torch.quantity, 1, "authoritative qty 2 → 1");
  // …and the player.inventory[] mirror the UI reads decremented in lockstep.
  const mirror = result.run.player.inventory.find((e) => e.id === "torch");
  assert.ok(mirror, "mirror entry still present");
  assert.equal(mirror.qty, 1, "mirror qty 2 → 1 (no phantom item on the sheet)");
});

test("use_item revive on a healthy player wastes nothing (no effect, not consumed)", () => {
  const run = freshRun();
  run.inventory = {
    revive_scroll: {
      itemId: "revive_scroll",
      name: "Scroll of Revivify",
      quantity: 1,
      usable: true,
      consumable: true,
      tags: [],
      flags: {},
      use: { effectType: "revive" }
    }
  };
  const result = resolveUseItemAction(run, { type: "use_item", itemId: "revive_scroll" });
  assert.equal(result.useItemResult.used, false);
  assert.equal(result.run, null, "no state change");
});

test("a capable present companion can revive; an exhausted one cannot", () => {
  const run = freshRun();
  run.npcs = {
    cleric: {
      npcId: "cleric",
      displayName: "Sister Vael",
      status: "active",
      currentLocationId: run.currentLocationId,
      capabilities: { revive: true },
      reviveCharges: 1
    }
  };
  assert.deepEqual(findRevivalMeans(run), { kind: "companion", npcId: "cleric" });
  run.npcs.cleric.reviveCharges = 0;
  assert.equal(findRevivalMeans(run), null);
});

// --- Dying-turn loop through the action dispatcher ---------------------------

test("dying player: an ordinary action spends the turn on a death save", () => {
  const run = freshRun();
  setHp(run, 0, 10);
  run.player.status = "dying";
  const resolved = resolveSoloAction(run, { type: "attempt", intent: "crawl toward the door" }, { fixedRoll: 5 });
  assert.equal(resolved.ok, true);
  assert.ok(resolved.deathSave, "a death save was rolled for the dying turn");
  assert.equal(resolved.run.player.deathSaves.failures, 1);
});

// --- Lethal everywhere (sandbox as deadly as campaign) ----------------------

test("lethality applies in sandbox mode, not just campaign", () => {
  const run = freshRun();
  run.mode = "sandbox";
  setHp(run, 0, 10);
  run.player.status = "dying";
  rollDeathSave(run, { fixedRoll: 1 }); // 2 fails
  rollDeathSave(run, { fixedRoll: 1 }); // → 3 fails (capped) → dead
  assert.equal(run.player.status, "dead");
  assert.equal(run.status, "dead");
});

// --- Consequence spine: XP / level ------------------------------------------

test("xp accrues and crosses a threshold to level up (with an HP bump)", () => {
  const run = freshRun();
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(300), 2);
  const before = run.player.resources.hitPoints.max;
  const rec = awardXp(run, 300);
  assert.equal(rec.leveledUp, true);
  assert.equal(run.player.level, 2);
  assert.equal(run.player.resources.hitPoints.max, before + 5, "leveling toughens the character");
});

test("the dead earn no xp", () => {
  const run = freshRun();
  markDead(run);
  assert.equal(awardXp(run, 1000), null);
});

test("a successful contested attempt awards xp through the dispatcher", () => {
  const run = freshRun();
  const before = run.player.xp;
  const resolved = resolveSoloAction(run, { type: "attempt", intent: "pick the heavy lock" }, {
    fixedRoll: 20,
    attemptProviderFn: () => ({
      summary: "You work the lock.",
      recommendedAbility: "dexterity",
      dc: 5,
      needsCheck: true,
      advantage: false,
      disadvantage: false,
      successNarration: "The lock clicks open.",
      failureNarration: "It holds.",
      proposedEffects: []
    })
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.run.player.xp > before, true, "xp moved on success");
});

// --- Consequence spine: search grants items ---------------------------------

test("a successful search that reveals an item grants it into inventory", () => {
  const run = freshRun();
  const loc = run.locations[run.currentLocationId];
  loc.searchDetails = [
    {
      detailId: "loose_board",
      label: "Loose floorboard",
      description: "A dagger is hidden beneath a loose board.",
      revealed: false,
      grantItem: { itemId: "rusty_dagger", name: "Rusty Dagger", qty: 1, usable: false }
    }
  ];
  const resolved = resolveSoloAction(run, { type: "search" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.searchResult.found, true);
  assert.ok(resolved.searchResult.grantedItem, "an item was granted");
  assert.equal(resolved.run.inventory.rusty_dagger.quantity, 1);
  const inArray = resolved.run.player.inventory.find((e) => e.id === "rusty_dagger");
  assert.ok(inArray, "granted item mirrored onto player.inventory array");
});

// --- Consequence spine: checks gate quests (and quests can be FAILED) --------

test("a check-gated quest stage advances only on a successful check", () => {
  const run = freshRun();
  const quest = { questId: "q", status: "active", stage: 0, stages: [{ objective: "Pick the vault", completion: { kind: "check" } }] };

  const onFail = advanceQuests({ ...run, quests: { q: { ...quest } } }, { attemptResult: { checkResult: { success: false } } });
  assert.equal(onFail.updated, false, "a failed check does not advance the quest");

  const onPass = advanceQuests({ ...run, quests: { q: { ...quest } } }, { attemptResult: { checkResult: { success: true } } });
  assert.equal(onPass.completed.length, 1, "a successful check completes the final stage");
});

test("a failable check-gated quest is LOST on a missed check", () => {
  const run = freshRun();
  run.quests = {
    q: { questId: "q", status: "active", stage: 0, stages: [{ objective: "Defuse it", completion: { kind: "check" }, failOnMiss: true }] }
  };
  const res = advanceQuests(run, { attemptResult: { checkResult: { success: false } } });
  assert.equal(res.failed.length, 1, "the quest failed");
  assert.equal(run.quests.q.status, "failed");
});
