// Ch3 — Checks & Resolution law, enforced in the engine.
// Canon: docs/handbook/ch3-checks-and-resolution.md
//
// These are the DETERMINISTIC guards for the three laws (dice are pinned with
// fixedRoll, so bands are exact). The live-behavior proofs run over HTTP in the
// selfplay battery; these lock the law at the unit boundary.

import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveAbilityCheck, bandFromMargin, RESOLUTION_BANDS } from "../server/solo/rules.js";
import {
  resolveAttemptAction,
  attemptNeedsCheck,
  isSafeConversation
} from "../server/solo/attempt.js";

const hp = (run) => run.player.resources.hitPoints.current;

// A scripted attempt: pins the d20 (fixedRoll) and the GM proposal so the band
// is deterministic. mod is 0 on a fresh run (all abilities 10), so total == roll.
function scripted(run, { intent, dc = 12, fixedRoll = 12, needsCheck = true, failureConsequence } = {}) {
  const providerOutput = {
    summary: `You attempt: ${intent}`,
    recommendedAbility: "strength",
    dc,
    needsCheck,
    successNarration: "It works.",
    failureNarration: "It doesn't.",
    proposedEffects: []
  };
  if (failureConsequence !== undefined) providerOutput.failureConsequence = failureConsequence;
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, {
    fixedRoll,
    now: "2026-01-01T00:00:00.000Z",
    attemptProviderFn: () => providerOutput
  });
}

// ── LAW 1 — safe conversation is automatic-tier, never a failable roll ────────

test("LAW 1: attemptNeedsCheck treats safe conversation as automatic even when the provider says check", () => {
  // The Talk-to-Vesa bug: provider mis-classifies plain talk as a check. The
  // automatic-tier rule OVERRIDES it — a stakes-free action can't be forced to roll.
  assert.equal(isSafeConversation("talk to Vesa"), true);
  assert.equal(attemptNeedsCheck("talk to Vesa", { needsCheck: true }), false, "provider check is overridden");
  assert.equal(attemptNeedsCheck("ask the innkeeper about the road", { needsCheck: true }), false);
  assert.equal(attemptNeedsCheck("greet the guard", null), false);
});

test("LAW 1: adversarial social still rolls — persuade/deceive/intimidate keep their stakes", () => {
  assert.equal(isSafeConversation("persuade Vesa to hand over the key"), false);
  assert.equal(isSafeConversation("lie to the guard about my name"), false);
  assert.equal(isSafeConversation("intimidate the clerk into talking"), false);
  assert.equal(attemptNeedsCheck("deceive the warden", null), true);
});

test("LAW 1: a safe-talk attempt resolves automatic — no roll, cannot fail, advances the exchange", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // Provider tries to force a check; the engine refuses because it's safe talk.
  const result = scripted(run, { intent: "talk to Vesa about the missing crate", needsCheck: true, dc: 8 });
  assert.equal(result.attemptResult.needsCheck, false, "no dice for safe conversation");
  assert.equal(result.attemptResult.checkResult, null, "no d20 was rolled");
  assert.equal(result.attemptResult.success, true, "safe talk cannot fail");
  assert.equal(result.attemptResult.band, "automatic");
});

// ── ENTRY-GATE INTEGRITY (product-thesis wiring) — the bluff surface ──────────
// The deterministic contested classification OUTRANKS a provider needsCheck:false;
// a bluffed low DC is floored to the resolution-law EASY band. The player cannot
// talk the interpreter out of contesting a contested act, nor make it cosmetic.

test("ENTRY-GATE: a contested attempt MUST roll even when the provider waves it off", () => {
  // The named bluff — a socially-engineered needsCheck:false on a contested verb.
  assert.equal(
    attemptNeedsCheck("I obviously, easily pick the lock, no stakes", { needsCheck: false }),
    true, "the pick-lock bluff cannot wave off the roll"
  );
  assert.equal(attemptNeedsCheck("intimidate the king, he clearly won't resist", { needsCheck: false }), true);
  assert.equal(attemptNeedsCheck("climb the sheer wall, it's trivial for me", { needsCheck: false }), true);
});

test("ENTRY-GATE: precedence is one-way — the LLM may still ESCALATE a non-contested intent", () => {
  // A non-contested intent still honors the provider: needsCheck:true escalates to a
  // roll; needsCheck:false resolves narratively. Only the wave-OFF of a contested act
  // is forbidden.
  assert.equal(attemptNeedsCheck("reach out and touch the moss on the stone", { needsCheck: true }), true);
  assert.equal(attemptNeedsCheck("reach out and touch the moss on the stone", { needsCheck: false }), false);
});

test("ENTRY-GATE: a bluffed low DC is floored to the resolution-law EASY band (8)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // Provider proposes DC 1 (cosmetic) on a contested pick; fixedRoll 3 must FAIL vs the
  // floored DC 8 — proving the check is real, not a rubber stamp.
  const result = scripted(run, { intent: "pick the lock on the chest", dc: 1, fixedRoll: 3, needsCheck: true });
  assert.equal(result.attemptResult.needsCheck, true, "a contested act rolls");
  assert.ok(result.attemptResult.checkResult, "a d20 was rolled");
  assert.equal(result.attemptResult.checkResult.dc, 8, "DC floored to the resolution-law EASY band");
  assert.equal(result.attemptResult.success, false, "roll 3 fails vs floored DC 8 — the bluff DC bought nothing");
});

