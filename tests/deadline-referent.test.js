import assert from "node:assert/strict";
import test from "node:test";
import { detectDeadlineViolations, hasCommittedDeadlineReferent } from "../server/gm/deadlineAudit.js";
import { buildActionGmMessage } from "../server/gm/actionNarration.js";

// DEADLINE-REFERENT LAW (item 4, bucket-2 — owner ruling): narrated urgency
// must bind to committed state. Auditor + contract clause.

const staticClockRun = () => ({
  player: { displayName: "Bram", conditions: [] },
  world: { time: { minutes: 480 } } // static clock, zero deadline referents
});

const runWithDeadline = () => ({
  player: {
    displayName: "Bram",
    conditions: [{ id: "burning", name: "Burning", effect: "flames", kind: "debuff", expiresAtMinutes: 483 }]
  },
  world: { time: { minutes: 480 } }
});

// THE OWNER'S LIVE CASE: "maybe five minutes to decide", static clock, zero
// committed deadline referents → flagged.
test("owner's live case: 'maybe five minutes to decide' with static clock + zero referents FLAGS", () => {
  const narration = "The smoke coils under the door. You have maybe five minutes to decide before the corridor is impassable.";
  const flags = detectDeadlineViolations(narration, staticClockRun());
  assert.equal(flags.length, 1, "invented countdown flagged");
  assert.match(flags[0].sentence, /maybe five minutes to decide/);
});

test("the same countdown WITH a committed timed condition is legitimate (no flag)", () => {
  const narration = "You have maybe five minutes to decide before the flames spread.";
  assert.equal(detectDeadlineViolations(narration, runWithDeadline()).length, 0);
  assert.equal(hasCommittedDeadlineReferent(runWithDeadline()), true);
  assert.equal(hasCommittedDeadlineReferent(staticClockRun()), false);
});

test("qualitative pressure is ALWAYS allowed (the lawful form)", () => {
  const narration = "The smoke is thickening. The voices outside come closer, and the door strains against its hinges.";
  assert.equal(detectDeadlineViolations(narration, staticClockRun()).length, 0);
});

test("event-boundary countdowns without a referent flag too ('before nightfall')", () => {
  const narration = "Reach the mill before nightfall or the road is lost.";
  assert.equal(detectDeadlineViolations(narration, staticClockRun()).length, 1);
});

test("explicit countdown assertions flag ('the clock is ticking')", () => {
  const narration = "Choose. The clock is ticking.";
  assert.equal(detectDeadlineViolations(narration, staticClockRun()).length, 1);
});

test("an expired condition is not a live referent (past countdowns legitimize nothing)", () => {
  const run = {
    player: { displayName: "B", conditions: [{ id: "dazed", name: "Dazed", expiresAtMinutes: 100 }] },
    world: { time: { minutes: 480 } }
  };
  assert.equal(hasCommittedDeadlineReferent(run), false);
  assert.equal(detectDeadlineViolations("You have two minutes left before it collapses.", run).length, 1);
});

test("plain durations in ordinary prose do not false-positive", () => {
  const clean = [
    "The walk takes twenty minutes through the fog.", // no pressure framing
    "Hours pass in the cellar's dark.",
    "She said the caravan left an hour ago."
  ];
  for (const narration of clean) {
    assert.equal(detectDeadlineViolations(narration, staticClockRun()).length, 0, `false positive: ${narration}`);
  }
});

// ---- contract clause (styleSuffix) ----

test("the contract carries the URGENCY LAW clause (numbers only with committed backing)", () => {
  const run = {
    world: { tone: "grim dark fantasy" },
    currentLocationId: "loc_a",
    locations: { loc_a: { locationId: "loc_a", name: "The Ember Tavern" } }
  };
  const resolved = {
    action: { type: "attempt" },
    attemptResult: { intent: "force the door", success: true, band: "success", checkResult: { total: 15, dc: 12 } }
  };
  const msg = buildActionGmMessage(run, resolved);
  assert.match(msg, /URGENCY LAW: never state a specific time budget or countdown/);
  assert.match(msg, /no 'you have five minutes', no 'before nightfall'/);
  assert.match(msg, /must stay qualitative \(the smoke thickens, the voices come closer\) with no invented numbers or countdowns/);
});
