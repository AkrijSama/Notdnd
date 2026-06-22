import assert from "node:assert/strict";
import test from "node:test";
import { parseTriggers } from "../server/gm/triggerParser.js";

function firstTrigger(text) {
  const parsed = parseTriggers(text);
  assert.ok(parsed.triggers.length > 0, "expected at least one trigger");
  return parsed.triggers[0];
}

test("parse clean CHECK trigger", () => {
  const parsed = parseTriggers("You push the door. [CHECK: Strength DC 14]");
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.triggers[0].type, "CHECK");
  assert.deepEqual(parsed.triggers[0].parsed, {
    ability: "Strength",
    dc: 14,
    subtype: "check"
  });
  assert.equal(parsed.narrative, "You push the door.");
});

test("parse INITIATIVE embedded in prose", () => {
  const parsed = parseTriggers("The bandits draw steel [INITIATIVE] and fan out.");
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.triggers[0].type, "INITIATIVE");
  assert.equal(parsed.narrative, "The bandits draw steel and fan out.");
});

test("parse multiple mixed triggers in one response", () => {
  const parsed = parseTriggers(
    "You lunge. [CHECK: DEX DC 12] The ogre counters [DAMAGE: 2d6+3 bludgeoning] [NEW_ENTITY: name=Garrick type=npc]"
  );
  assert.equal(parsed.triggers.length, 3);
  assert.deepEqual(parsed.triggers.map((entry) => entry.type), ["CHECK", "DAMAGE", "NEW_ENTITY"]);
});

test("pure narrative produces no triggers", () => {
  const source = "Rain taps the shutters while Mira studies your expression.";
  const parsed = parseTriggers(source);
  assert.equal(parsed.triggers.length, 0);
  assert.equal(parsed.narrative, source);
});

test("lenient parsing supports missing colon in CHECK", () => {
  const trigger = firstTrigger("The chest resists. [CHECK Strength DC14]");
  assert.equal(trigger.type, "CHECK");
  assert.equal(trigger.parsed.ability, "Strength");
  assert.equal(trigger.parsed.dc, 14);
});

test("variant trigger SKILL CHECK is parsed", () => {
  const trigger = firstTrigger("You dart forward. [SKILL CHECK: Dexterity DC 12]");
  assert.equal(trigger.type, "CHECK");
  assert.equal(trigger.parsed.subtype, "check");
  assert.equal(trigger.parsed.ability, "Dexterity");
  assert.equal(trigger.parsed.dc, 12);
});

test("variant trigger ABILITY CHECK is parsed", () => {
  const trigger = firstTrigger("[ABILITY CHECK: INT DC 15]");
  assert.equal(trigger.type, "CHECK");
  assert.equal(trigger.parsed.ability, "Intelligence");
  assert.equal(trigger.parsed.dc, 15);
});

test("variant trigger SAVE maps subtype save", () => {
  const trigger = firstTrigger("[SAVE: CON DC 16]");
  assert.equal(trigger.type, "CHECK");
  assert.equal(trigger.parsed.subtype, "save");
  assert.equal(trigger.parsed.ability, "Constitution");
});

test("variant trigger SAVING THROW maps subtype save", () => {
  const trigger = firstTrigger("[SAVING THROW: Wisdom DC 11]");
  assert.equal(trigger.type, "CHECK");
  assert.equal(trigger.parsed.subtype, "save");
  assert.equal(trigger.parsed.ability, "Wisdom");
});

test("variant trigger ROLL INITIATIVE is parsed", () => {
  const trigger = firstTrigger("[ROLL INITIATIVE]");
  assert.equal(trigger.type, "INITIATIVE");
});

test("variant trigger TREASURE tier is normalized", () => {
  const trigger = firstTrigger("[TREASURE: rare items]");
  assert.equal(trigger.type, "LOOT");
  assert.equal(trigger.parsed.tier, "rare");
});

