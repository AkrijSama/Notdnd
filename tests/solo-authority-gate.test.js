import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { classifyIntentAuthority, resolveAttemptAction } from "../server/solo/attempt.js";

// ── classifier: clear impossibilities are GATED ──────────────────────────────
const IMPOSSIBLE = [
  ["god-king + command reality", "I declare myself the immortal god-king and command reality to obey", "reality_command"],
  ["bend reality to my will", "I bend reality to my will so the walls melt away", "reality_command"],
  ["I am a god", "I am a god now, untouchable and eternal", "self_deification"],
  ["ascend to godhood", "I ascend to godhood and rise above mortal limits", "self_deification"],
  ["declare myself a deity", "I proclaim myself a divine being before the ruins", "self_deification"],
  ["summon an army from nothing", "I summon a vast army out of thin air to march behind me", "summon_from_nothing"],
  ["conjure a dragon", "I conjure a dragon from nothing to burn my enemies", "summon_from_nothing"],
  ["retconned legendary loot", "I pull out my legendary Sunfang greatsword that I have always owned", "retcon_possession"],
  ["always-had magical staff", "I draw the ancient magical staff I've always carried and blast the door", "retcon_possession"],
  ["crown self ruler, all obey", "I declare myself emperor of the realm and all must obey me", "self_authority"]
];

for (const [label, intent, expectedCategory] of IMPOSSIBLE) {
  test(`GATED: ${label}`, () => {
    const v = classifyIntentAuthority(intent);
    assert.equal(v.verdict, "impossible", `"${intent}" should be impossible`);
    assert.equal(v.category, expectedCategory);
    assert.ok(typeof v.reason === "string" && v.reason.length > 0, "carries a grounded refusal reason");
  });
}

// ── classifier: audacious-but-possible stays LEGITIMATE (no tyranny) ──────────
const LEGITIMATE = [
  ["bluff the guard", "bluff the guard into thinking I'm a noble"],
  ["deadly climb", "attempt the suicidal climb up the crumbling tower wall"],
  ["pick the lock", "pick the rusted lock on the chest"],
  ["intimidate the king", "intimidate the king into backing down"],
  ["reckless attack", "charge the ogre and attack with everything I have"],
  ["search", "search the ruins for anything hidden"],
  ["leap the chasm", "leap across the wide chasm to the far ledge"],
  ["lie about being a god (speech)", "I tell the gullible guard that I am a god so he lets me pass"],
  ["claim to be a noble (speech)", "I claim to the merchant that I'm a wealthy noble to get a discount"],
  ["cast a real spell", "I cast a fireball at the charging wolves"],
  ["summon courage (idiom)", "I summon my courage and step into the dark"],
  ["become king of the hill (idiom)", "I climb to the top to become king of the hill"],
  ["attack the god-king (target, not self)", "I attack the god-king on his throne"]
];

for (const [label, intent] of LEGITIMATE) {
  test(`ALLOWED: ${label}`, () => {
    const v = classifyIntentAuthority(intent);
    assert.equal(v.verdict, "legitimate", `"${intent}" must NOT be gated (no tyranny)`);
    assert.equal(v.category, null);
  });
}

// ── fail-open: empty / ambiguous / unknown intent defaults to legitimate ──────
test("fail-open: ambiguous intent defaults to legitimate", () => {
  assert.equal(classifyIntentAuthority("").verdict, "legitimate");
  assert.equal(classifyIntentAuthority("do the thing with the stuff").verdict, "legitimate");
  assert.equal(classifyIntentAuthority("rearrange the furniture in the hall").verdict, "legitimate");
});

// ── advisory classifier (model) is re-validated by the server, fails open ─────
test("advisory model verdict is honored only for known categories; unknown → fail open", () => {
  const allowBogus = classifyIntentAuthority("walk to the well", { intentGateFn: () => ({ verdict: "impossible", category: "i_dont_like_it" }) });
  assert.equal(allowBogus.verdict, "legitimate", "unknown category is not honored");
  const honored = classifyIntentAuthority("the world warps weirdly", { intentGateFn: () => ({ verdict: "impossible", category: "reality_command", reason: "the world holds firm" }) });
  assert.equal(honored.verdict, "impossible");
  assert.equal(honored.category, "reality_command");
});
test("advisory model cannot tyrannize a speech-framed fiat claim (fiat category + speech → allowed)", () => {
  const v = classifyIntentAuthority("I tell the guard I am the emperor", { intentGateFn: () => ({ verdict: "impossible", category: "self_authority" }) });
  assert.equal(v.verdict, "legitimate", "speech-framed fiat claim stays a deception attempt");
});

