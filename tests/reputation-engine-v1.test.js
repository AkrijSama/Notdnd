import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun, validateFactionState, createEmptyExpressionVariants } from "../server/solo/schema.js";
import {
  tierForAffinity, factionTierForStanding, romanceTierForAffection,
  preferenceWeight, computeWeightedDelta,
  ensureFaction, applyFactionStanding, seedFactions, loadFactionsFromJson,
  mintNpcReputation, migrateReputation, recomputeIndividualTiers,
  applyReputationEffects, individualReputation, detectRomanceRegisterViolations,
  romanceableDefault, isAdult, isRomanceEligible, normalizeAgeClass, romanceCeilingForRun
} from "../server/solo/reputation.js";
import { commitSocialDisposition, commitGift } from "../server/solo/relationships.js";
import { resolveThreadLifecycle } from "../server/solo/threads.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { buildOocGroundingContext } from "../server/gm/oocGrounding.js";

// reputation-engine-v1 tests-of-record: table-driven tiers, Stardew preference
// weighting, Qud one-hop ripple, B2 migration, romance gating + SFW auditor,
// resume-safety.

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

function makeNpc(npcId, over = {}) {
  return {
    npcId, displayName: over.displayName || npcId, role: over.role || "stranger",
    known: over.known ?? true, status: over.status || "present",
    currentLocationId: over.currentLocationId || "start_location",
    memoryFactIds: [], expressionVariants: createEmptyExpressionVariants(),
    tags: [], flags: {}, dialogueBeats: [],
    ...over
  };
}
function setRel(run, npcId, meters = {}) {
  const full = { trust: 0, affection: 0, fear: 0, debt: 0, suspicion: 0, loyalty: 0, rivalry: 0, ...meters };
  run.relationships[`rel_${npcId}`] = {
    relationshipId: `rel_${npcId}`, sourceEntityId: "player", targetEntityId: npcId,
    meters: full, memoryFactIds: [], flags: {}
  };
  return run.relationships[`rel_${npcId}`];
}

// ── tier computation from the (data) table ────────────────────────────────────
test("tiers compute from the threshold tables", () => {
  assert.equal(tierForAffinity(-20), "hostile");
  assert.equal(tierForAffinity(-5), "wary");
  assert.equal(tierForAffinity(0), "neutral");
  assert.equal(tierForAffinity(15), "warm");
  assert.equal(tierForAffinity(30), "trusted");
  assert.equal(tierForAffinity(60), "devoted");
  assert.equal(factionTierForStanding(-40), "hated");
  assert.equal(factionTierForStanding(-5), "unwelcome");
  assert.equal(factionTierForStanding(25), "respected");
  assert.equal(factionTierForStanding(50), "honored");
  assert.equal(romanceTierForAffection(0), "stranger");
  assert.equal(romanceTierForAffection(10), "friendly");
  assert.equal(romanceTierForAffection(25), "close");
  assert.equal(romanceTierForAffection(35), "courting");
  assert.equal(romanceTierForAffection(48), "partner");
});

// ── preference weighting math (Stardew) ───────────────────────────────────────
test("preference weighting sums matching tag weights; neutral base when none match", () => {
  const prefs = [{ tag: "rare-herb", weight: 3 }, { tag: "violence", weight: -2 }];
  assert.equal(preferenceWeight(prefs, ["rare-herb"]), 3);
  assert.equal(preferenceWeight(prefs, ["violence"]), -2);
  assert.equal(preferenceWeight(prefs, ["unrelated"]), 1);
  assert.equal(preferenceWeight(prefs, []), 1);
  assert.equal(computeWeightedDelta(prefs, ["rare-herb"], 2), 6);
  assert.equal(computeWeightedDelta(prefs, ["violence"], 2), -4);
  assert.equal(computeWeightedDelta(prefs, ["unrelated"], 2), 2);
});