test("CHECK DC values are clamped low", () => {
  const trigger = firstTrigger("[CHECK: Strength DC 0]");
  assert.equal(trigger.parsed.dc, 1);
});

test("CHECK DC values are clamped high", () => {
  const trigger = firstTrigger("[CHECK: Strength DC 35]");
  assert.equal(trigger.parsed.dc, 30);
});

test("DAMAGE trigger parses dice and type", () => {
  const trigger = firstTrigger("[DAMAGE: 1d8+3 slashing]");
  assert.equal(trigger.type, "DAMAGE");
  assert.equal(trigger.parsed.dice, "1d8+3");
  assert.equal(trigger.parsed.damageType, "slashing");
});

test("ATTACK variant is treated as DAMAGE", () => {
  const trigger = firstTrigger("[ATTACK: 2d6+1 fire]");
  assert.equal(trigger.type, "DAMAGE");
  assert.equal(trigger.parsed.dice, "2d6+1");
  assert.equal(trigger.parsed.damageType, "fire");
});

test("DAMAGE without type keeps damageType null", () => {
  const trigger = firstTrigger("[DAMAGE: 1d10]");
  assert.equal(trigger.type, "DAMAGE");
  assert.equal(trigger.parsed.dice, "1d10");
  assert.equal(trigger.parsed.damageType, null);
});

test("invalid dice notation falls back to UNKNOWN", () => {
  const trigger = firstTrigger("[DAMAGE: potato fire]");
  assert.equal(trigger.type, "UNKNOWN");
});

test("NEW_ENTITY parses with single-quoted values", () => {
  const trigger = firstTrigger("[NEW_ENTITY: name=Mira type=npc]");
  assert.equal(trigger.type, "NEW_ENTITY");
  assert.deepEqual(trigger.parsed, { name: "Mira", entityType: "npc" });
});

test("NEW_ENTITY parses with unquoted values and spaces", () => {
  const trigger = firstTrigger("[NEW_ENTITY : name = Garrick Stone type = faction]");
  assert.equal(trigger.type, "NEW_ENTITY");
  assert.equal(trigger.parsed.name, "Garrick Stone");
  assert.equal(trigger.parsed.entityType, "faction");
});

test("UPDATE_ENTITY parses unquoted facts", () => {
  const trigger = firstTrigger("[UPDATE_ENTITY: name=Mira facts=Now suspicious of the party]");
  assert.equal(trigger.type, "UPDATE_ENTITY");
  assert.equal(trigger.parsed.name, "Mira");
  assert.equal(trigger.parsed.facts, "Now suspicious of the party");
});

test("unknown entity type falls back to UNKNOWN", () => {
  const trigger = firstTrigger("[NEW_ENTITY: name=Tower type=planet]");
  assert.equal(trigger.type, "UNKNOWN");
});

test("extra whitespace tabs and CRLF are tolerated", () => {
  const parsed = parseTriggers("First line\r\n\t[CHECK:\tCHA\tDC\t13]\r\nSecond line");
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.triggers[0].type, "CHECK");
  assert.equal(parsed.triggers[0].parsed.ability, "Charisma");
  assert.equal(parsed.triggers[0].parsed.dc, 13);
});

test("completely malformed trigger-like text becomes UNKNOWN", () => {
  const trigger = firstTrigger("[UPDATE_ENTITY nonsense gibberish]");
  assert.equal(trigger.type, "UNKNOWN");
});

test("trigger order is preserved", () => {
  const parsed = parseTriggers("[CHECK: STR DC 12] text [DAMAGE: 1d6] text [LOOT: standard]");
  assert.deepEqual(parsed.triggers.map((entry) => entry.type), ["CHECK", "DAMAGE", "LOOT"]);
});

test("narrative cleanup removes trigger tags and extra blank lines", () => {
  const parsed = parseTriggers("Line one\n\n[INITIATIVE]\n\nLine two");
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.narrative, "Line one\n\nLine two");
});
