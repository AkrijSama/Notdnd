// ABSENT-TARGET REFUSAL — Finding #2 regression net (the phantom-hostile moat leak).
// A per-verb net: an intent that names an AGENT not present/committed must produce a
// diegetic REFUSAL and commit NO state (no npc minted, no combat opened, no hp delta,
// no clock tick). Plus the pre-mortem (a) guard: a PRESENT target is never refused.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { detectAbsentTargetRefusal } from "../server/solo/absentTarget.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
function babelRun(loc = "start_location") {
  const run = createDefaultSoloRun({ runId: "phantom_fixed", now: T(0) });
  run.worldSeed = "phantom_fixed";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  run.currentLocationId = loc;
  return run;
}
const attempt = (run, intent) => resolveSoloAction(run, { type: "attempt", actorId: "player", intent }, { now: T(1) });

function assertRefusedNoState(run, intent, mustSay) {
  const npcsBefore = Object.keys(run.npcs).length;
  const hpBefore = run.player?.resources?.hitPoints?.current;
  const dayBefore = run.world?.time?.minutes;
  const r = attempt(run, intent);
  assert.equal(r.ok, true, "a refusal is ok:true, never a system error");
  assert.equal(r.attemptResult?.gated, true, `"${intent}" must be gated as a refusal`);
  assert.equal(r.attemptResult?.consequence?.type, "refused", "the consequence is a refusal, not a graded success");
  assert.equal(r.attemptResult?.success, false, "a phantom target is never a success");
  if (mustSay) assert.match(r.attemptResult.narration, mustSay, `diegetic line for "${intent}"`);
  // NO STATE: run untouched (result carries no cloned run), so nothing minted/opened/lost.
  assert.equal(r.run, undefined, "a refusal commits no run mutation");
  assert.equal(Object.keys(run.npcs).length, npcsBefore, "no phantom npc minted");
  assert.ok(!run.combat || run.combat.status !== "active", "no combat opened");
  assert.equal(run.player?.resources?.hitPoints?.current, hpBefore, "no hp delta");
  assert.equal(run.world?.time?.minutes, dayBefore, "no world-clock tick (a refusal costs no turn)");
  // LIFECYCLE: the player is never stranded — valid next moves are offered.
  assert.ok(Array.isArray(r.availableActions), "the refusal still offers actions (no dead-end)");
  return r;
}

// ── the whole verb class (contract rule 6: patch the class, not one verb) ──────
test("attack: an absent creature is refused, not manufactured (THE Finding #2 bug)", () => {
  assertRefusedNoState(babelRun(), "attack the wolf", /no wolf here to attack/i);
});
test("engage: 'face the wolf' with no wolf present is refused", () => {
  assertRefusedNoState(babelRun(), "face the wolf", /no wolf here/i);
});
test("talk-to: an absent person is refused", () => {
  assertRefusedNoState(babelRun(), "talk to the merchant", /no one here to talk to/i);
});
test("follow: an absent person is refused", () => {
  assertRefusedNoState(babelRun(), "follow the guard", /no one here to follow/i);
});
test("steal-from: an absent person is refused", () => {
  assertRefusedNoState(babelRun(), "steal from the guard", /no one here to steal from/i);
});
test("give-to: an absent recipient is refused", () => {
  assertRefusedNoState(babelRun(), "give the key to the guard", /no one here to give/i);
});
test("flee-from: an absent threat is refused", () => {
  assertRefusedNoState(babelRun(), "flee from the wolf", /nothing here to flee from/i);
});
test("ambush: an absent target is refused", () => {
  assertRefusedNoState(babelRun(), "ambush the bandit", /no one here to ambush/i);
});
test("named agent: attacking a proper-named absent NPC is refused by name", () => {
  assertRefusedNoState(babelRun(), "attack Goran", /no Goran here/i);
});

// ── pre-mortem (a): a PRESENT target is NEVER refused ─────────────────────────
test("PRE-MORTEM (a): a present hostile is NOT refused (attack routes to combat, never a phantom refusal)", () => {
  const run = babelRun("loc_waking_mile"); // babel places the Limping Grey here
  const grey = Object.values(run.npcs).find((n) => n.flags?.hostile === true);
  assert.ok(grey, "babel must place a hostile at the Waking Mile for this guard to mean anything");
  // The gate itself must DEFER (return null) when a hostile is present.
  assert.equal(detectAbsentTargetRefusal(run, "attack the grey"), null, "a present hostile is never a phantom");
  assert.equal(detectAbsentTargetRefusal(run, "attack the wolf"), null, "a generic reference with a hostile present defers");
  const r = attempt(run, "attack the grey");
  assert.notEqual(r.attemptResult?.gateCategory, "phantom_hostile", "a present hostile must never hit the phantom gate");
});

test("PRE-MORTEM (a): a present NPC named by a DIFFERENT alias is not refused when the token matches", () => {
  const run = babelRun();
  run.npcs.npc_local = { npcId: "npc_local", displayName: "Warden Cole", currentLocationId: "start_location", status: "present", flags: {} };
  assert.equal(detectAbsentTargetRefusal(run, "talk to the warden"), null, "'warden' token-matches Warden Cole — never refuse a present person");
});

// ── the feature carve-out: an object is a swing, not a phantom ────────────────
test("a non-agent feature ('attack the door') is NOT refused — it falls through to a swing", () => {
  assert.equal(detectAbsentTargetRefusal(babelRun(), "attack the door"), null, "a door is a feature, not a committed agent");
  assert.equal(detectAbsentTargetRefusal(babelRun(), "attack the wall"), null);
});

// ── interrogatives are not attacks on a phantom ──────────────────────────────
test("a QUESTION about an absent creature is not gated as a phantom attack", () => {
  // The actions.js wiring gates the refusal on !interrogative; the detector itself is
  // verb-shaped, so a bare question ("is there a wolf here?") carries no attack verb.
  assert.equal(detectAbsentTargetRefusal(babelRun(), "is there a wolf here?"), null);
});
