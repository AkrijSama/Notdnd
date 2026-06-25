import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

const baseChar = {
  step: 1,
  name: "",
  race: "",
  characterClass: "",
  background: "",
  abilityMethod: "standard_array",
  baseAbilityScores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 }
};

function wizard(charPatch) {
  return renderOnboardingFlow({ step: "character", character: { ...baseChar, ...charPatch } });
}

test("step 1 (Identity) renders name/pronouns/portrait + progress", () => {
  const html = wizard({ step: 1 });
  assert.match(html, /Create Your Character/);
  assert.match(html, /1\. Identity/);
  assert.match(html, /data-cw-input="name"/);
  assert.match(html, /data-cw-input="pronouns"/);
  assert.match(html, /data-cw-portraitmode="generate"/);
  assert.match(html, /data-cw-next/);
});

test("step 2 (Race) renders all races as selectable cards", () => {
  const html = wizard({ step: 2, race: "Dwarf" });
  assert.match(html, /data-cw-race="Dwarf"/);
  assert.match(html, /data-cw-race="Tiefling"/);
  assert.match(html, /class="cw-card active" data-cw-race="Dwarf"/);
  assert.match(html, /data-cw-back/);
});

test("step 3 (Class) and step 4 (Background) render their options", () => {
  assert.match(wizard({ step: 3 }), /data-cw-class="Fighter"/);
  assert.match(wizard({ step: 3 }), /data-cw-class="Wizard"/);
  assert.match(wizard({ step: 4 }), /data-cw-background="Soldier"/);
});

test("step 5 (Abilities) shows method tabs + live derived stats", () => {
  const sa = wizard({ step: 5, race: "Dwarf", characterClass: "Fighter" });
  assert.match(sa, /data-cw-method="standard_array"/);
  assert.match(sa, /data-cw-method="point_buy"/);
  assert.match(sa, /data-cw-method="roll"/);
  assert.match(sa, /data-cw-assign="strength"/);
  // Dwarf Fighter, CON 13 + 2 = 15 (+2) -> HP 10 + 2 = 12
  assert.match(sa, /<b>HP<\/b> 12/);
  assert.match(sa, /<b>Speed<\/b> 25/); // Dwarf

  const pb = wizard({ step: 5, abilityMethod: "point_buy", baseAbilityScores: { strength: 8, dexterity: 8, constitution: 8, intelligence: 8, wisdom: 8, charisma: 8 } });
  assert.match(pb, /Points remaining/);
  assert.match(pb, /data-cw-pb="strength:inc"/);
});

test("step 6 (Review) renders the resolved sheet + Enter button", () => {
  const html = wizard({
    step: 6,
    name: "Brunn",
    race: "Dwarf",
    characterClass: "Fighter",
    background: "Soldier"
  });
  assert.match(html, /Brunn/);
  assert.match(html, /Dwarf · Fighter · Soldier/);
  assert.match(html, /Second Wind/); // class feature
  assert.match(html, /Darkvision/); // racial trait
  assert.match(html, /Chain mail/); // starting equipment
  assert.match(html, /data-cw-enter/);
});
