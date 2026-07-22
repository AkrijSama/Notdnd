// PANTRY, NOT CENSUS (owner law, walk-2 Group E amend). The world holds every era/biome-
// plausible creature, rows or not. Narration describes them freely (no mint on describe);
// a MECHANICAL touch mints a lawful block on demand (nearest chassis + tier budget,
// deterministic, runtime-registered). Auditors flag CANON violations, never absence-of-row.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mintCreatureOnDemand, resolveOrMintCreatureBlock, speciesPlausibility, resolveStatBlock, isKnownStatBlock
} from "../server/campaign/bestiary.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { enterCombatFromAttackIntent } from "../server/solo/combat.js";

test("mint-on-demand: an unrowed creature gets a lawful block off the NEAREST chassis, deterministic", () => {
  const a = mintCreatureOnDemand({ species: "a wolverine", tier: 1, seed: "s1" });
  assert.equal(a.kind, "wildlife");
  assert.ok(a.maxHp > 0 && a.ac > 0 && a.attacks.length, "a lawful, combat-resolvable block");
  assert.ok(a.tags.includes("minted") && a.tags.includes("pantry"));
  assert.equal(mintCreatureOnDemand({ species: "a wolverine", tier: 1, seed: "s1" }).statBlockId, a.statBlockId, "deterministic on (species, seed)");
  // nearest-chassis keyword routing
  assert.equal(mintCreatureOnDemand({ species: "a great brown bear", seed: "x" }).baseAnimalId, "black_bear");
  assert.equal(mintCreatureOnDemand({ species: "a lynx", seed: "x" }).baseAnimalId, "mountain_lion");
  assert.equal(mintCreatureOnDemand({ species: "some unknown critter", seed: "x" }).baseAnimalId, "grey_wolf", "default chassis for the unmatched");
});

test("a MECHANICAL touch mints + registers; a plain describe does NOT (narration is free)", () => {
  const run = createDefaultSoloRun({ runId: "pantry" });
  run.currentLocationId = "loc_here";
  // an unrowed CREATURE the narration introduced — NO committed stat block yet
  const beast = { npcId: "npc_marmot", displayName: "a fat marmot", kind: "wildlife", currentLocationId: "loc_here", status: "present", species: "marmot" };
  run.npcs = { npc_marmot: beast };
  // describing it committed no row (the pantry doesn't census); it has no statBlockId
  assert.equal(beast.statBlockId, undefined, "no row from mere existence/narration");
  // the mechanical touch (resolve-or-mint) produces a lawful block AND registers it
  const block = resolveOrMintCreatureBlock(run, beast);
  assert.ok(block && block.attacks.length, "mechanical touch mints a lawful block");
  assert.ok(isKnownStatBlock(block.statBlockId), "the minted block is runtime-registered");
  assert.equal(beast.statBlockId, block.statBlockId, "the npc is stamped so future touches resolve the same block");
});

test("entering COMBAT with an unrowed creature produces a lawful minted block (no phantom refusal)", () => {
  const run = createDefaultSoloRun({ runId: "pantrycbt" });
  run.currentLocationId = "loc_here";
  run.npcs = { npc_boar: { npcId: "npc_boar", displayName: "a wild boar", kind: "wildlife", species: "boar", currentLocationId: "loc_here", status: "present" } };
  const entered = enterCombatFromAttackIntent(run, { targetNpcId: "npc_boar", intent: "attack the boar" });
  // The law under test: an unrowed PLAUSIBLE creature is NOT refused, and a LAWFUL block is
  // minted + stamped on the npc. NOTE (was flaky ~13%, now deterministic): the same call
  // resolves the player's opening strike (resolveCombatTurn, turn 1), so the one-turn fight
  // can already be OVER by the time this returns — the low-hp player can LOSE the opening
  // exchange to the boar (hp 12-16), which clears run.combat with outcome "lost". That is a
  // legitimate combat outcome, not a phantom refusal; the old test assumed combat always
  // persisted and null-deref'd run.combat.combatants. This test asserts the pantry law (mint,
  // no refusal), NOT who won the opening exchange — the combat-outcome axis is combat.js's.
  assert.equal(entered.ok, true, "combat with an unrowed plausible creature is NOT refused");
  const boar = entered.run.npcs.npc_boar;
  assert.ok(typeof boar.statBlockId === "string" && boar.statBlockId, "the mint stamped a statBlockId on the creature");
  const block = resolveStatBlock(boar.statBlockId);
  assert.ok(block && block.maxHp > 0, "the minted block resolves and is lawful (hp > 0) — no phantom refusal");
  if (entered.run.combat) {
    // Fight still live: the enemy combatant was built from the minted block.
    const combatant = Object.values(entered.run.combat.combatants).find((c) => c.kind === "enemy");
    assert.ok(combatant && combatant.hp.max > 0, "a lawful enemy combatant was built from the mint");
    assert.equal(combatant.statBlockId, boar.statBlockId, "the combatant carries the minted block");
  }
});

test("a PERSON with no block still falls to the civilian default (not a beast mint)", () => {
  const run = createDefaultSoloRun({ runId: "person" });
  const npc = { npcId: "npc_stranger", displayName: "a stranger", kind: "person", currentLocationId: run.currentLocationId };
  assert.equal(resolveOrMintCreatureBlock(run, npc), null, "a person is not a beast — no mint");
});

test("auditor flags CANON violations (implausible species), never absence-of-row", () => {
  // pantry default: any plausible creature is fine even with no row
  assert.equal(speciesPlausibility({}, "a marmot").plausible, true, "absence-of-row is NEVER a violation");
  assert.equal(speciesPlausibility({ plausibleFauna: ["deer", "wolf"] }, "a fox").plausible, true, "an OPEN hint doesn't gate");
  // a denylist / closed list / mundane-region flags the implausible
  assert.equal(speciesPlausibility({ implausibleFauna: ["penguin"] }, "a penguin waddles by").plausible, false);
  assert.equal(speciesPlausibility({ faunaClosed: true, plausibleFauna: ["deer", "wolf"] }, "a tiger").plausible, false, "closed list flags the unlisted");
  assert.equal(speciesPlausibility({ faunaMundane: true }, "a dragon").plausible, false, "a dragon is implausible for a mundane region");
});