// ── gift: matched vs mismatched deltas (acceptance i) ─────────────────────────
test("a gift matching a preference beats a mismatched gift, priced by weight; item is consumed", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.npcs.npc_mara = makeNpc("npc_mara", { displayName: "Mara", preferences: [{ tag: "rare-herb", weight: 3 }], romanceable: false });
  run.inventory.item_herb = { itemId: "item_herb", name: "Rare Herb", quantity: 1, tags: ["rare-herb"], flags: {} };
  run.inventory.item_rock = { itemId: "item_rock", name: "Plain Rock", quantity: 1, tags: ["stone"], flags: {} };

  const matched = commitGift(run, { npcId: "npc_mara", itemId: "item_herb" });
  const mismatched = commitGift(run, { npcId: "npc_mara", itemId: "item_rock" });
  assert.equal(matched.weight, 3);
  assert.equal(matched.delta, 6); // base 2 × weight 3
  assert.equal(mismatched.weight, 1);
  assert.equal(mismatched.delta, 2); // base 2 × neutral 1
  assert.ok(matched.delta > mismatched.delta);
  assert.equal(run.inventory.item_herb, undefined); // transferred out of the pack
  assert.equal(run.inventory.item_rock, undefined);
  assert.equal(validateSoloRun(run).ok, true);
});

// ── one-hop ripple, no cascade (acceptance ii) ────────────────────────────────
test("a faction delta ripples ONE hop through relations; it does not cascade", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  ensureFaction(run, "faction_a", { name: "A", relations: [{ factionId: "faction_b", modifier: -0.5 }] });
  ensureFaction(run, "faction_b", { name: "B", relations: [{ factionId: "faction_c", modifier: -0.5 }] });
  ensureFaction(run, "faction_c", { name: "C" });

  const before = { a: run.factions.faction_a.standing, b: run.factions.faction_b.standing, c: run.factions.faction_c.standing };
  const r = applyFactionStanding(run, "faction_a", 10);
  assert.deepEqual(before, { a: 0, b: 0, c: 0 });
  assert.equal(run.factions.faction_a.standing, 10); // primary
  assert.equal(run.factions.faction_b.standing, -5); // 10 × -0.5, one hop
  assert.equal(run.factions.faction_c.standing, 0); // b→c did NOT fire (no cascade)
  assert.equal(r.ripples.length, 1);
  assert.equal(run.factions.faction_a.tier, "neutral");
  assert.equal(validateSoloRun(run).ok, true);
});

// ── B2 data migration ─────────────────────────────────────────────────────────
test("migration aggregates affinity from committed trust+affection without discarding meters", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.npcs.npc_x = makeNpc("npc_x");
  const legacy = setRel(run, "npc_x", { trust: 10, affection: 8, fear: 3 });
  delete legacy.affinity; // a pre-reputation B2 record
  const res = migrateReputation(run);
  assert.equal(res.migrated, 1);
  assert.equal(run.relationships.rel_npc_x.affinity, 18); // trust 10 + affection 8
  assert.equal(run.relationships.rel_npc_x.tier, "warm"); // 18 → warm
  assert.equal(run.relationships.rel_npc_x.meters.fear, 3); // meters preserved
  assert.equal(validateSoloRun(run).ok, true);
  assert.equal(migrateReputation(run).migrated, 0); // idempotent
});

// ── romance-tier gating + SFW auditor (acceptance iii) ────────────────────────
test("romanceTier gates on affection and only when romanceable", () => {
  const rel = { meters: { affection: 25, trust: 0 }, affinity: 25 };
  recomputeIndividualTiers(rel, { ageClass: "adult", romanceable: true });
  assert.equal(rel.romanceTier, "close");
  recomputeIndividualTiers(rel, { ageClass: "adult", romanceable: false });
  assert.equal(rel.romanceTier, null);
});

test("the SFW auditor: physical romance below courting flags; explicit flags at every tier", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.npcs.npc_lover = makeNpc("npc_lover", { displayName: "Aria", ageClass: "adult", romanceable: true, currentLocationId: "start_location" });

  // low affection (stranger) — warm rapport is clean, a kiss is over-tier
  setRel(run, "npc_lover", { affection: 2 });
  assert.equal(detectRomanceRegisterViolations("She smiles warmly and thanks you for your kindness.", run).length, 0);
  const overTier = detectRomanceRegisterViolations("She pulls you close and kisses you passionately.", run);
  assert.ok(overTier.some((v) => v.kind === "over-tier"));

  // high affection (partner) — a soft kiss is now permitted…
  setRel(run, "npc_lover", { affection: 48 });
  assert.equal(detectRomanceRegisterViolations("She kisses you softly and rests her head on your shoulder.", run).filter((v) => v.kind === "over-tier").length, 0);
  // …but explicit content is banned at EVERY tier (the SFW wall)
  assert.ok(detectRomanceRegisterViolations("They make love through the night.", run).some((v) => v.kind === "explicit"));
});