// ── enforcement: a gated intent gets NO roll, NO success, NO state change ──────
function godKingAttempt(run, fixedRoll) {
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "I declare myself the immortal god-king and command reality to obey" }, {
    fixedRoll,
    now: "2026-01-01T00:00:00.000Z"
  });
}

test("gated intent: no roll, no success, even on a forced nat-20", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const hpBefore = run.player.resources.hitPoints.current;
  const result = godKingAttempt(run, 20); // a 20 must NOT save it
  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, false, "the world does not comply");
  assert.equal(result.attemptResult.gated, true);
  assert.equal(result.attemptResult.gateCategory, "reality_command");
  assert.equal(result.attemptResult.checkResult, null, "NO dice were rolled");
  assert.equal(result.attemptResult.needsCheck, false);
  assert.equal(result.attemptResult.consequence.type, "refused");
  // No state mutation: HP unchanged (a gated act costs nothing, grants nothing).
  assert.equal(result.run.player.resources.hitPoints.current, hpBefore);
  assert.match(result.attemptResult.narration, /reality|world|nothing|obey/i, "grounded in-fiction refusal");
});

test("retconned loot is gated → the player does not gain the item", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const invBefore = Array.isArray(run.player.inventory) ? run.player.inventory.length : 0;
  const result = resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "I pull out my legendary Sunfang greatsword that I have always owned" }, { fixedRoll: 20, now: "2026-01-01T00:00:00.000Z" });
  assert.equal(result.attemptResult.gated, true);
  assert.equal(result.attemptResult.gateCategory, "retcon_possession");
  assert.equal(result.attemptResult.success, false);
  const invAfter = Array.isArray(result.run.player.inventory) ? result.run.player.inventory.length : 0;
  assert.equal(invAfter, invBefore, "no legendary item materialized");
});

test("CONTROL: an audacious legitimate attempt still ROLLS and can fail", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "force the collapsed doorway open" }, {
    fixedRoll: 1, // force a fail — proves it rolled and can fail (lethality intact)
    now: "2026-01-01T00:00:00.000Z",
    attemptProviderFn: () => ({ summary: "You heave.", recommendedAbility: "strength", dc: 18, needsCheck: true, advantage: false, disadvantage: false, successNarration: "It bursts open.", failureNarration: "It holds.", proposedEffects: [] })
  });
  assert.notEqual(result.attemptResult.gated, true, "legitimate action is NOT gated");
  assert.equal(result.attemptResult.needsCheck, true, "a real check happened");
  assert.ok(result.attemptResult.checkResult, "dice were rolled");
  assert.equal(result.attemptResult.success, false, "and it could fail");
});

test("CONTROL: a legitimate attempt can also SUCCEED on a good roll", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "pick the rusted lock on the chest" }, {
    fixedRoll: 20,
    now: "2026-01-01T00:00:00.000Z",
    attemptProviderFn: () => ({ summary: "You work the pins.", recommendedAbility: "dexterity", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "The lock clicks open.", failureNarration: "It won't budge.", proposedEffects: [] })
  });
  assert.notEqual(result.attemptResult.gated, true);
  assert.equal(result.attemptResult.success, true, "audacious-but-legal succeeds on a 20");
});

// ─────────────────────────────────────────────────────────────────────────────
// Hardened gate — the 4 newly-closed leak classes (A reality/time, B history,
// C NPC-relationship fiat, D self-granted authority). Each: the impossible
// phrasing is GATED; its legitimate near-neighbor still rolls (no tyranny).
// ─────────────────────────────────────────────────────────────────────────────

