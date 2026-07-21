// W3 — THE MISSING RUNGS. Bandits (rung 2, the social-capable tier) with the social-
// combat bridge, and the demon (rung 4, very rare). Stat rows load, placements land,
// parley is suppressed to lawful moments, its four outcomes commit, and the demon fires
// its high-tier skills.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveStatBlock } from "../server/campaign/bestiary.js";
import { loadScenarioFile, loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { canParley, parleyAffordances, resolveParley } from "../server/solo/parley.js";

function babelRun() {
  const run = createDefaultSoloRun({ runId: "rungs" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

// ── stat rows ──────────────────────────────────────────────────────────────
test("BANDIT rung: three human, social-capable, adult rows load (Law-6 budgets)", () => {
  for (const id of ["bandit_scavenger", "bandit_enforcer", "bandit_knife"]) {
    const b = resolveStatBlock(id);
    assert.ok(b, `${id} loads`);
    assert.equal(b.kind, "bandit");
    assert.equal(b.socialCapable, true, `${id} is social-capable`);
    assert.equal(b.ageClass, "adult");
    assert.ok(b.tags.includes("human"), `${id} is human`);
    assert.ok(b.tier >= 1 && b.tier <= 2, `${id} is human-tier`);
  }
});

test("DEMON rung: the Rapture-Drifter loads, tier 4, 2 high-tier chaos skills, violet", () => {
  const d = resolveStatBlock("rapture_drifter");
  assert.ok(d);
  assert.equal(d.kind, "demon");
  assert.equal(d.tier, 4);
  assert.equal(d.sightReadable, true, "sight-readable");
  const high = (d.carriedSkills || []).filter((s) => s.tier === "high");
  assert.ok(high.length >= 2, "carries 2+ high-tier chaos skills");
  const ids = high.map((s) => s.skillId);
  assert.ok(ids.includes("telepathy"), "telepathy intent-mask");
  assert.ok(ids.includes("charm-person") || ids.includes("vision-share"), "charm/vision-share");
  assert.equal(d.corruption.palette, "violet", "heavy violet corruption (the purple law)");
  // its skill intents fire in the resolver (kind:"skill" intents present)
  assert.ok(d.intents.some((i) => i.kind === "skill"), "skill intents present for the resolver");
});

// ── placement + discoverability ──────────────────────────────────────────────
test("placements: bandit ambush at the Drowned Highway (essence-free); demon far-POI (violet trail); rumor discoverable", () => {
  const s = loadScenarioFile("babel");
  const P = s.bestiary.placements;
  const bandits = P.filter((p) => /^bandit_/.test(p.statBlockId));
  assert.ok(bandits.length >= 1, "a bandit ambush is placed");
  assert.ok(bandits.every((p) => p.locationRef === "loc_drowned_highway"), "at the Drowned Highway underpass");
  assert.ok(bandits.every((p) => !p.essenceTrail), "humans carry NO chaos essence trail");
  const demon = P.find((p) => p.statBlockId === "rapture_drifter");
  assert.ok(demon, "the demon is placed");
  assert.equal(demon.locationRef, "loc_stillborn_field", "far-POI territory, not the starter road");
  assert.ok(demon.essenceTrail && demon.essenceTrail.palette === "violet", "heavy violet essence trail");
  // discoverable via a rumor on kept ground (no forced encounter)
  const rumor = (s.locations.loc_ranger_station_9.searchDetails || []).find((d) => /drifter|rapture|walks/i.test(d.description));
  assert.ok(rumor, "a rumor commits the dread without forcing the encounter");
});

// ── the social-combat bridge: SUPPRESSION ────────────────────────────────────
test("parley SUPPRESSION: never mid-swing, never for a non-social foe, never the dead", () => {
  const combat = { activeActor: "player" };
  const bandit = { socialCapable: true, morale: "steady", hp: { current: 10 } };
  const beast = { socialCapable: false, morale: "broken", hp: { current: 3 } };
  // mid-swing is always suppressed
  assert.equal(canParley(combat, bandit, { midSwing: true }), false, "no parley mid-swing");
  // a non-social foe never parleys
  assert.equal(canParley(combat, beast, { playerInitiated: true }), false, "beasts don't parley");
  // a dead foe never parleys
  assert.equal(canParley(combat, { socialCapable: true, morale: "broken", hp: { current: 0 } }, {}), false);
  // steady morale + no player initiative → NO window (their break or the player opens it)
  assert.equal(canParley(combat, bandit, {}), false, "no window at steady morale without player initiative");
  // LAWFUL: the enemy's morale breaks
  assert.equal(canParley(combat, { socialCapable: true, morale: "broken", hp: { current: 4 } }, {}), true, "lawful at their break");
  // LAWFUL: the player opens it on their own turn
  assert.equal(canParley(combat, bandit, { playerInitiated: true }), true, "lawful when the player opens it");
  assert.equal(canParley({ activeActor: "enemy" }, bandit, { playerInitiated: true }), false, "not on the enemy's turn");
  // and the affordances respect the gate
  assert.deepEqual(parleyAffordances(combat, bandit, { midSwing: true }), [], "no affordances mid-swing");
  assert.ok(parleyAffordances(combat, bandit, { playerInitiated: true }).length === 3, "three lawful affordances");
});

// ── the four committed outcomes: mercy AND murder both remembered ─────────────
test("parley OUTCOMES commit: surrender, spare/kill (reputation + Ledger), fled", () => {
  // a committed babel faction so the reputation ripple resolves (poachers = bandit-adjacent)
  const enemy = { npcId: "npc_bandit", combatantId: "c1", factionId: "faction_poachers_yard", socialCapable: true, morale: "broken", hp: { current: 3 } };

  // surrender demanded (success) → they yield, awaiting spare/kill
  const run1 = babelRun();
  const surr = resolveParley(run1, {}, enemy, { choice: "demand_surrender", contest: "success" });
  assert.equal(surr.outcome, "surrendered");
  assert.equal(surr.awaiting, "spare_or_kill");
  assert.ok(run1.ledger.some((e) => e.event === "surrendered" && e.remembered), "surrender is remembered");

  // SPARE (mercy) → faction remembers restraint (+); Ledger records mercy
  const run2 = babelRun();
  const spare = resolveParley(run2, {}, enemy, { choice: "spare" });
  assert.equal(spare.outcome, "spared");
  assert.ok(spare.reputation.length > 0, "sparing moves faction reputation (+)");
  assert.ok(run2.ledger.some((e) => e.event === "spared" && e.remembered), "MERCY is remembered");

  // KILL a yielding foe (murder) → faction hit (-); Ledger records murder
  const run3 = babelRun();
  const kill = resolveParley(run3, {}, enemy, { choice: "kill" });
  assert.equal(kill.outcome, "killed");
  assert.ok(kill.reputation.length > 0, "murder moves faction reputation (-)");
  assert.ok(run3.ledger.some((e) => e.event === "killed_surrendered" && e.remembered), "MURDER is remembered");

  // intimidate (success) → they BREAK and flee, committed as fled (thread-seed)
  const run4 = babelRun();
  const flee = resolveParley(run4, {}, { ...enemy, morale: "wavering" }, { choice: "intimidate", contest: "success" });
  assert.equal(flee.outcome, "fled");
  assert.ok(run4.ledger.some((e) => e.event === "fled"), "the fled bandit is committed as fled");

  // a failed contest resumes the fight (no free outcome)
  const run5 = babelRun();
  assert.equal(resolveParley(run5, {}, enemy, { choice: "intimidate", contest: "failure" }).outcome, "provoked");
  assert.equal(resolveParley(run5, {}, enemy, { choice: "demand_surrender", contest: "failure" }).outcome, "refused");
});