// ── thread reputationEffects on resolution ────────────────────────────────────
test("a resolving thread commits its reputationEffects once (faction ripples included)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  ensureFaction(run, "faction_a", { name: "A", relations: [{ factionId: "faction_b", modifier: -0.5 }] });
  ensureFaction(run, "faction_b", { name: "B" });
  run.threads.t1 = {
    threadId: "t1", kind: "danger", status: "active", beatIndex: 1,
    beats: [{ beatId: "b", status: "committed" }],
    resolution: [{ kind: "beat_final", outcome: "resolved" }],
    reputationEffects: [{ target: "faction_a", delta: 20 }],
    revealState: "revealed", groundedIn: { entityIds: [], locationIds: [], questIds: [], factIds: [] },
    flags: {}, clock: {}
  };
  const resolved = resolveThreadLifecycle(run, {}, { now: T(1) });
  assert.equal(resolved.length, 1);
  assert.equal(run.factions.faction_a.standing, 20); // effect applied
  assert.equal(run.factions.faction_b.standing, -10); // rippled one hop
  assert.equal(run.threads.t1.flags.reputationApplied, true);
  assert.ok(resolved[0].reputation);
  // re-running does not double-apply (thread no longer active + guard flag)
  resolveThreadLifecycle(run, {}, { now: T(2) });
  assert.equal(run.factions.faction_a.standing, 20);
});

// ── seeding + minting (deterministic) ─────────────────────────────────────────
test("worldgen seeds 2-4 factions and mints NPC preferences deterministically", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_rep";
  const s = seedFactions(run, { worldSeed: "seed_rep" });
  assert.ok(s.seeded.length >= 2 && s.seeded.length <= 4);
  assert.equal(validateSoloRun(run).ok, true);
  for (const f of Object.values(run.factions)) assert.equal(validateFactionState(f).ok, true);

  run.npcs.npc_a = makeNpc("npc_a");
  const m = mintNpcReputation(run);
  assert.ok(m.minted.includes("npc_a"));
  assert.ok(run.npcs.npc_a.preferences.length >= 1 && run.npcs.npc_a.preferences.length <= 3);
  assert.equal(typeof run.npcs.npc_a.romanceable, "boolean");
  // law R2: an adult NPC defaults romanceable=true (no faction required).
  assert.equal(run.npcs.npc_a.romanceable, true, "minted adult NPC defaults romanceable per law R2");

  // deterministic: same seed → same faction set
  const run2 = createDefaultSoloRun({ now: T(0) });
  run2.worldSeed = "seed_rep";
  seedFactions(run2, { worldSeed: "seed_rep" });
  assert.deepEqual(Object.keys(run.factions).sort(), Object.keys(run2.factions).sort());
  // idempotent
  assert.deepEqual(seedFactions(run, {}).seeded, []);
});

// ── the romance AGE WALL — fail-closed, stamped at mint (law R2) ───────────────
test("romanceableDefault is FAIL-CLOSED: romance needs an affirmative adult age-class", () => {
  // No age data → NOT romanceable. The wall never depends on a flag someone must set.
  assert.equal(romanceableDefault({ npcId: "unknown" }), false, "missing ageClass → fail-closed (not romanceable)");
  assert.equal(romanceableDefault({ npcId: "adult", ageClass: "adult" }), true, "an affirmed adult defaults romanceable");
  assert.equal(romanceableDefault({ npcId: "kid", ageClass: "child" }), false, "a child is excluded — absolute, no override");
  assert.equal(romanceableDefault({ npcId: "teen", ageClass: "adolescent" }), false, "any non-adult class is excluded");
  assert.equal(romanceableDefault({ npcId: "role", ageClass: "adult", tags: ["romance-excluded"] }), false, "world-book-excluded role opts out");
  assert.equal(romanceableDefault({ npcId: "vow", ageClass: "adult", tags: ["no-romance"] }), false, "no-romance tag opts out");
  assert.equal(romanceableDefault({ npcId: "authored", ageClass: "adult", romanceable: false }), false, "explicit romanceable:false override honored");
  assert.equal(romanceableDefault(null), false, "non-object → false, no throw");
});

