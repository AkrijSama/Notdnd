import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun, validateEquipment } from "../server/solo/schema.js";
import {
  ensureEquipment,
  equipItem,
  unequipItem,
  getEquipment,
  getEquippedItems
} from "../server/solo/equipment.js";

// A run with a couple of carried, slot-declaring items in the keyed inventory.
function runWithItems(runId = "run_equip") {
  const run = createDefaultSoloRun({ runId });
  run.inventory.iron_sword = {
    itemId: "iron_sword",
    name: "Iron Sword",
    description: "A plain soldier's blade.",
    visual: "a plain iron longsword at the hip",
    slot: "weapon",
    quantity: 1,
    tags: [],
    flags: {},
    // Rulebook fields ride along as tolerated extras; this layer never applies them.
    statMods: { str: 1 },
    ability: { id: "cleave" }
  };
  run.inventory.leather_armor = {
    itemId: "leather_armor",
    name: "Leather Armor",
    slot: "armor",
    quantity: 1,
    tags: [],
    flags: {}
  };
  run.inventory.silver_ring = {
    itemId: "silver_ring",
    name: "Silver Ring",
    slot: "accessory",
    quantity: 1,
    tags: [],
    flags: {}
  };
  run.inventory.jade_amulet = {
    itemId: "jade_amulet",
    name: "Jade Amulet",
    slot: "accessory",
    quantity: 1,
    tags: [],
    flags: {}
  };
  return run;
}

test("new mint carries an all-empty equipment map and validates", () => {
  const run = createDefaultSoloRun({ runId: "run_equip_default" });
  assert.deepEqual(run.equipment, { weapon: null, armor: null, accessory1: null, accessory2: null });
  assert.equal(validateSoloRun(run).ok, true);
});

test("legacy save (no equipment field) loads clean with empty slots — resume-safe", () => {
  const run = createDefaultSoloRun({ runId: "run_legacy" });
  delete run.equipment; // legacy blob predates the equip-slots layer
  assert.equal(validateSoloRun(run).ok, true, "legacy run without equipment still validates");

  // Lazy migration fills empty slots with zero behavior change.
  const eq = ensureEquipment(run);
  assert.deepEqual(eq, { weapon: null, armor: null, accessory1: null, accessory2: null });
  assert.equal(validateSoloRun(run).ok, true);
});

test("a partial/legacy-shaped equipment map is floored, not rejected", () => {
  const run = createDefaultSoloRun({ runId: "run_partial" });
  run.equipment = { weapon: "iron_sword" }; // only one slot present
  const eq = ensureEquipment(run);
  assert.deepEqual(eq, { weapon: "iron_sword", armor: null, accessory1: null, accessory2: null });
});

test("equip infers the slot from the item's declared kind", () => {
  const run = runWithItems();
  assert.deepEqual(equipItem(run, "iron_sword"), { ok: true, slot: "weapon", itemId: "iron_sword", previous: null });
  assert.deepEqual(equipItem(run, "leather_armor"), { ok: true, slot: "armor", itemId: "leather_armor", previous: null });
  assert.equal(run.equipment.weapon, "iron_sword");
  assert.equal(run.equipment.armor, "leather_armor");
});

test("two accessories auto-fill both accessory slots, then the third reports slots_full", () => {
  const run = runWithItems();
  assert.equal(equipItem(run, "silver_ring").slot, "accessory1");
  assert.equal(equipItem(run, "jade_amulet").slot, "accessory2");
  run.inventory.copper_band = { itemId: "copper_band", name: "Copper Band", slot: "accessory", quantity: 1, tags: [], flags: {} };
  const third = equipItem(run, "copper_band");
  assert.equal(third.ok, false);
  assert.equal(third.error.code, "slots_full");
});

test("equip rejects a slot/kind mismatch and an unknown item", () => {
  const run = runWithItems();
  const mismatch = equipItem(run, "iron_sword", "armor");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "slot_mismatch");
  const missing = equipItem(run, "ghost_item");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "item_not_found");
});

test("equip/unequip round-trips and survives a persist (serialize) cycle", () => {
  const run = runWithItems();
  equipItem(run, "iron_sword");
  equipItem(run, "silver_ring");

  // Simulate saveSoloRun/getSoloRun's deepClone: the whole run blob round-trips.
  const persisted = JSON.parse(JSON.stringify(run));
  assert.equal(validateSoloRun(persisted).ok, true);
  assert.equal(persisted.equipment.weapon, "iron_sword");
  assert.equal(persisted.equipment.accessory1, "silver_ring");

  const un = unequipItem(persisted, "weapon");
  assert.deepEqual(un, { ok: true, slot: "weapon", itemId: "iron_sword" });
  assert.equal(persisted.equipment.weapon, null);
  assert.equal(unequipItem(persisted, "weapon").itemId, null, "unequipping an empty slot yields null");
});

test("getEquipment resolves slots to live items; getEquippedItems lists equipped-only", () => {
  const run = runWithItems();
  equipItem(run, "iron_sword");
  equipItem(run, "jade_amulet");

  const map = getEquipment(run);
  assert.equal(map.weapon.itemId, "iron_sword");
  assert.equal(map.armor, null);
  assert.equal(map.accessory1.itemId, "jade_amulet");

  const list = getEquippedItems(run);
  assert.deepEqual(list.map((i) => i.itemId), ["iron_sword", "jade_amulet"]);
  // Carried-but-unequipped items (leather_armor, silver_ring) never appear.
  assert.equal(list.some((i) => i.itemId === "leather_armor"), false);
});

test("a dangling equip reference (item removed from inventory) resolves to empty, not phantom gear", () => {
  const run = runWithItems();
  equipItem(run, "iron_sword");
  delete run.inventory.iron_sword; // consumed/removed while equipped
  assert.equal(getEquipment(run).weapon, null);
  assert.deepEqual(getEquippedItems(run), []);
});

test("validateEquipment rejects unknown slots and non-string references", () => {
  assert.equal(validateEquipment({ weapon: null, armor: "x", accessory1: null, accessory2: null }).ok, true);
  assert.equal(validateEquipment({ bogus: "x" }).ok, false);
  assert.equal(validateEquipment({ weapon: 7 }).ok, false);
});
