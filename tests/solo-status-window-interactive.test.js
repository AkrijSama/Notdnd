import assert from "node:assert/strict";
import test from "node:test";
import {
  characterFromScenePlayer,
  renderBabelStatusWindow,
  renderSoloCharacterSidebar,
  renderSoloSceneShell
} from "../src/components/soloSceneShell.js";

// #5 — the STATUS WINDOW must be interactable, not inert: skills expand to say
// what they are (they define RANK), inventory items expand to their description
// and expose Use where the server marks them usable.

// The STATUS WINDOW renders because the WORLD declares a diegetic sheet (world.sheetSpec),
// not because it is named "babel" (JOB 2.2). A minimal Babel-family sheet is enough to open it.
function babelWorld() {
  return { variant: "babel", sheetSpec: { family: "babel", showRank: true, showRankedSkills: true } };
}

function babelPlayer(extra = {}) {
  return {
    displayName: "Rell",
    abilities: { strength: 10, dexterity: 12, constitution: 11, intelligence: 10, wisdom: 11, charisma: 10 },
    resources: { hp: { current: 9, max: 11 }, mp: { current: 0, max: 0 } },
    rank: "E",
    rankedSkillCount: 1,
    babelStats: [
      { label: "STR", ability: "strength", score: 10 },
      { label: "DEX", ability: "dexterity", score: 12 },
      { label: "VIT", ability: "constitution", score: 11 },
      { label: "Spirit", ability: "wisdom", score: 11 },
      { label: "INT", ability: "intelligence", score: 10 },
      { label: "Luck", ability: "charisma", score: 10 }
    ],
    babelSkills: [
      { id: "skill_static_read", name: "Read the Static", rank: "E", stat: "spirit", effect: "Sense the Green Static's pull before it moves.", source: null, acquiredAtMilestone: 1 }
    ],
    inventory: [
      { id: "item_tonic", name: "Field tonic", qty: 2, description: "Bitter herbs in oil. Steadies the hands.", usable: true, consumable: true },
      { id: "item_ribbon", name: "License ribbon", qty: 1, description: "Proof of passage in Hollow Pine.", usable: false }
    ],
    conditions: [],
    skills: { perception: 2, stealth: 1 }
  };
}

test("WINDOW skills are a named, inspectable list (not a bare count)", () => {
  const character = characterFromScenePlayer(babelPlayer(), babelWorld());
  const html = renderBabelStatusWindow(character);
  assert.match(html, /Read the Static/, "the held skill is NAMED in the WINDOW");
  assert.match(html, /<details class="solo-skill-detail">/, "skill row expands");
  assert.match(html, /Sense the Green Static/, "expanding reads what the skill DOES");
  assert.match(html, /\[ E \]/, "the skill's rank (what defines RANK) is shown");
  assert.match(html, /Keyed to SPIRIT/, "stat provenance shown");
});

test("WINDOW inventory items are interactable: expandable description + Use when usable", () => {
  const character = characterFromScenePlayer(babelPlayer(), babelWorld());
  const html = renderBabelStatusWindow(character);
  assert.match(html, /<details class="solo-inv-detail">/, "inventory rows expand");
  assert.match(html, /Bitter herbs in oil/, "item description readable in place");
  assert.match(html, /data-solo-action="use_item" data-item-id="item_tonic"/, "usable item exposes Use (same wire as the Inventory tab)");
  assert.ok(!html.includes('data-item-id="item_ribbon"'), "non-usable item gets no Use button");
});

test("WINDOW empty skills state teaches the loop instead of a bare 'none'", () => {
  const player = babelPlayer({});
  player.babelSkills = [];
  player.rankedSkillCount = 0;
  const character = characterFromScenePlayer(player, babelWorld());
  const html = renderBabelStatusWindow(character);
  assert.match(html, /skills are earned in play, and they define your RANK/i);
});

test("rankedSkillCount actually flows into the WINDOW count (was read but never wired)", () => {
  const character = characterFromScenePlayer(babelPlayer(), babelWorld());
  assert.equal(character.babel.rankedSkillCount, 1, "count carried onto the view model");
  const html = renderBabelStatusWindow(character);
  assert.match(html, /<span>Skills<\/span><span>1<\/span>/, "the count renders (not 'none')");
});


test("D&D sidebar inventory gets the same interactable treatment", () => {
  const character = characterFromScenePlayer(babelPlayer(), null);
  const html = renderSoloCharacterSidebar(character);
  assert.match(html, /<details class="solo-inv-detail">/);
  assert.match(html, /data-solo-action="use_item" data-item-id="item_tonic"/);
});

test("guest banner renders in the shell only for guests, with the save affordance", () => {
  const base = { scene: { runId: "r1", location: { name: "X" }, player: {} } };
  const asGuest = renderSoloSceneShell({ ...base, isGuest: true });
  assert.match(asGuest, /solo-guest-banner/, "guest sees the banner");
  assert.match(asGuest, /data-solo-guest-save/, "banner carries the save action");
  const asUser = renderSoloSceneShell({ ...base, isGuest: false });
  assert.ok(!asUser.includes("solo-guest-banner"), "registered players never see it");
});
