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

test("attempt prompt includes intent, outcome, roll, and tone", () => {
  const msg = buildActionGmMessage(run, {
    action: { type: "attempt" },
    attemptResult: { intent: "pick the lock", success: false, checkResult: { total: 7, dc: 15 } }
  });
  assert.match(msg, /pick the lock/);
  assert.match(msg, /fails \(rolled 7 vs DC 15\)/);
  assert.match(msg, /grimdark/);
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
