import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCondition,
  describeCondition,
  conditionStatusPayload,
  backfillConditionKinds,
  normalizeConditionKind,
  CONDITION_KINDS,
  CONDITION_VOCAB
} from "../server/solo/conditions.js";

// Item 1 (bucket-2): kind is REQUIRED at mint — assigned by the committing code,
// never word-guessed at render. Payload carries it; legacy runs backfill ONCE.

const freshRun = () => ({ player: { displayName: "Bram", conditions: [] }, world: { time: { minutes: 100 } } });

test("mint requires kind: applyCondition always writes a valid kind", () => {
  const run = freshRun();
  // explicit caller kind (the committing code knows the effect)
  const marked = applyCondition(run, { name: "Palm-Mark", effect: "A sigil suppressing the distortion.", kind: "mark" }, 100);
  assert.equal(marked.kind, "mark");
  // vocab canon carries kind for the FF-status set
  const poisoned = applyCondition(run, "poisoned", 100);
  assert.equal(poisoned.kind, "debuff");
  const restrained = applyCondition(run, "restrained", 100);
  assert.equal(restrained.kind, "control", "action-denial statuses are control");
  // unknown, unstated -> neutral (never guessed)
  const odd = applyCondition(run, { name: "Dream-Touched" }, 100);
  assert.equal(odd.kind, "neutral");
  // every entry minted with a kind, always valid
  for (const entry of run.player.conditions) {
    assert.ok(CONDITION_KINDS.includes(entry.kind), `${entry.id} has valid kind ${entry.kind}`);
  }
});

test("an invalid caller kind is rejected to canon/neutral, never stored raw", () => {
  assert.equal(describeCondition({ name: "Weird", kind: "banana" }).kind, "neutral");
  assert.equal(describeCondition({ name: "poisoned", kind: "banana" }).kind, "debuff", "vocab canon wins over garbage");
  assert.equal(normalizeConditionKind("BUFF"), "buff");
  assert.equal(normalizeConditionKind(""), null);
});

test("every vocab entry declares a kind (mint-time knowledge is complete)", () => {
  for (const [id, canon] of Object.entries(CONDITION_VOCAB)) {
    assert.ok(CONDITION_KINDS.includes(canon.kind), `${id} vocab kind`);
  }
});

test("conditionStatusPayload carries kind", () => {
  const run = freshRun();
  applyCondition(run, { name: "Palm-Mark", effect: "sigil", kind: "mark" }, 100);
  applyCondition(run, "poisoned", 100);
  const payload = conditionStatusPayload(run, 100);
  assert.equal(payload.length, 2);
  assert.equal(payload[0].kind, "mark");
  assert.equal(payload[1].kind, "debuff");
});

test("refresh preserves/updates kind (a re-application re-declares it)", () => {
  const run = freshRun();
  applyCondition(run, { name: "Warded", effect: "protected", kind: "buff" }, 100);
  const refreshed = applyCondition(run, { name: "Warded", effect: "protected", kind: "buff", durationMinutes: 500 }, 120);
  assert.equal(refreshed.kind, "buff");
  assert.equal(run.player.conditions.length, 1, "refresh, not duplicate");
});

test("backfill assigns kinds ONCE to legacy entries via the heuristic, then never re-fires", () => {
  const run = freshRun();
  // legacy entries (pre-kind schema): no kind field at all
  run.player.conditions = [
    { id: "palm_mark", name: "Palm-Mark", effect: "A warm sigil suppresses the distortion.", expiresAtMinutes: 300 },
    { id: "exhausted", name: "Exhausted", effect: "Burden on everything until you rest.", expiresAtMinutes: 500 },
    { id: "restrained", name: "Restrained", effect: "You cannot move.", expiresAtMinutes: 200 },
    { id: "odd_thing", name: "Odd Thing", effect: "Something opaque.", expiresAtMinutes: null }
  ];
  const changed = backfillConditionKinds(run);
  assert.equal(changed, 4, "all four legacy entries backfilled");
  assert.equal(run.player.conditions[0].kind, "mark", "sigil word → mark");
  assert.equal(run.player.conditions[1].kind, "debuff", "vocab canon → debuff");
  assert.equal(run.player.conditions[2].kind, "control", "vocab canon → control");
  assert.equal(run.player.conditions[3].kind, "neutral", "no signal → neutral");
  // second pass: nothing to do — the heuristic is dead for this run
  assert.equal(backfillConditionKinds(run), 0, "backfill never re-fires once kinds exist");
});