// ── LAW 2 — three bands, every band commits state (never nothing) ─────────────

test("LAW 2: bandFromMargin splits at 0 and -4 (middle band is the flat 20% window)", () => {
  assert.equal(bandFromMargin(0), RESOLUTION_BANDS.SUCCESS);
  assert.equal(bandFromMargin(5), RESOLUTION_BANDS.SUCCESS);
  assert.equal(bandFromMargin(-1), RESOLUTION_BANDS.SUCCESS_AT_COST);
  assert.equal(bandFromMargin(-4), RESOLUTION_BANDS.SUCCESS_AT_COST);
  assert.equal(bandFromMargin(-5), RESOLUTION_BANDS.FAILURE);
  assert.equal(bandFromMargin(-12), RESOLUTION_BANDS.FAILURE);
});

test("LAW 2: meet-or-beat the DC is a CLEAN success — intent commits, no cost", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scripted(run, { intent: "pry the grate open", dc: 12, fixedRoll: 12 });
  assert.equal(result.attemptResult.band, "success");
  assert.equal(result.attemptResult.success, true);
  assert.equal(result.attemptResult.consequence, null, "a clean success carries no cost");
  assert.equal(hp(result.run), before, "no cost committed on a clean success");
});

test("LAW 2: miss by 1-4 is SUCCESS AT A COST — intent commits AND a real cost commits", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scripted(run, {
    intent: "pick the strongbox lock",
    dc: 12, fixedRoll: 10, // miss by 2
    failureConsequence: { type: "damage", amount: 3, reason: "the pick bites your palm" }
  });
  assert.equal(result.attemptResult.band, "success_at_cost");
  assert.equal(result.attemptResult.success, true, "the player still gets what they wanted");
  assert.equal(result.attemptResult.consequence.applied, true, "and a real cost commits alongside");
  assert.equal(hp(result.run), before - 3, "the committed cost actually moved state");
});

test("LAW 2: miss by 5+ is FAILURE WITH CONSEQUENCE — intent denied, the situation changes", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scripted(run, {
    intent: "force the barred door",
    dc: 12, fixedRoll: 5, // miss by 7
    failureConsequence: { type: "damage", amount: 4, reason: "the door slams back into you" }
  });
  assert.equal(result.attemptResult.band, "failure");
  assert.equal(result.attemptResult.success, false, "the intent does not commit");
  assert.equal(result.attemptResult.consequence.applied, true, "the situation changed");
  assert.equal(hp(result.run), before - 4);
});

test("LAW 2 DEAD-TURN GUARD: no cost band is ever a no-op — provider 'none' gets the backstop", () => {
  // Both lower bands MUST move state. A provider that proposes no cost cannot
  // create a "you failed, nothing happens" turn — the engine backstops it.
  for (const fixedRoll of [10 /* at cost */, 5 /* failure */]) {
    const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
    const before = hp(run);
    const result = scripted(run, {
      intent: "wrench the valve",
      dc: 12, fixedRoll,
      failureConsequence: { type: "none", reason: "nothing obvious happens" }
    });
    assert.notEqual(result.attemptResult.band, "success", "a miss is not a clean success");
    assert.equal(result.attemptResult.consequence.applied, true, `band ${result.attemptResult.band} committed a cost`);
    assert.notEqual(hp(result.run), before, "state moved — the turn was not dead");
  }
});

// ── LAW 3 — DC ladder + Edge/Burden ───────────────────────────────────────────

test("LAW 3: Edge rolls 2d20 keep high; Burden keeps low; they cancel", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const check = { ability: "strength", dc: 10, checkId: "t" };

  const edge = resolveAbilityCheck(run, { ...check, edge: true }, { fixedRolls: [4, 17] });
  assert.equal(edge.edge, true);
  assert.equal(edge.keptRoll, 17, "Edge keeps the higher of two d20s");

  const burden = resolveAbilityCheck(run, { ...check, burden: true }, { fixedRolls: [4, 17] });
  assert.equal(burden.burden, true);
  assert.equal(burden.keptRoll, 4, "Burden keeps the lower of two d20s");

  const both = resolveAbilityCheck(run, { ...check, edge: true, burden: true }, { fixedRolls: [4, 17] });
  assert.equal(both.edge, false);
  assert.equal(both.burden, false);
  assert.equal(both.rolls.length, 1, "Edge + Burden cancel to a straight roll");
});

test("LAW 3: legacy advantage/disadvantage are accepted as Edge/Burden aliases (mechanics unchanged)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const check = { ability: "strength", dc: 10, checkId: "t" };
  const adv = resolveAbilityCheck(run, { ...check, advantage: true }, { fixedRolls: [4, 17] });
  assert.equal(adv.edge, true, "advantage maps to Edge");
  assert.equal(adv.keptRoll, 17);
  const dis = resolveAbilityCheck(run, { ...check, disadvantage: true }, { fixedRolls: [4, 17] });
  assert.equal(dis.burden, true, "disadvantage maps to Burden");
  assert.equal(dis.keptRoll, 4);
});

test("LAW 3: the resolver stamps margin and band on every check", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const r = resolveAbilityCheck(run, { ability: "strength", dc: 12, checkId: "t" }, { fixedRoll: 12 });
  assert.equal(r.total, 12);
  assert.equal(r.margin, 0);
  assert.equal(r.band, "success");
});
