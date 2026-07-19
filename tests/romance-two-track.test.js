// ROMANCE TWO-TRACK + GATES + REJECTION + LIGHTNING (romance-legacy-law R1/R5/R8/R4).
// The affection meter accrues freely; the romance TRACK is switch+gate gated; a
// rebuffed initiation resolves to one of four deterministic outcomes; extraordinary
// deeds land bounded affection surges. ZERO model calls.
import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveRomanceTier,
  selectRejectionOutcome,
  lightningStrikeDelta,
  LIGHTNING_STRIKE_MAX,
  REJECTION_OUTCOMES,
  individualReputation
} from "../server/solo/reputation.js";
import {
  openRomanceTrack,
  pendingRomanceGate,
  commitRomanceGate,
  commitRomanceRejection,
  applyLightningStrike,
  applyRomanceTurn,
  detectRomanticOpen
} from "../server/solo/relationships.js";
import { dispositionCueText } from "../src/components/soloSceneShell.js";

const ID = () => "x";
function run(affection = 0, extra = {}) {
  return {
    worldSeed: "W", currentLocationId: "L",
    npcs: { n1: { npcId: "n1", generatedName: "Wren", ageClass: "adult", romanceable: true, station: "common", ...(extra.npc || {}) } },
    relationships: { rel: { relationshipId: "rel", sourceEntityId: "player", targetEntityId: "n1", meters: { affection, trust: 0, fear: 0, suspicion: extra.suspicion || 0, rivalry: 0, debt: 0, loyalty: 0 }, affinity: extra.affinity ?? affection, memoryFactIds: extra.history || [], flags: {}, romanceOpen: extra.romanceOpen || false, romanceGatesPassed: extra.gates || [] } }
  };
}
const relOf = (r) => r.relationships.rel;
const npcOf = (r) => r.npcs.n1;

// ── R1: SWITCH GATING ────────────────────────────────────────────────────────
test("R1: high affection WITHOUT the switch is PARKED at close (meter holds, door needs the knock)", () => {
  const r = run(50); // well past the courting(32)/partner(44) thresholds
  assert.equal(effectiveRomanceTier(relOf(r), npcOf(r)), "close", "parked at close, not courting/partner");
  assert.equal(individualReputation(r, "n1").romanceTier, "close");
  assert.equal(individualReputation(r, "n1").romanceOpen, false);
});

test("R1: friendship tiers below the threshold are the raw platonic tier (no gating)", () => {
  assert.equal(effectiveRomanceTier(run(0).relationships.rel, run(0).npcs.n1), "stranger");
  assert.equal(effectiveRomanceTier(run(10).relationships.rel, run(10).npcs.n1), "friendly");
  assert.equal(effectiveRomanceTier(run(24).relationships.rel, run(24).npcs.n1), "close");
});

// ── R1: BOTH INITIATION DOORS ────────────────────────────────────────────────
test("R1 door A (player): explicit romantic intent opens the switch; charm/flirt-only does not auto-promote", () => {
  assert.equal(detectRomanticOpen("I confess my feelings to Wren"), true);
  assert.equal(detectRomanticOpen("I court Wren"), true);
  assert.equal(detectRomanticOpen("I intimidate the guard"), false);
  const r = run(50);
  const res = openRomanceTrack(r, "n1", { initiator: "player", idFactory: ID });
  assert.equal(res.opened, true);
  assert.equal(relOf(r).romanceOpen, true);
  assert.equal(relOf(r).romanceOpenedBy, "player");
});

test("R1 door B (NPC crush accepted): openRomanceTrack initiator:'npc' opens the switch", () => {
  const r = run(50);
  const res = openRomanceTrack(r, "n1", { initiator: "npc", idFactory: ID });
  assert.equal(res.opened, true);
  assert.equal(relOf(r).romanceOpenedBy, "npc");
});

test("R1: an ineligible NPC never opens a romance track", () => {
  const r = run(50, { npc: { ageClass: "child", romanceable: false } });
  assert.equal(openRomanceTrack(r, "n1", { idFactory: ID }).opened, false);
  assert.equal(effectiveRomanceTier(relOf(r), npcOf(r)), null);
});

// ── R5: GATE EVENT BEFORE PROMOTION ──────────────────────────────────────────
test("R5: promotion past close requires a GATE EVENT even with the switch open", () => {
  const r = run(50, { romanceOpen: true });
  assert.equal(effectiveRomanceTier(relOf(r), npcOf(r)), "close", "switch open + meter high, but no gate → still close");
  const owed = pendingRomanceGate(r, "n1");
  assert.equal(owed.tier, "courting");
  assert.ok(owed.beat && /ROMANCE GATE/.test(owed.beat.directive), "the gate is a committed beat with a narration directive");
  const g = commitRomanceGate(r, "n1", "courting", { idFactory: ID });
  assert.equal(g.romanceTierBefore, "close");
  assert.equal(g.romanceTier, "courting", "promotion resolves AFTER the gate");
  // partner needs its own gate (and courting first)
  assert.equal(effectiveRomanceTier(relOf(r), npcOf(r)), "courting", "still courting until the partner gate");
  assert.equal(commitRomanceGate(run(50, { romanceOpen: true }).relationships.rel && r, "n1", "partner", { idFactory: ID }).romanceTier, "partner");
});