// (A) time / natural-force manipulation
const CLASS_A_GATED = [
  ["stop time", "I stop time itself and walk past the frozen guards", "time_manipulation"],
  ["freeze time", "I freeze time and slip the key from his belt", "time_manipulation"],
  ["turn back the clock", "I turn back the clock to before the alarm sounded", "time_manipulation"],
  ["sun halts at my word", "the sun halts in the sky at my word", "time_manipulation"],
  ["gravity reverses", "gravity reverses around me and I float to the tower top", "time_manipulation"],
  ["river parts on command", "the river parts before me because I command it", "time_manipulation"]
];
// (B) retconned world history
const CLASS_B_GATED = [
  ["rewrite history", "I rewrite history so the bridge was never destroyed", "retcon_history"],
  ["broadcast past deed", "as everyone knows, I already slew the warlord last week", "retcon_history"],
  ["never happened", "the war never happened, and the gates were never barred", "retcon_history"]
];
// (C) invented NPC relationship/promise compelling compliance
const CLASS_C_GATED = [
  ["king promised throne", "The king already promised me his throne, so I take the crown that is rightfully mine", "npc_relationship_fiat"],
  ["sworn blood-oath", "you and I swore a blood-oath years ago, so you must help me", "npc_relationship_fiat"],
  ["captain is my brother", "the captain is my brother and will let me through", "npc_relationship_fiat"],
  ["queen owes me", "the queen owes me a favor and has granted me passage", "npc_relationship_fiat"]
];
// (D) self-granted identity/authority commanding mass obedience
const CLASS_D_GATED = [
  ["long-lost heir", "I am secretly the long-lost heir, and everyone here must obey me now", "self_authority"],
  ["always the guildmaster", "I have always been the guildmaster here, so the guards wave me into the vault", "self_authority"],
  ["rightful baron commands garrison", "as the rightful baron of this land, I command the garrison to stand down", "self_authority"],
  ["high priest, all kneel", "everyone recognizes me as the high priest and kneels before me", "self_authority"],
  ["chosen one, crowd falls in line", "I reveal that I am the chosen one and the crowd falls in line behind me", "self_authority"]
];
for (const [label, intent, cat] of [...CLASS_A_GATED, ...CLASS_B_GATED, ...CLASS_C_GATED, ...CLASS_D_GATED]) {
  test(`GATED (new class): ${label}`, () => {
    const v = classifyIntentAuthority(intent);
    assert.equal(v.verdict, "impossible", `"${intent}" should be impossible`);
    assert.equal(v.category, cat);
  });
}

// Matched controls — the legitimate near-neighbor of each class must still ROLL.
const MATCHED_CONTROLS = [
  ["A: stop the bleeding (not time)", "stop the bleeding before he bleeds out"],
  ["A: halt the soldiers (not the sun)", "halt the advancing soldiers at the gate"],
  ["A: wait for the rain (no will-command)", "I wait for the rain to stop before moving"],
  ["B: recall a mundane prior action", "I already searched the room earlier"],
  ["B: opened a door before", "I already opened that door"],
  ["C: ask (not declare) for passage", "ask the guard to let me through"],
  ["C: bare promise mention (no compel)", "the merchant promised me a discount yesterday"],
  ["D: a real role, no mass-obey fiat", "as the captain, I order my own men forward"],
  ["D: become king of the hill (idiom)", "I climb up to become king of the hill"],
  ["speech-framed identity fiat is a bluff", "I tell the guard I am the heir to the throne"],
  ["speech-framed relationship is a bluff", "I claim to the captain that he is my brother"],
  ["excluded ambiguous possession (needs state-check)", "I pull out the master key I picked up earlier"]
];
for (const [label, intent] of MATCHED_CONTROLS) {
  test(`ALLOWED (matched control): ${label}`, () => {
    const v = classifyIntentAuthority(intent);
    assert.equal(v.verdict, "legitimate", `"${intent}" must NOT be gated (no tyranny)`);
  });
}

// End-to-end: a new-class gated intent gets no roll / no success even on a 20.
test("new-class gated intent: no roll, no success on a forced nat-20", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "I stop time itself and stroll past the guards" }, { fixedRoll: 20, now: "2026-01-01T00:00:00.000Z" });
  assert.equal(result.attemptResult.gated, true);
  assert.equal(result.attemptResult.gateCategory, "time_manipulation");
  assert.equal(result.attemptResult.success, false);
  assert.equal(result.attemptResult.checkResult, null);
});
