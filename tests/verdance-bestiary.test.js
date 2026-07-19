// VERDANCE BESTIARY v1 + CHAOS SKILL TREE v1 (sealed docs/worlds/babel/
// verdance-bestiary-v1.md). Data + engine: base animals, chaos skill tree,
// deterministic chaosling mint (bounded by tier budget), threat ladder, and the
// authored Limping Grey (loads + is placed). ZERO model calls.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStatBlock,
  listBaseAnimals,
  listStatBlockIds,
  CHAOS_SKILLS,
  THREAT_LADDER,
  TIER_BUDGET,
  rollChaosSkills,
  mintChaosling,
  sightReadableSkills
} from "../server/campaign/bestiary.js";

const babel = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/campaign/scenarios/babel.json"), "utf8")
);

// ── (1) BASE ANIMALS ─────────────────────────────────────────────────────────
test("10 base animals, each a level-1-region wildlife chassis with sane numbers", () => {
  const ids = listBaseAnimals();
  const EXPECTED = ["black_bear", "mountain_lion", "grey_wolf", "roosevelt_elk", "black_tailed_deer", "wild_boar", "coyote", "rattlesnake", "raven", "river_otter"];
  assert.deepEqual(ids.sort(), [...EXPECTED].sort(), "exactly the 10 authored animals");
  for (const id of ids) {
    const b = resolveStatBlock(id);
    assert.equal(b.kind, "wildlife");
    assert.equal(b.tier, 1);
    assert.ok(b.maxHp >= 1 && b.maxHp <= 25, `${id} hp in level-1-region band`);
    assert.ok(b.ac >= 10 && b.ac <= 15, `${id} ac in band`);
    assert.ok(Array.isArray(b.attacks) && b.attacks.length >= 1, `${id} has an attack`);
    assert.ok(b.tags.includes("wildlife"));
  }
});

// ── (2) CHAOS SKILL TREE ─────────────────────────────────────────────────────
test("chaos skill tree: low [pack-aura, inverted-element] + high [charm, vision, telepathy]", () => {
  assert.equal(CHAOS_SKILLS["chaos-pack-aura"].tier, "low");
  assert.equal(CHAOS_SKILLS["chaos-pack-aura"].effect, "scaling-advantage");
  assert.equal(CHAOS_SKILLS["inverted-element"].tier, "low");
  assert.ok(Array.isArray(CHAOS_SKILLS["inverted-element"].mintTable), "inverted-element carries the element×wrong-rider table");
  assert.ok(CHAOS_SKILLS["inverted-element"].mintTable.some((r) => r.element === "fire" && /chill/.test(r.rider)), "fire that chills");
  for (const id of ["charm-person", "vision-share", "telepathy"]) {
    assert.equal(CHAOS_SKILLS[id].tier, "high", `${id} is high tier`);
  }
});

// ── (3) CHAOSLING MINT — determinism, budget bounds, skill counts ─────────────
test("mint determinism: same (base,tier,seed) → byte-identical block", () => {
  const a = mintChaosling("grey_wolf", 3, "seed-XYZ");
  const b = mintChaosling("grey_wolf", 3, "seed-XYZ");
  assert.deepEqual(a, b);
  // a different seed generally differs (statBlockId always does)
  assert.notEqual(a.statBlockId, mintChaosling("grey_wolf", 3, "seed-OTHER").statBlockId);
  assert.equal(mintChaosling("not_an_animal", 2, "s"), null, "unknown base → null");
});

test("budget bounds: stat boost + skill count never exceed TIER_BUDGET (all tiers, many seeds)", () => {
  for (const baseId of listBaseAnimals()) {
    const base = resolveStatBlock(baseId);
    for (const tier of [1, 2, 3, 4]) {
      const budget = TIER_BUDGET[tier];
      for (let n = 0; n < 40; n++) {
        const c = mintChaosling(baseId, tier, `s${n}`);
        assert.ok(c.maxHp - base.maxHp >= 0 && c.maxHp - base.maxHp <= budget.hpBoost, `${baseId} t${tier} hp boost <= ${budget.hpBoost}`);
        assert.ok(c.ac - base.ac >= 0 && c.ac - base.ac <= budget.acBoost, `${baseId} t${tier} ac boost <= ${budget.acBoost}`);
        assert.ok(c.carriedSkills.length >= budget.skillsMin && c.carriedSkills.length <= budget.skillsMax, `${baseId} t${tier} skills in [${budget.skillsMin},${budget.skillsMax}]`);
        assert.equal(c.sightReadable, true);
      }
    }
  }
});

