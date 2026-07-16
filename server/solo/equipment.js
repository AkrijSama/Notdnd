// EQUIP-SLOTS LAYER (equip-slots-v1) — mutation + read API.
//
// Scope fence (locked): this module owns the equip/unequip lifecycle and the read
// surface ONLY. It does NOT apply stat-mods, resolve item abilities, or enforce
// tiered stat budgets — those are separate rulebook work. Items may CARRY those
// fields (validated tolerantly by schema.validateInventoryItem); nothing here
// reads or applies them.
//
// Model: slots hold an itemId reference into run.inventory (the authoritative
// keyed store), never a copy — the server owns item truth in one place. Equipping
// does NOT remove the item from inventory; it only pins which carried item fills a
// slot. Reads resolve the reference against current inventory and treat a dangling
// or missing reference as an empty slot (defensive, resume-safe).
//
// Persistence: run.equipment rides in the run blob; saveSoloRun/getSoloRun round-
// trip it whole. No repository.js change.

import { EQUIP_SLOTS, EQUIP_SLOT_KIND_BY_SLOT, createDefaultEquipment } from "./schema.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ok(extra) {
  return { ok: true, ...extra };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// The accessory slots, in fill order, for auto-placing an accessory when no
// explicit slot is given.
const ACCESSORY_SLOTS = EQUIP_SLOTS.filter((slot) => EQUIP_SLOT_KIND_BY_SLOT[slot] === "accessory");

// Lazily normalize run.equipment to a full four-slot map. Migration-safe: a legacy
// run with no equipment (undefined) gains an all-empty map; a partial map is
// filled with nulls; unknown keys are dropped. Mutates and returns run.equipment.
export function ensureEquipment(run) {
  if (!isPlainObject(run)) {
    throw new Error("ensureEquipment: run must be an object");
  }
  const current = isPlainObject(run.equipment) ? run.equipment : {};
  const next = createDefaultEquipment();
  for (const slot of EQUIP_SLOTS) {
    const value = current[slot];
    next[slot] = isNonEmptyString(value) ? value : null;
  }
  run.equipment = next;
  return next;
}

function inventoryItem(run, itemId) {
  return isPlainObject(run?.inventory) && isPlainObject(run.inventory[itemId])
    ? run.inventory[itemId]
    : null;
}

// The slot KIND an item fits. Explicit item.slot wins; otherwise null (the item
// declares no slot and can only be equipped into an explicitly-named slot whose
// kind the caller vouches for — we still refuse if that would be ambiguous).
function itemSlotKind(item) {
  return isNonEmptyString(item?.slot) ? item.slot : null;
}

// Equip a carried item into a slot.
//   run     — the solo run (mutated in place)
//   itemId  — id of an item present in run.inventory
//   slot    — optional concrete slot (weapon|armor|accessory1|accessory2). When
//             omitted it is inferred from the item's declared slot kind; for an
//             accessory the first empty accessory slot is chosen.
// Returns { ok:true, slot, itemId, previous } or { ok:false, error:{ code, message } }.
// Typed error codes: item_not_found, no_slot, invalid_slot, slot_mismatch, slots_full.
export function equipItem(run, itemId, slot = null) {
  if (!isNonEmptyString(itemId)) {
    return fail("item_not_found", "An itemId is required to equip");
  }
  ensureEquipment(run);
  const item = inventoryItem(run, itemId);
  if (!item) {
    return fail("item_not_found", `No item "${itemId}" in inventory`);
  }
  const kind = itemSlotKind(item);

  let targetSlot = slot;
  if (targetSlot === null || targetSlot === undefined) {
    // Infer from the item's declared slot kind.
    if (!kind) {
      return fail("no_slot", `Item "${itemId}" declares no equip slot and none was given`);
    }
    if (kind === "accessory") {
      targetSlot = ACCESSORY_SLOTS.find((s) => run.equipment[s] === null) || null;
      if (!targetSlot) {
        return fail("slots_full", "Both accessory slots are occupied");
      }
    } else {
      targetSlot = kind; // weapon|armor map 1:1 to their slot name
    }
  } else {
    // Explicit slot: it must be a real slot, and if the item declares a kind it
    // must match that slot's kind (never silently equip a weapon into armor).
    if (!EQUIP_SLOT_KIND_BY_SLOT[targetSlot]) {
      return fail("invalid_slot", `Unknown equip slot "${targetSlot}"`);
    }
    if (kind && EQUIP_SLOT_KIND_BY_SLOT[targetSlot] !== kind) {
      return fail(
        "slot_mismatch",
        `Item "${itemId}" (${kind}) does not fit ${targetSlot} (${EQUIP_SLOT_KIND_BY_SLOT[targetSlot]})`
      );
    }
  }

  const previous = run.equipment[targetSlot] || null;
  run.equipment[targetSlot] = itemId;
  return ok({ slot: targetSlot, itemId, previous });
}

// Clear a slot. Returns { ok:true, slot, itemId } where itemId is what was
// unequipped (null if the slot was already empty), or an invalid_slot error.
export function unequipItem(run, slot) {
  ensureEquipment(run);
  if (!EQUIP_SLOT_KIND_BY_SLOT[slot]) {
    return fail("invalid_slot", `Unknown equip slot "${slot}"`);
  }
  const previous = run.equipment[slot] || null;
  run.equipment[slot] = null;
  return ok({ slot, itemId: previous });
}

// Read API: the equipment map with each slot resolved to its live inventory item
// object (or null). A reference to an item no longer in inventory resolves to null
// (dangling refs never surface as phantom gear). Does not mutate run.equipment's
// stored references — resolution is read-only.
export function getEquipment(run) {
  const map = ensureEquipment(run);
  const resolved = {};
  for (const slot of EQUIP_SLOTS) {
    const itemId = map[slot];
    resolved[slot] = itemId ? inventoryItem(run, itemId) : null;
  }
  return resolved;
}

// Read API: the equipped items as an array, in slot order, skipping empty and
// dangling slots. This is the committed-truth list the tailor renders — every
// entry is a real object from run.inventory, so the tailor never invents gear.
export function getEquippedItems(run) {
  const map = ensureEquipment(run);
  const items = [];
  for (const slot of EQUIP_SLOTS) {
    const itemId = map[slot];
    if (!itemId) continue;
    const item = inventoryItem(run, itemId);
    if (item) items.push({ slot, ...item });
  }
  return items;
}
