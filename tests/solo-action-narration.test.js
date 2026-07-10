import assert from "node:assert/strict";
import test from "node:test";
import { buildActionGmMessage, buildOpeningGmMessage } from "../server/gm/actionNarration.js";

const run = {
  currentLocationId: "loc_market",
  world: { tone: "grimdark" },
  locations: { loc_market: { name: "The Rust Market", description: "Stalls of scrap under a bruised sky." } },
  npcs: { npc_1: { displayName: "Garrick", personality: "gruff but fair", appearance: "scarred dwarf" } },
  player: { displayName: "Kael" }
};

test("attempt prompt includes intent, band outcome, roll, and tone", () => {
  // Miss by 5+ (7 vs DC 15) is the FAILURE band — the situation changes; the
  // narrator is steered to a failure-with-consequence, never a clean fail. The
  // band is derived from the roll margin when the caller doesn't stamp one.
  const msg = buildActionGmMessage(run, {
    action: { type: "attempt" },
    attemptResult: { intent: "pick the lock", success: false, checkResult: { total: 7, dc: 15 } }
  });
  assert.match(msg, /pick the lock/);
  assert.match(msg, /FAILS and the situation CHANGES/);
  assert.match(msg, /rolled 7 vs DC 15/);
  assert.match(msg, /grimdark/);
});

test("attempt prompt steers success-at-a-cost on a miss by 1-4", () => {
  // 13 vs DC 15 is a miss by 2 — the middle band. The player STILL gets it, but
  // a committed cost lands alongside; the narrator must name both.
  const msg = buildActionGmMessage(run, {
    action: { type: "attempt" },
    attemptResult: {
      intent: "pick the lock",
      success: true,
      band: "success_at_cost",
      checkResult: { total: 13, dc: 15 },
      consequence: { type: "damage", applied: true, amount: 2, reason: "the pick bites your palm" }
    }
  });
  assert.match(msg, /SUCCEEDS AT A COST/);
  assert.match(msg, /the pick bites your palm/);
  assert.match(msg, /rolled 13 vs DC 15/);
});

test("move prompt names the destination + description", () => {
  const msg = buildActionGmMessage(run, { action: { type: "move" } });
  assert.match(msg, /The Rust Market/);
  assert.match(msg, /Stalls of scrap/);
});

test("talk prompt voices the NPC and uses scripted line when present", () => {
  const withBeat = buildActionGmMessage(run, {
    action: { type: "talk" },
    talkResult: { npcId: "npc_1", speakerName: "Garrick", found: true, line: "The gate's been shut since the curfew." }
  });
  assert.match(withBeat, /Garrick/);
  assert.match(withBeat, /gruff but fair/);
  assert.match(withBeat, /curfew/);
  assert.match(withBeat, /spoken reply in-character/);

  const firstContact = buildActionGmMessage(run, {
    action: { type: "talk" },
    talkResult: { npcId: "npc_1", speakerName: "Garrick", found: false, line: "No new dialogue is available." }
  });
  assert.match(firstContact, /brief first exchange/);
  assert.doesNotMatch(firstContact, /No new dialogue/);
});

test("talk reply prompt answers the player's message with conversation history", () => {
  const reply = buildActionGmMessage(run, {
    action: {
      type: "talk",
      message: "Whats east?",
      history: [
        { role: "npc", text: "Well met, traveler. The name's Garrick." },
        { role: "player", text: "Hello." }
      ]
    },
    talkResult: { npcId: "npc_1", speakerName: "Garrick", found: true, line: "The gate's been shut since the curfew." }
  });
  // The player's actual question must reach the prompt...
  assert.match(reply, /Whats east\?/);
  // ...the prior turns must be carried as context...
  assert.match(reply, /Conversation so far/);
  assert.match(reply, /Well met, traveler/);
  // ...and the GM must be told to answer in character, not re-greet.
  assert.match(reply, /Respond AS Garrick/);
  assert.match(reply, /Do NOT repeat an earlier greeting/);
});

