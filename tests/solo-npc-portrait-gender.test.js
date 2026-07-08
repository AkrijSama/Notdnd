import assert from "node:assert/strict";
import test from "node:test";

process.env.NOTDND_MOCK_IMAGE = "true";
const { npcGroundingClause } = await import("../server/solo/imageWorker.js");

// #50: the NPC portrait prompt is grounded in the committed gender/description so
// "Mara (female)" renders a woman, not the base model's default.

test("committed gender female → 'a woman' + description", () => {
  assert.equal(
    npcGroundingClause({ gender: "female", description: "a scarred mercenary in road leathers" }),
    "a woman, a scarred mercenary in road leathers"
  );
});

test("committed gender male → 'a man'", () => {
  assert.match(npcGroundingClause({ gender: "male" }), /^a man$/);
});

test("falls back to pronouns when gender is absent", () => {
  assert.match(npcGroundingClause({ pronouns: "she/her" }), /^a woman/);
  assert.match(npcGroundingClause({ pronouns: "he/him" }), /^a man/);
  assert.match(npcGroundingClause({ pronouns: "they/them" }), /androgynous/);
});

test("uses appearance when description is absent", () => {
  assert.equal(npcGroundingClause({ gender: "female", appearance: "tall, silver-haired" }), "a woman, tall, silver-haired");
});

test("empty when the entity carries nothing to ground", () => {
  assert.equal(npcGroundingClause({}), "");
  assert.equal(npcGroundingClause(null), "");
  assert.equal(npcGroundingClause({ role: "barkeep" }), "");
});