test("isAdult / isRomanceEligible are strict: only the affirmative adult class passes", () => {
  assert.equal(isAdult({ ageClass: "adult" }), true);
  assert.equal(isAdult({ ageClass: "child" }), false);
  assert.equal(isAdult({}), false, "no ageClass → not adult (fail-closed)");
  assert.equal(isAdult(null), false);
  // Even a STRAY romanceable:true cannot bypass age — age is checked first.
  assert.equal(isRomanceEligible({ ageClass: "child", romanceable: true }), false, "child + stray romanceable:true still blocked");
  assert.equal(isRomanceEligible({ ageClass: "adult", romanceable: true }), true);
  assert.equal(isRomanceEligible({ ageClass: "adult", romanceable: false }), false);
  assert.equal(isRomanceEligible({ romanceable: true }), false, "no age data + romanceable:true → blocked");
});

test("normalizeAgeClass stamps adult by default; preserves an explicit class", () => {
  assert.equal(normalizeAgeClass(undefined), "adult", "procedural cast defaults adult");
  assert.equal(normalizeAgeClass(""), "adult");
  assert.equal(normalizeAgeClass("child"), "child", "explicit child preserved");
  assert.equal(normalizeAgeClass(" Adult "), "adult", "trimmed + lowercased");
});

test("mint STAMPS ageClass=adult and makes procedural adult cast romanceable; child stays excluded", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_age";
  seedFactions(run, { worldSeed: "seed_age" });
  run.npcs.npc_proc = makeNpc("npc_proc", { displayName: "Rook" });          // no ageClass supplied
  run.npcs.npc_kid = makeNpc("npc_kid", { displayName: "Pip", ageClass: "child" }); // affirmatively a child
  mintNpcReputation(run);
  assert.equal(run.npcs.npc_proc.ageClass, "adult", "procedural cast stamped adult at mint");
  assert.equal(run.npcs.npc_proc.romanceable, true, "adult procedural cast is romanceable per law R2");
  assert.equal(run.npcs.npc_kid.ageClass, "child", "explicit child age-class preserved");
  assert.equal(run.npcs.npc_kid.romanceable, false, "a child is never made romanceable");
});

test("THE WALL BITES EVERYWHERE: a child NPC is excluded at every romance enforcement point", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.currentLocationId = "start_location";
  // A worst case: a child carrying a STRAY romanceable:true, present, with high affection.
  run.npcs.npc_child = makeNpc("npc_child", {
    displayName: "Pip", ageClass: "child", romanceable: true,
    currentLocationId: "start_location", status: "present", known: true
  });
  run.relationships.rel_child = {
    relationshipId: "rel_child", sourceEntityId: "player", targetEntityId: "npc_child",
    affinity: 90, meters: { affection: 90, trust: 40 }
  };

  // 1. eligibility predicate
  assert.equal(isRomanceEligible(run.npcs.npc_child), false, "predicate: child not romance-eligible");
  // 2. the individualReputation VIEW (feeds scene payload + GM grounding + R10 clause)
  const view = individualReputation(run, "npc_child");
  assert.equal(view.romanceable, false, "view: romanceable false for the child");
  assert.equal(view.romanceTier, null, "view: no romanceTier for the child (R10 boundary clause never builds)");
  // 3. the romance-track switch / gift-affection routing (recomputeIndividualTiers)
  recomputeIndividualTiers(run.relationships.rel_child, run.npcs.npc_child);
  assert.equal(run.relationships.rel_child.romanceTier, null, "gift/social affection never opens a romance track for a child");
  // 4. the R10 register CEILING (present-romanceable scan)
  assert.equal(romanceCeilingForRun(run).rank, -1, "child raises no romance-register ceiling");

  // Positive control: an ADULT in the same state DOES pass every gate (guards against a dead test).
  run.npcs.npc_adult = makeNpc("npc_adult", {
    displayName: "Vera", ageClass: "adult", romanceable: true,
    currentLocationId: "start_location", status: "present", known: true
  });
  run.relationships.rel_adult = {
    relationshipId: "rel_adult", sourceEntityId: "player", targetEntityId: "npc_adult",
    affinity: 90, meters: { affection: 90, trust: 40 }
  };
  assert.equal(isRomanceEligible(run.npcs.npc_adult), true, "control: adult is romance-eligible");
  assert.equal(individualReputation(run, "npc_adult").romanceable, true, "control: adult romanceable in view");
  assert.ok(romanceCeilingForRun(run).rank >= 0, "control: adult raises a real ceiling");
});

