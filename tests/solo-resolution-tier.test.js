import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  resolveAttemptAction,
  attemptNeedsCheck,
  isSafeConversation,
  isObservationQuery
} from "../server/solo/attempt.js";
import { buildActionGmMessage } from "../server/gm/actionNarration.js";
import { outcomeLabelForBand } from "../server/solo/rules.js";

// resolution-tier-diagnosis (owner 2026-07-11): the automatic tier — safe
// movement / conversation / observation resolve with NO roll and NO rolled band;
// stakes/opposition/danger roll a check with a visible checkResult; and NO
// FAILURE band is ever stamped without a checkResult (the numberless-FAILURE bug).

const NOW = "2026-01-01T00:00:00.000Z";
const PROVIDER = () => ({
  summary: "You act.",
  recommendedAbility: "strength",
  dc: 12,
  advantage: false,
  disadvantage: false,
  successNarration: "It works.",
  failureNarration: "It does not.",
  proposedEffects: []
});

// ── tiering classification (pure) ────────────────────────────────────────────
test("TIER: safe conversation / movement / observation need NO check", () => {
  assert.equal(attemptNeedsCheck("greet the guard at the gate"), false);
  assert.equal(attemptNeedsCheck("walk to the market square"), false);
  assert.equal(attemptNeedsCheck("look around the room"), false);
  assert.equal(isSafeConversation("greet the guard and ask directions"), true);
  assert.equal(isObservationQuery("what do I see around me?"), true);
});

test("TIER: stakes / opposition / danger DO need a check", () => {
  assert.equal(attemptNeedsCheck("sneak past the guard"), true);
  assert.equal(attemptNeedsCheck("persuade the merchant to lower his price"), true);
  assert.equal(attemptNeedsCheck("force the rusted door open"), true);
  // safe-talk verb + adversarial intent stays a check (not swept into automatic)
  assert.equal(isSafeConversation("intimidate the guard into leaving"), false);
});

// ── automatic tier commits no roll and no rolled band ────────────────────────
test("AUTOMATIC: a safe action resolves with band=automatic and NO checkResult", () => {
  const run = createDefaultSoloRun({ now: NOW });
  const result = resolveAttemptAction(
    run,
    { type: "attempt", actorId: "player", intent: "greet the guard at the gate" },
    { attemptProviderFn: PROVIDER }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.band, "automatic");
  assert.equal(result.attemptResult.checkResult, null, "no roll happened");
  assert.equal(outcomeLabelForBand(result.attemptResult.band), null, "automatic shows NO outcome badge");
});

// ── stakes tier rolls a check that carries its numbers ───────────────────────
test("STAKES: a contested action rolls a check with a visible checkResult", () => {
  const run = createDefaultSoloRun({ now: NOW });
  const result = resolveAttemptAction(
    run,
    { type: "attempt", actorId: "player", intent: "force the heavy iron door open" },
    { fixedRoll: 18, attemptProviderFn: PROVIDER }
  );
  assert.equal(result.ok, true);
  assert.ok(["success", "success_at_cost", "failure"].includes(result.attemptResult.band), "a rolled band");
  assert.ok(result.attemptResult.checkResult, "the rolled band carries its checkResult");
  assert.equal(typeof result.attemptResult.checkResult.total, "number");
  assert.equal(typeof result.attemptResult.checkResult.dc, "number");
});

// ── the invariant: NO FAILURE without a checkResult (foreclosed retry) ────────
test("INVARIANT: a foreclosed (blocked) retry is a refusal — no FAILURE band, no checkResult", () => {
  const run = createDefaultSoloRun({ now: NOW });
  const loc = run.locations[run.currentLocationId];
  loc.flags = loc.flags || {};
  // The GM previously degraded this object with a "blocked" retry penalty.
  loc.flags.objectStates = {
    obj_lock: {
      objectId: "obj_lock",
      targetId: null,
      retryEffect: "blocked",
      matchTokens: ["lock"],
      label: "rusted lock",
      state: "fused",
      reason: "The lock is fused solid"
    }
  };
  const result = resolveAttemptAction(
    run,
    { type: "attempt", actorId: "player", intent: "force the rusted lock again" },
    { fixedRoll: 1, attemptProviderFn: PROVIDER }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.foreclosed, true, "the retry was foreclosed");
  assert.equal(result.attemptResult.success, false);
  assert.notEqual(result.attemptResult.band, "failure", "a foreclosed retry is NOT a rolled FAILURE");
  assert.equal(result.attemptResult.checkResult, null, "no dice were thrown");
  assert.equal(outcomeLabelForBand(result.attemptResult.band), null, "no numberless FAILURE badge in the record");
  // The committed timeline event must carry the same clean (bandless) outcome.
  const event = result.run.timeline.at(-1);
  assert.equal(event.type, "attempt");
  assert.equal(event.payload.band ?? null, null, "the RUN RECORD stamps no FAILURE band");
  assert.equal(event.payload.checkResult ?? null, null);
});

// ── band → GM directive coherence ────────────────────────────────────────────
function directiveFor(band, extra = {}) {
  const run = {
    world: { tone: "grim" },
    currentLocationId: "loc_a",
    locations: { loc_a: { locationId: "loc_a", name: "The Gate", description: "A timber gate." } }
  };
  const resolved = {
    action: { type: "attempt" },
    attemptResult: { intent: "walk to the gate and greet the guard", band, success: band !== "failure", ...extra }
  };
  return buildActionGmMessage(run, resolved);
}

test("COHERENCE: an automatic action is framed as simply happening, never a passed check", () => {
  const msg = directiveFor("automatic");
  assert.match(msg, /simply happens|no-stakes|NO roll/i);
  assert.doesNotMatch(msg, /The attempt SUCCEEDS/, "automatic is not narrated as a won contest");
  assert.doesNotMatch(msg, /FAILS/);
});

test("COHERENCE: a rolled FAILURE directive carries its numbers; a move is a clean arrival", () => {
  const failMsg = directiveFor("failure", { checkResult: { total: 4, dc: 12 } });
  assert.match(failMsg, /rolled 4 vs DC 12/, "the failure directive shows the roll numbers");
  // A rerouted MOVE narrates arrival (automatic), never a failure/roll.
  const moveRun = {
    world: { tone: "grim" },
    currentLocationId: "loc_b",
    locations: { loc_b: { locationId: "loc_b", name: "The Market", description: "Stalls line the square." } }
  };
  const moveMsg = buildActionGmMessage(moveRun, { action: { type: "move" }, moved: { toLocationId: "loc_b" } });
  assert.match(moveMsg, /travels to|arriving/i, "a move is narrated as an arrival");
  assert.doesNotMatch(moveMsg, /rolled|vs DC|FAILS/);
});
