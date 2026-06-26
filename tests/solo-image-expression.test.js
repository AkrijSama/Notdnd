import assert from "node:assert/strict";
import test from "node:test";
import { mapToneToExpression } from "../server/solo/talk.js";
import { collectNpcsNeedingArt } from "../server/solo/scene.js";
import {
  NPC_EXPRESSIONS,
  createEmptyExpressionVariants,
  validateNpc
} from "../server/solo/schema.js";

function baseNpc(overrides = {}) {
  return {
    npcId: "tavern_keeper",
    displayName: "Tavern Keeper",
    role: "Tavern Keeper",
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {},
    ...overrides
  };
}

test("mapToneToExpression maps each non-neutral tone deterministically", () => {
  assert.equal(mapToneToExpression("warm", ""), "warm");
  assert.equal(mapToneToExpression("tense", ""), "suspicious");
  assert.equal(mapToneToExpression("dangerous", ""), "fearful");
  assert.equal(mapToneToExpression("dramatic", ""), "surprised");
  assert.equal(mapToneToExpression("comic", ""), "warm");
  assert.equal(mapToneToExpression("mysterious", ""), "suspicious");
});

test("mapToneToExpression falls back to sentiment for neutral tone", () => {
  assert.equal(mapToneToExpression("neutral", "You saved my friend, I am grateful."), "warm");
  assert.equal(mapToneToExpression("neutral", "I hate you, you betray everyone."), "suspicious");
  assert.equal(mapToneToExpression("neutral", "The rain falls on the road."), "neutral");
});

test("mapToneToExpression treats unknown tone as neutral and uses sentiment", () => {
  assert.equal(mapToneToExpression("bogus", "a trusted friend"), "warm");
  assert.equal(mapToneToExpression(undefined, "plain words"), "neutral");
});

test("createEmptyExpressionVariants returns all six keys null", () => {
  const variants = createEmptyExpressionVariants();
  assert.deepEqual(Object.keys(variants).sort(), [...NPC_EXPRESSIONS].sort());
  for (const expression of NPC_EXPRESSIONS) {
    assert.equal(variants[expression], null);
  }
});

test("validateNpc accepts npc without expressionVariants (backward compatible)", () => {
  assert.equal(validateNpc(baseNpc()).ok, true);
});

test("validateNpc accepts valid expressionVariants (asset id or null)", () => {
  const npc = baseNpc({
    expressionVariants: { ...createEmptyExpressionVariants(), warm: "img_tavern_keeper_warm" }
  });
  assert.equal(validateNpc(npc).ok, true);
});

test("validateNpc rejects unknown expression keys", () => {
  const result = validateNpc(baseNpc({ expressionVariants: { ecstatic: "img_x" } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "expressionVariants.ecstatic"));
});

test("validateNpc rejects non-string non-null variant values", () => {
  const result = validateNpc(baseNpc({ expressionVariants: { warm: 12 } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "expressionVariants.warm"));
});

test("collectNpcsNeedingArt flags npcs with missing or ungenerated art", () => {
  const run = {
    npcs: { tavern_keeper: baseNpc() },
    imageAssets: {}
  };
  const visible = [{ entityType: "npc", entityId: "npc:tavern_keeper" }];
  assert.deepEqual(collectNpcsNeedingArt(run, visible), ["tavern_keeper"]);
});

test("collectNpcsNeedingArt skips npcs whose base and all variants are generated", () => {
  const variants = {};
  const imageAssets = {
    img_tavern_keeper_base: { assetId: "img_tavern_keeper_base", status: "generated", uri: "/data/assets/r/tavern_keeper/base.png" }
  };
  for (const expression of NPC_EXPRESSIONS) {
    const assetId = `img_tavern_keeper_${expression}`;
    variants[expression] = assetId;
    imageAssets[assetId] = { assetId, status: "generated", uri: `/data/assets/r/tavern_keeper/${expression}.png` };
  }
  const run = {
    npcs: { tavern_keeper: baseNpc({ imageAssetId: "img_tavern_keeper_base", expressionVariants: variants }) },
    imageAssets
  };
  const visible = [{ entityType: "npc", entityId: "npc:tavern_keeper" }];
  assert.deepEqual(collectNpcsNeedingArt(run, visible), []);
});
