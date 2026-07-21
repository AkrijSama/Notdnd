// R2 — VISIBLE COSTS (walk-2, sharpened by F2). A failed check's committed cost is stated
// in the roll banner from COMMITTED state (damage record / consequence), never narration.
// No committed cost may be invisible.
import test from "node:test";
import assert from "node:assert/strict";
import { consequenceCostLine } from "../src/components/soloSceneShell.js";

test("HP delta from a committed damage record surfaces as a vitality cost", () => {
  assert.equal(consequenceCostLine({ damage: { hpBefore: 9, hpAfter: 7, amount: 2 } }), "cost: −2 vitality");
  assert.equal(consequenceCostLine({ consequence: { type: "damage", hpBefore: 5, hpAfter: 0 } }), "cost: −5 vitality");
  assert.equal(consequenceCostLine({ damage: { amount: 3 } }), "cost: −3 vitality");
});

test("resource / condition costs surface from committed consequence", () => {
  assert.equal(consequenceCostLine({ consequence: { type: "resource", resource: "stamina", amount: 2 } }), "cost: −2 stamina");
  assert.equal(consequenceCostLine({ consequence: { type: "condition", condition: "bleeding" } }), "cost: now bleeding");
});

test("no committed cost = no cost tag (a clean or free failure)", () => {
  assert.equal(consequenceCostLine({}), "");
  assert.equal(consequenceCostLine({ consequence: { type: "none" } }), "");
  assert.equal(consequenceCostLine({ damage: null, consequence: null }), "");
  // healing/no-loss never reads as a cost
  assert.equal(consequenceCostLine({ damage: { hpBefore: 5, hpAfter: 5, amount: 0 } }), "");
});