// ── social affinity is preference-weighted ────────────────────────────────────
test("a social win moves the running affinity, weighted by the target's preferences", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  // a violence-averse NPC: even a successful intimidation costs affinity
  run.npcs.npc_g = makeNpc("npc_g", { displayName: "Guard", preferences: [{ tag: "violence", weight: -2 }] });
  const r = commitSocialDisposition(run, { intent: "intimidate the guard into talking", targetId: "npc_g", band: "success", success: true }, { idFactory: () => "x" });
  assert.equal(r.meter, "fear");
  assert.ok(r.affinityDelta < 0, "violence-averse target's affinity drops on intimidation");
  assert.equal(typeof r.tier, "string");
});

// ── authored JSON load ────────────────────────────────────────────────────────
test("authored worlds load factions as plain JSON (same authorability law as threads)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  const res = loadFactionsFromJson(run, [
    { factionId: "f_guild", name: "Guild", standing: 5, preferences: [{ tag: "craft", weight: 3 }], relations: [{ factionId: "f_court", modifier: 0.5 }] },
    { factionId: "f_court", name: "Court", standing: 0 }
  ], {});
  assert.deepEqual(res.loaded.sort(), ["f_court", "f_guild"]);
  assert.equal(run.factions.f_guild.standing, 5);
  assert.equal(run.factions.f_guild.tier, "neutral");
  assert.equal(validateSoloRun(run).ok, true);
});

// ── scene payload + OOC surfacing (visibility-gated) ──────────────────────────
test("scene payload surfaces met-NPC tiers + discovered-faction tiers; hidden stay hidden", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.npcs.npc_met = makeNpc("npc_met", { displayName: "Bram", known: true, preferences: [{ tag: "coin", weight: 2 }], ageClass: "adult", romanceable: true });
  setRel(run, "npc_met", { trust: 5, affection: 10 });
  migrateReputation(run);
  ensureFaction(run, "faction_seen", { name: "Seen Order", standing: 25, discovered: true });
  ensureFaction(run, "faction_hidden", { name: "Hidden Cabal", standing: -30, discovered: false });

  const scene = buildSoloScenePayload(run, {});
  const met = scene.reputation.individuals.find((i) => i.npcId === "npc_met");
  assert.ok(met);
  assert.equal(met.tier, "warm"); // affinity 15 → warm
  assert.equal(met.romanceTier, "friendly"); // affection 10 → friendly
  const seen = scene.reputation.factions.find((f) => f.factionId === "faction_seen");
  assert.ok(seen && seen.tier === "respected"); // standing 25
  assert.equal(scene.reputation.factions.find((f) => f.factionId === "faction_hidden"), undefined); // undiscovered
});

test("OOC answers 'where do I stand with X' from committed standings (acceptance iv)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.npcs.npc_met = makeNpc("npc_met", { displayName: "Bram", known: true });
  setRel(run, "npc_met", { trust: 20, affection: 5 });
  migrateReputation(run);
  ensureFaction(run, "faction_charter", { name: "The Charter", standing: 30, discovered: true });
  const ctx = buildOocGroundingContext(run);
  assert.match(ctx, /STANDINGS/);
  assert.match(ctx, /Bram/);
  assert.match(ctx, /The Charter/);
  assert.match(ctx, /respected/); // faction standing 30 → respected
});

// ── resume-safety ─────────────────────────────────────────────────────────────
test("standings survive a JSON round-trip and keep validating", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_rp";
  seedFactions(run, { worldSeed: "seed_rp" });
  const anyFaction = Object.keys(run.factions)[0];
  applyFactionStanding(run, anyFaction, 12);
  run.npcs.npc_m = makeNpc("npc_m", { preferences: [{ tag: "coin", weight: 2 }] });
  run.inventory.item_coin = { itemId: "item_coin", name: "Gold", quantity: 2, tags: ["coin"], flags: {} };
  commitGift(run, { npcId: "npc_m", itemId: "item_coin" });

  const reloaded = JSON.parse(JSON.stringify(run));
  assert.equal(validateSoloRun(reloaded).ok, true);
  assert.deepEqual(reloaded.factions, run.factions);
  const view = individualReputation(reloaded, "npc_m");
  assert.equal(view.affinity, 4); // base 2 × coin weight 2
  assert.equal(view.tier, "neutral");
});
