import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolvePossessionClaim, resolveAttemptAction, validateAttemptProviderOutput } from "../server/solo/attempt.js";
import { resolveSoloAction } from "../server/solo/actions.js";

// A run whose player demonstrably HOLDS a Brass Key (granted via the real path).
function runWithBrassKey() {
  const base = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const g = resolveSoloAction(base, { type: "grant_item", itemId: "brass_key", item: { name: "Brass Key", usable: true, consumable: false, quantity: 1 } }, { now: "2026-01-01T00:00:00.000Z" });
  return g.run;
}

// Scripted interpreter output carrying a requiredItem flag (the model's job).
function scripted(requiredItem) {
  return { summary: "x", recommendedAbility: "dexterity", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "It opens.", failureNarration: "It holds.", proposedEffects: [], requiredItem };
}
function attempt(run, intent, requiredItem, fixedRoll) {
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, { fixedRoll, now: "2026-01-01T00:00:00.000Z", attemptProviderFn: () => scripted(requiredItem) });
}

// ── resolvePossessionClaim (the deterministic verifier) ──────────────────────
test("possession: a held item satisfies its claim (proceed)", () => {
  const run = runWithBrassKey();
  const v = resolvePossessionClaim(run, { name: "brass key", specific: true });
  assert.equal(v.possessed, true);
  assert.equal(v.refuse, false);
});

test("possession: a distinctively-different item is NOT satisfied by a same-category hold (refuse)", () => {
  const run = runWithBrassKey(); // has a BRASS key only
  const v = resolvePossessionClaim(run, { name: "silver skeleton key", specific: true });
  assert.equal(v.possessed, false, "holding a brass key does not satisfy a silver-skeleton-key claim");
  assert.equal(v.refuse, true);
});

test("possession: a bare category claim is fail-open against a held item of that kind", () => {
  const run = runWithBrassKey();
  const v = resolvePossessionClaim(run, { name: "my key", specific: true });
  assert.equal(v.possessed, true, "a bare 'key' claim is satisfied by any held key");
  assert.equal(v.refuse, false);
});

test("possession: generic/improvised gear is NEVER refused for absence (anti-tyranny)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" }); // no rock in inventory
  for (const name of ["a heavy rock", "a torch from a rag", "a sturdy stick", "a length of rope"]) {
    const v = resolvePossessionClaim(run, { name, specific: true });
    assert.equal(v.refuse, false, `"${name}" must never be refused — it is improvised gear`);
  }
});

test("possession: fail-open when not flagged specific, or no claim at all", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(resolvePossessionClaim(run, { name: "brass key", specific: false }).refuse, false);
  assert.equal(resolvePossessionClaim(run, null).refuse, false);
  assert.equal(resolvePossessionClaim(run, undefined).refuse, false);
});

// ── end-to-end through resolveAttemptAction ──────────────────────────────────
test("HAS the item → the action proceeds, rolls, and can succeed", () => {
  const run = runWithBrassKey();
  const r = attempt(run, "unlock the chest with the brass key", { name: "brass key", specific: true }, 20);
  assert.equal(r.ok, true);
  assert.notEqual(r.attemptResult.unpossessed, true, "not refused — the player holds it");
  assert.ok(r.attemptResult.checkResult, "a real check was rolled");
  assert.equal(r.attemptResult.success, true, "succeeds on a 20");
});

test("LACKS the item → the claim fails: no roll, no success even on a forced nat-20, no item materializes", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const invBefore = Object.keys(run.inventory || {}).length;
  const r = attempt(run, "show the guard my writ of passage I have always carried", { name: "writ of passage", specific: true }, 20);
  assert.equal(r.ok, true);
  assert.equal(r.attemptResult.unpossessed, true, "flagged as an unpossessed-item claim");
  assert.equal(r.attemptResult.success, false, "a forced nat-20 cannot conjure an item the player lacks");
  assert.equal(r.attemptResult.checkResult, null, "NO dice were rolled");
  assert.equal(r.attemptResult.consequence.type, "refused");
  assert.equal(r.attemptResult.consequence.category, "unpossessed_item");
  assert.match(r.attemptResult.narration, /reach for|nothing|never|not.*on you/i, "grounded in-fiction absence, not a system error");
  // No item materialized into inventory.
  assert.equal(Object.keys(r.run.inventory || {}).length, invBefore, "no item was conjured");
});

test("CONTROL: generic improvisation still rolls (and can fail) — not refused", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const r = attempt(run, "grab a nearby rock and hurl it at the lever", { name: "a nearby rock", specific: true }, 1);
  assert.notEqual(r.attemptResult.unpossessed, true, "improvised gear is never refused for absence");
  assert.ok(r.attemptResult.checkResult, "it rolled");
  assert.equal(r.attemptResult.success, false, "and it can fail on a 1");
});

test("CONTROL: an attempt with NO item claim is unaffected by the possession check", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const r = resolveAttemptAction(run, { type: "attempt", actorId: "player", intent: "climb the crumbling wall" }, {
    fixedRoll: 15, now: "2026-01-01T00:00:00.000Z",
    attemptProviderFn: () => ({ summary: "x", recommendedAbility: "strength", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "up", failureNarration: "slip", proposedEffects: [] })
  });
  assert.notEqual(r.attemptResult.unpossessed, true);
  assert.ok(r.attemptResult.checkResult, "rolled normally");
});

// ── contract: requiredItem validates ─────────────────────────────────────────
test("validateAttemptProviderOutput accepts requiredItem and rejects a malformed one", () => {
  const base = { summary: "s", successNarration: "ok", failureNarration: "no", proposedEffects: [] };
  assert.equal(validateAttemptProviderOutput({ ...base, requiredItem: { name: "brass key", specific: true } }).ok, true);
  assert.equal(validateAttemptProviderOutput({ ...base, requiredItem: null }).ok, true);
  assert.equal(validateAttemptProviderOutput({ ...base, requiredItem: { specific: true } }).ok, false, "name is required");
  assert.equal(validateAttemptProviderOutput({ ...base, requiredItem: { name: "x", specific: "yes" } }).ok, false, "specific must be boolean");
});