test("skill-roll counts scale with tier; high-tier skills gated to tier>=3", () => {
  for (const tier of [1, 2, 3, 4]) {
    const budget = TIER_BUDGET[tier];
    for (let n = 0; n < 30; n++) {
      const ids = rollChaosSkills(tier, `k${n}`);
      assert.ok(ids.length >= budget.skillsMin && ids.length <= budget.skillsMax, `t${tier} count band`);
      assert.equal(new Set(ids).size, ids.length, "distinct skills");
      if (!budget.highTier) {
        assert.ok(ids.every((id) => CHAOS_SKILLS[id].tier === "low"), `t${tier} rolls only low-tier skills`);
      }
    }
  }
});

// ── (5) THE LIMPING GREY — loads + is placed ─────────────────────────────────
test("the Limping Grey loads: undercut grey wolf, exactly 1 inverted-element chill bite", () => {
  const g = resolveStatBlock("limping_grey");
  assert.ok(g, "limping_grey resolves in the registry (combat-resolvable)");
  const base = resolveStatBlock("grey_wolf");
  assert.ok(g.maxHp < base.maxHp && g.ac <= base.ac, "stat undercut (visibly injured)");
  assert.equal(g.carriedSkills.length, 1, "exactly one chaos skill");
  const skill = g.carriedSkills[0];
  assert.equal(skill.skillId, "inverted-element");
  assert.deepEqual(skill.mint, { element: "bite", rider: "chill" }, "chaos-bite that chills");
  assert.equal(g.attacks[0].damageType, "cold", "the bite deals cold");
  assert.deepEqual(sightReadableSkills(g), g.carriedSkills, "essence-sight can read its carried skill");
});

test("the Limping Grey is PLACED: babel.json, starter-zone first exit, essence trail", () => {
  const b = babel.bestiary;
  assert.ok(b && Array.isArray(b.placements), "babel.json carries a bestiary.placements");
  const p = b.placements.find((x) => x.statBlockId === "limping_grey");
  assert.ok(p, "limping_grey is placed");
  assert.ok(resolveStatBlock(p.statBlockId), "the placed id resolves to a real stat block");
  assert.ok(p.locationRef in babel.locations, "placed at a real babel location");
  // reachable within the starter zone's first exits: loc_waking_mile links to start
  assert.equal(p.reachableFrom, "start");
  assert.ok(babel.locations.loc_waking_mile.connectedLocationIds.includes("start_location"), "the placement location is a first exit from start");
  assert.ok(p.essenceTrail && p.essenceTrail.towardRef === p.locationRef, "an essence trail leads to it");
});

// ── (4) THREAT LADDER ────────────────────────────────────────────────────────
test("threat ladder: wildlife common / bandits human-tier social / chaoslings uncommon / demons very rare", () => {
  assert.equal(THREAT_LADDER.wildlife.rarity, "common");
  assert.equal(THREAT_LADDER.bandit.socialCapable, true);
  assert.equal(THREAT_LADDER.chaosling.rarity, "uncommon");
  assert.equal(THREAT_LADDER.demon.rarity, "very-rare");
  // it's also mirrored (human-readable) in babel.json world data
  assert.match(babel.bestiary.threatLadder.demon, /very-rare/);
});

// registry integrity: the new rows don't break the existing contract
test("registry: base animals + limping_grey joined the resolvable set; civilian default intact", () => {
  const ids = listStatBlockIds();
  assert.ok(ids.includes("civilian") && ids.includes("waylayer"), "core blocks intact");
  assert.ok(ids.includes("limping_grey"));
  for (const a of listBaseAnimals()) assert.ok(ids.includes(a));
});
