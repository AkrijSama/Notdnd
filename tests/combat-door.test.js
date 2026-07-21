// THE COMBAT DOOR (walk-2 Group A). C1 enemy-initiated combat (watching is the default;
// aggression only on committed conditions), C2 the narrated-violence firewall (outside
// combat, narration can't assault the player — calibrated: judo-flip flags, figurative
// doesn't), C5 the one-tap agency law (absurd disparity resolves without the engine;
// contested range always enters it).
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { registerStatBlock, resolveStatBlock } from "../server/campaign/bestiary.js";
import { resolveEnemyAggression, tickAggressionClocks, commitProvoke } from "../server/solo/tactics.js";
import { isNarratedViolenceAgainstPlayer, scrubNarratedViolenceOutsideCombat } from "../server/solo/combatAudit.js";
import { disparityVerdict, mustEnterEngine } from "../server/solo/disparity.js";

// test stat blocks: an explicit hunter + a stalker (register into the runtime overlay)
registerStatBlock({ statBlockId: "test_hunter", name: "Hunter", kind: "beast", tier: 1, maxHp: 10, ac: 12, dexMod: 1, attacks: [{ attackId: "bite", toHit: 3, damage: "1d6" }], behaviors: { aggressive: true }, intents: [], tags: ["beast"] });
registerStatBlock({ statBlockId: "test_stalker", name: "Stalker", kind: "beast", tier: 1, maxHp: 10, ac: 12, dexMod: 1, attacks: [{ attackId: "bite", toHit: 3, damage: "1d6" }], behaviors: { stalker: true }, intents: [], tags: ["beast"] });
registerStatBlock({ statBlockId: "test_rat", name: "Rat", kind: "vermin", tier: 0, maxHp: 1, ac: 8, dexMod: 1, attacks: [{ attackId: "nip", toHit: 0, damage: "1" }], behaviors: {}, intents: [], tags: ["vermin"] });

function runWith(npc) {
  const run = createDefaultSoloRun({ runId: "door" });
  run.currentLocationId = "loc_here";
  run.npcs = { [npc.npcId]: { currentLocationId: "loc_here", status: "present", ...npc } };
  return run;
}

// ── C1 ───────────────────────────────────────────────────────────────────────
test("C1: a WATCHING hostile (grey wolf, present, not aggressive/provoked) does NOT start a fight", () => {
  const run = runWith({ npcId: "npc_wolf", statBlockId: "grey_wolf" });
  assert.equal(resolveEnemyAggression(run), null, "watching is the default — tension, not a fight");
});

test("C1: aggression fires on a COMMITTED condition (explicit hunter / a provoke flag)", () => {
  const hunter = runWith({ npcId: "npc_hunter", statBlockId: "test_hunter" });
  assert.deepEqual(resolveEnemyAggression(hunter), { npcId: "npc_hunter", reason: "aggressive" });
  // a plain wolf watches — until provoked
  const wolf = runWith({ npcId: "npc_wolf", statBlockId: "grey_wolf" });
  assert.equal(resolveEnemyAggression(wolf), null);
  commitProvoke(wolf, "npc_wolf");
  assert.deepEqual(resolveEnemyAggression(wolf), { npcId: "npc_wolf", reason: "provoked" });
});

test("C1: a STALKER closes only after co-present turns (never instantly)", () => {
  const run = runWith({ npcId: "npc_stalk", statBlockId: "test_stalker" });
  assert.equal(resolveEnemyAggression(run), null, "not on turn one");
  tickAggressionClocks(run); tickAggressionClocks(run); // 2 turns
  assert.equal(resolveEnemyAggression(run), null, "still watching");
  tickAggressionClocks(run); // 3rd
  assert.deepEqual(resolveEnemyAggression(run), { npcId: "npc_stalk", reason: "stalker" });
});

test("C1: already in a fight → no new enemy-initiated entry", () => {
  const run = runWith({ npcId: "npc_hunter", statBlockId: "test_hunter" });
  run.combat = { status: "active" };
  assert.equal(resolveEnemyAggression(run), null);
});

// ── C2 ───────────────────────────────────────────────────────────────────────
test("C2: narrated violence-against-player FLAGS (the judo-flip) but figurative does NOT", () => {
  assert.equal(isNarratedViolenceAgainstPlayer("She grabs your collar and flips you hard onto the dirt."), true, "judo-flip flags");
  assert.equal(isNarratedViolenceAgainstPlayer("The wolf lunges at you, teeth closing on your arm."), true);
  // figurative / elemental must NOT flag
  assert.equal(isNarratedViolenceAgainstPlayer("The wind cuts like a knife across the ridge."), false, "simile is not an assault");
  assert.equal(isNarratedViolenceAgainstPlayer("The cold bites at your fingers."), false, "elemental subject is figurative");
  assert.equal(isNarratedViolenceAgainstPlayer("Your heart pounds as you crest the hill."), false);
});

test("C2: the firewall STRIPS violence outside combat, no-op inside combat", () => {
  const narr = "You step onto the span. The enforcer slams you against the pillar. Gravel bites your palm.";
  const out = scrubNarratedViolenceOutsideCombat(narr, null);
  assert.equal(out.violenceDetected, true, "the assault is caught");
  assert.doesNotMatch(out.text, /slams you against the pillar/, "the fabricated blow is stripped");
  // inside a live fight the combat surface owns violence — no-op
  const inFight = scrubNarratedViolenceOutsideCombat(narr, { status: "active" });
  assert.equal(inFight.violenceDetected, false);
  assert.equal(inFight.text, narr);
});

// ── C5 ───────────────────────────────────────────────────────────────────────
test("C5: absurd disparity is a one-tap; contested range always enters the engine", () => {
  const run = createDefaultSoloRun({ runId: "disp" });
  run.player.level = 1;
  run.player.resources = { hitPoints: { current: 9, max: 9 } };
  // a tier-4 demon one-taps a level-1 wanderer
  const demon = disparityVerdict(run, { statBlockId: "rapture_drifter" });
  assert.equal(demon.verdict, "enemy_onetaps", `demon should one-tap (ratio ${demon.ratio.toFixed(1)})`);
  assert.equal(mustEnterEngine(run, { statBlockId: "rapture_drifter" }), false, "a one-tap does not need the engine");
  // a bandit enforcer is a CONTESTED fight — always the engine
  const bandit = disparityVerdict(run, { statBlockId: "bandit_enforcer" });
  assert.equal(bandit.verdict, "contested", `bandit is contested (ratio ${bandit.ratio.toFixed(1)})`);
  assert.equal(mustEnterEngine(run, { statBlockId: "bandit_enforcer" }), true, "contested ALWAYS enters the engine");
  // a bystander is NOT an absurd gap for a level-1 player — still contested (honest)
  assert.equal(disparityVerdict(run, { statBlockId: "civilian" }).verdict, "contested");
  // a rat can never one-tap the PLAYER (the disparity is never in the rat's favour)
  assert.notEqual(disparityVerdict(run, { statBlockId: "test_rat" }).verdict, "enemy_onetaps");
  // and a HIGH-level hero absurdly out-powers a rat → player one-taps (no combat surface)
  const hero = createDefaultSoloRun({ runId: "hero" });
  hero.player.level = 12; hero.player.resources = { hitPoints: { current: 90, max: 90 } };
  assert.equal(disparityVerdict(hero, { statBlockId: "test_rat" }).verdict, "player_onetaps");
});