test("R5: partner gate is refused before the courting gate (ordering)", () => {
  const r = run(50, { romanceOpen: true });
  assert.equal(commitRomanceGate(r, "n1", "partner", { idFactory: ID }), null, "no partner gate before courting");
});

// ── R8: FOUR REJECTION OUTCOMES, DETERMINISTIC ───────────────────────────────
test("R8: rejection selection is DETERMINISTIC per seed", () => {
  const r = run(15, { history: ["f1"] });
  for (let s = 0; s < 60; s++) {
    assert.equal(selectRejectionOutcome(relOf(r), npcOf(r), s), selectRejectionOutcome(relOf(r), npcOf(r), s));
  }
});

test("R8: all four outcomes are reachable from committed disposition × history", () => {
  const states = [
    { affinity: -15, suspicion: 0, history: [] },
    { affinity: 5, suspicion: 12, history: [] },
    { affinity: 30, suspicion: 0, history: ["a", "b", "c"] },
    { affinity: 15, suspicion: 0, history: ["a"] },
    { affinity: 5, suspicion: 0, history: [] }
  ];
  const seen = new Set();
  for (const st of states) {
    const r = run(st.affinity, { affinity: st.affinity, suspicion: st.suspicion, history: st.history });
    for (let s = 0; s < 80; s++) seen.add(selectRejectionOutcome(relOf(r), npcOf(r), s));
  }
  for (const o of REJECTION_OUTCOMES) assert.ok(seen.has(o), `outcome '${o}' is reachable`);
});

test("R8: commitRomanceRejection commits the outcome's effect + closes the switch (deterministic)", () => {
  // grudge: hostile disposition → suspicion up, affinity down
  const rg = run(-15, { affinity: -15, romanceOpen: true });
  const g = commitRomanceRejection(rg, "n1", { seed: "S", idFactory: ID });
  assert.equal(g.outcome, "grudge");
  assert.ok(relOf(rg).meters.suspicion > 0 && relOf(rg).affinity < -15);
  assert.equal(relOf(rg).romanceOpen, false, "the switch closes on rejection");
  // determinism: same seed + state → same outcome
  const rg2 = run(-15, { affinity: -15, romanceOpen: true });
  assert.equal(commitRomanceRejection(rg2, "n1", { seed: "S", idFactory: ID }).outcome, "grudge");
  // torch: warm + deep history → a secret covert-watching thread-seed
  let torch = null;
  for (let s = 0; s < 80 && !torch; s++) {
    const rt = run(30, { affinity: 30, history: ["a", "b", "c"], romanceOpen: true });
    const res = commitRomanceRejection(rt, "n1", { seed: `t${s}`, idFactory: ID });
    if (res.outcome === "torch") { torch = res; assert.ok(relOf(rt).flags.torch?.secret === true && relOf(rt).flags.torch?.hook === "covert-watching"); }
  }
  assert.ok(torch, "a torch outcome commits a secret thread-seed");
});

// ── R4: LIGHTNING-STRIKE BOUNDS ──────────────────────────────────────────────
test("R4: extraordinary deeds land bounded affection surges (never exceed the ceiling)", () => {
  for (const deed of ["faction-saved", "family-saved", "heirloom-returned", "life-saved", "home-defended", "great-shame-lifted"]) {
    assert.ok(lightningStrikeDelta(deed) > 0 && lightningStrikeDelta(deed) <= LIGHTNING_STRIKE_MAX, `${deed} bounded`);
  }
  assert.equal(lightningStrikeDelta("stubbed-toe"), 0, "an ordinary deed carries no lightning delta");
  const r = run(10, { affinity: 10 });
  const res = applyLightningStrike(r, "n1", "family-saved", { idFactory: ID });
  assert.equal(res.delta, 22);
  assert.ok(res.affectionAfter - res.affectionBefore <= LIGHTNING_STRIKE_MAX);
});

// ── A5: PLATONIC CUE VOCABULARY BELOW THE SWITCH ─────────────────────────────
test("A5: friendship-track crossings use PLATONIC vocabulary; romance tiers use the romantic register", () => {
  const toClose = dispositionCueText({ targetName: "Wren", romanceTierBefore: "friendly", romanceTier: "close" });
  assert.match(toClose, /friend/i, "close crossing reads platonic (friend)");
  assert.doesNotMatch(toClose, /deepened|romance|love|lover/i, "no romance-coded language below the switch");
  const toFriendly = dispositionCueText({ targetName: "Wren", romanceTierBefore: "stranger", romanceTier: "friendly" });
  assert.match(toFriendly, /warming/i);
  assert.doesNotMatch(toFriendly, /deepened|romance|love/i);
  // above the switch → romantic register
  const toCourting = dispositionCueText({ targetName: "Wren", romanceTierBefore: "close", romanceTier: "courting" });
  assert.match(toCourting, /deepened/i);
});

// ── R1/R5 integration through applyRomanceTurn (the attempt hook) ─────────────
test("integration: applyRomanceTurn opens on a romantic intent then fires the gate when the meter is ready", () => {
  const r = run(50); // meter already past courting
  const res = applyRomanceTurn(r, { intent: "I confess my love to Wren", targetId: "n1", success: true, dispositionChange: { targetNpcId: "n1" }, idFactory: ID });
  assert.ok(res.opened?.opened, "the switch opened");
  assert.ok(res.gate && res.gate.tier === "courting", "the courting gate fired the same turn");
  assert.equal(individualReputation(r, "n1").romanceTier, "courting");
});
