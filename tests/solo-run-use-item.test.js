import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  getUsableInventoryItems,
  resolveUseItemAction,
  validateUseItemAction
} from "../server/solo/useItem.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function useAction(overrides = {}) {
  return {
    type: "use_item",
    actorId: "player",
    itemId: "field_ration",
    targetEntityId: null,
    targetLocationId: null,
    ...overrides
  };
}

function addNoteItem(run, overrides = {}) {
  run.inventory.plain_note = {
    itemId: "plain_note",
    templateId: "placeholder_plain_note",
    name: "Plain Note",
    description: "A neutral placeholder note.",
    quantity: 1,
    usable: true,
    consumable: false,
    use: {
      effectType: "reveal_note",
      label: "Read note",
      summary: "You read the plain note.",
      resource: null,
      amount: 0,
      note: "The note contains a simple reminder to stay aware of the surroundings.",
      requiresTarget: false
    },
    tags: ["placeholder"],
    flags: {},
    imageAssetId: null,
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    ...overrides
  };
}

function addMessageItem(run) {
  run.inventory.smooth_stone = {
    itemId: "smooth_stone",
    name: "Smooth Stone",
    description: "A neutral placeholder object.",
    quantity: 1,
    usable: true,
    consumable: false,
    use: {
      effectType: "message",
      label: "Hold stone",
      summary: "The smooth stone feels ordinary.",
      resource: null,
      amount: 0,
      note: null,
      requiresTarget: false
    },
    tags: ["placeholder"],
    flags: {},
    imageAssetId: null,
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: []
  };
}

test("validates use_item action", () => {
  const run = createDefaultSoloRun({ runId: "run_use_validate" });

  const result = validateUseItemAction(run, useAction());

  assert.equal(result.ok, true);
});

test("rejects missing item", () => {
  const run = createDefaultSoloRun({ runId: "run_use_missing" });

  const result = validateUseItemAction(run, useAction({ itemId: "missing_item" }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "action.itemId"));
});

test("rejects non-usable item", () => {
  const run = createDefaultSoloRun({ runId: "run_use_nonusable" });
  run.inventory.field_ration.usable = false;

  const result = validateUseItemAction(run, useAction());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.message === "Item is not usable"));
});

test("rejects quantity 0 item", () => {
  const run = createDefaultSoloRun({ runId: "run_use_empty" });
  run.inventory.field_ration.quantity = 0;

  const result = validateUseItemAction(run, useAction());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.message === "Item quantity must be greater than zero"));
});

test("message effect returns summary and creates timeline event", () => {
  const run = createDefaultSoloRun({ runId: "run_use_message" });
  addMessageItem(run);

  const result = resolveUseItemAction(run, useAction({ itemId: "smooth_stone" }), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.effectType, "message");
  assert.equal(result.useItemResult.summary, "The smooth stone feels ordinary.");
  assert.equal(result.event.type, "use_item");
  assert.equal(result.memoryFact, null);
});

test("recover_resource effect recovers stamina", () => {
  const run = createDefaultSoloRun({ runId: "run_use_recover" });
  run.player.resources.stamina.current = 3;

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.used, true);
  assert.equal(result.run.player.resources.stamina.current, 4);
  assert.deepEqual(result.useItemResult.resourcesRecovered[0], {
    resourceId: "stamina",
    before: 3,
    after: 4,
    amount: 1
  });
});

test("recover_resource does not exceed max", () => {
  const run = createDefaultSoloRun({ runId: "run_use_recover_max" });
  run.player.resources.stamina.current = 6;

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.run.player.resources.stamina.current, 6);
  assert.deepEqual(result.useItemResult.resourcesRecovered, []);
});

test("consumable item decrements quantity", () => {
  const run = createDefaultSoloRun({ runId: "run_use_consumes" });

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.consumed, true);
  assert.equal(result.useItemResult.quantityRemaining, 0);
  assert.equal(result.run.inventory.field_ration.quantity, 0);
});

test("reveal_note returns note", () => {
  const run = createDefaultSoloRun({ runId: "run_use_note" });
  addNoteItem(run);

  const result = resolveUseItemAction(run, useAction({ itemId: "plain_note" }), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.effectType, "reveal_note");
  assert.match(result.useItemResult.revealedNote, /simple reminder/);
});

test("reveal_note creates memory fact only once", () => {
  const run = createDefaultSoloRun({ runId: "run_use_note_once" });
  addNoteItem(run);
  const first = resolveUseItemAction(run, useAction({ itemId: "plain_note" }), { now: TEST_NOW, idFactory: idFactory() });

  const second = resolveUseItemAction(first.run, useAction({ itemId: "plain_note" }), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.memoryFact.type, "item_note_revealed");
  assert.equal(second.memoryFact, null);
  assert.equal(second.run.memoryFacts.filter((fact) => fact.type === "item_note_revealed").length, 1);
});

test("blocked-tag item cannot be used in mainline", () => {
  const run = createDefaultSoloRun({ runId: "run_use_blocked" });
  run.inventory.field_ration.contentTags = ["explicit_sexual_content"];

  const before = clone(run);
  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.run, null);
  assert.equal(result.useItemResult.used, false);
  assert.deepEqual(result.useItemResult.warningCodes, ["ITEM_BLOCKED_BY_POLICY"]);
  assert.deepEqual(run, before);
});

test("forbidden lane can use allowed forbidden-lane item", () => {
  const run = createDefaultSoloRun({ runId: "run_use_forbidden" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.inventory.field_ration.edition = "forbidden";
  run.inventory.field_ration.policyProfileId = "forbidden_default";
  run.inventory.field_ration.contentTags = ["adult_themes"];

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.useItemResult.used, true);
  assert.equal(result.run.inventory.field_ration.quantity, 0);
});

test("validates final run", () => {
  const run = createDefaultSoloRun({ runId: "run_use_final_valid" });

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(validateSoloRun(result.run).ok, true);
});

test("does not call GM/provider", () => {
  const run = createDefaultSoloRun({ runId: "run_use_no_provider" });
  const result = resolveUseItemAction(run, useAction(), {
    now: TEST_NOW,
    idFactory: idFactory(),
    provider: () => {
      throw new Error("provider should not be called");
    }
  });

  assert.equal(result.ok, true);
});

test("does not invent entities/items/exits", () => {
  const run = createDefaultSoloRun({ runId: "run_use_no_invent" });
  const beforeEntityIds = Object.keys(run.npcs).join(",");
  const beforeLocationIds = Object.keys(run.locations).join(",");
  const beforeItemIds = Object.keys(run.inventory).join(",");

  const result = resolveUseItemAction(run, useAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.run.npcs).join(","), beforeEntityIds);
  assert.equal(Object.keys(result.run.locations).join(","), beforeLocationIds);
  assert.equal(Object.keys(result.run.inventory).join(","), beforeItemIds);
});

test("getUsableInventoryItems filters policy-blocked items", () => {
  const run = createDefaultSoloRun({ runId: "run_use_available_policy" });
  run.inventory.field_ration.contentTags = ["explicit_sexual_content"];

  const items = getUsableInventoryItems(run);

  assert.deepEqual(items, []);
});