test("search/rest/use_item prompts reflect their results", () => {
  assert.match(
    buildActionGmMessage(run, { action: { type: "search" }, searchResult: { found: true, summary: "a hidden ledger" } }),
    /hidden ledger/
  );
  assert.match(
    buildActionGmMessage(run, { action: { type: "rest" }, restResult: { restType: "long", allowed: true } }),
    /a long rest/
  );
  assert.match(
    buildActionGmMessage(run, { action: { type: "use_item" }, useItemResult: { itemName: "healing draught", summary: "restores vigor" } }),
    /healing draught/
  );
});

test("inspect (and unknown) actions get no narration", () => {
  assert.equal(buildActionGmMessage(run, { action: { type: "inspect" } }), null);
  assert.equal(buildActionGmMessage(run, { action: { type: "interact" } }), null);
  assert.equal(buildActionGmMessage(run, null), null);
});

test("opening prompt grounds the character, world, location, and NPC", () => {
  const msg = buildOpeningGmMessage({
    characterName: "Kael",
    race: "Elf",
    characterClass: "Ranger",
    world: {
      tone: "grimdark",
      description: "A broken empire of rust and oaths.",
      startingLocation: { name: "Iron Gate", description: "A portcullis of black iron." }
    },
    npc: { generatedName: "Garrick", role: "Gate Warden" }
  });
  assert.match(msg, /Kael, a Elf Ranger/);
  assert.match(msg, /Iron Gate/);
  assert.match(msg, /broken empire of rust/);
  assert.match(msg, /Garrick.*Gate Warden/);
  assert.match(msg, /grimdark/);
});

test("#14 opening prompt is PINNED to the committed clock (no unpinned night register)", () => {
  const msg = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "grimdark", startingLocation: { name: "The Ember Tavern" } },
    worldTime: { clock: "07:00", phase: "day" }
  });
  assert.match(msg, /COMMITTED TIME: it is 07:00/);
  assert.match(msg, /MUST read as day/);
  assert.match(msg, /no nightfall, moonlight/i);
  // a night clock pins the other direction
  const night = buildOpeningGmMessage({ characterName: "Kael", world: {}, worldTime: { clock: "23:10", phase: "night" } });
  assert.match(night, /COMMITTED TIME: it is 23:10/);
  assert.match(night, /MUST read as night/);
  // no worldTime (legacy callers) -> no clause, message otherwise intact
  const bare = buildOpeningGmMessage({ characterName: "Kael", world: {} });
  assert.doesNotMatch(bare, /COMMITTED TIME/);
});

test("opening prompt with a present NPC states WHY they are here (justified presence)", () => {
  const msg = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "grimdark", startingLocation: { name: "The Ember Tavern" } },
    npc: { generatedName: "Yarrow", role: "Tavern Keeper" },
    npcReason: "the tavern keeper tends this tavern and is here because it is their establishment"
  });
  assert.match(msg, /Yarrow.*Tavern Keeper/);
  assert.match(msg, /because the tavern keeper tends this tavern/);
  assert.doesNotMatch(msg, /ALONE/);
});

test("opening prompt with NO NPC instructs the GM the player is ALONE (no stranger)", () => {
  const msg = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "dark fantasy", startingLocation: { name: "The Ashen Ruins" } },
    npc: null
  });
  assert.match(msg, /ALONE/);
  assert.match(msg, /do NOT introduce any other person, figure, or stranger/);
});

test("opening prompt offers base-building only when the start is adoptable", () => {
  const withBase = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "dark fantasy", startingLocation: { name: "The Ashen Ruins" } },
    npc: null,
    baseBuilding: true
  });
  assert.match(withBase, /rebuild into a base of their own/);

  const withoutBase = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "dark fantasy", startingLocation: { name: "The Ember Tavern" } },
    npc: { generatedName: "Yarrow", role: "Tavern Keeper" },
    npcReason: "the tavern keeper tends this tavern",
    baseBuilding: false
  });
  assert.doesNotMatch(withoutBase, /base of their own/);
});
