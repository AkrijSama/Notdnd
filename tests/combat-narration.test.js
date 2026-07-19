// COMBAT SIGHT + NARRATION CONTRACT + AUDITOR (D.4 items 7 & 9).
import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderPromptMessages } from "../server/solo/gmProvider.js";
import { detectFabricatedCombatNumbers } from "../server/solo/combatAudit.js";
import { readChaosSkillPhrase, readStatBlockSkills } from "../server/solo/essence.js";

// ── item 7: essence-sight reads a creature's carried chaos skills ──────────────
test("sight-read: the Limping Grey's inverted-element mint reads 'a bite that chills'", () => {
  assert.equal(readChaosSkillPhrase({ skillId: "inverted-element", mint: { element: "bite", rider: "chill" } }), "a bite that chills");
  assert.equal(readChaosSkillPhrase({ skillId: "inverted-element", mint: { element: "fire", rider: "chills" } }), "a fire that chills");
  assert.equal(readChaosSkillPhrase({ skillId: "chaos-pack-aura", name: "Chaos-Pack Aura" }), "a pack that feeds on numbers");
  // the authored Grey stat block, end to end
  assert.deepEqual(readStatBlockSkills("limping_grey"), ["a bite that chills"]);
  assert.deepEqual(readStatBlockSkills("civilian"), [], "a non-readable block reads nothing");
});

// ── item 9: the combat directive rides the narrator contract ───────────────────
test("combat directive: present + wound-band contract when a fight is live", () => {
  const msgs = buildProviderPromptMessages({
    runId: "r1", edition: "mainline", location: { name: "The Waking Mile" },
    combat: {
      status: "active", turn: 2,
      forecast: ["you", "The Limping Grey", "you"],
      enemies: [{ name: "The Limping Grey", wound: "bloodied", telegraph: "snarls; frost rimes its bared teeth", reads: ["a bite that chills"], statuses: [] }]
    }
  });
  const sys = msgs[0].content;
  assert.match(sys, /COMBAT is live \(turn 2\)/);
  assert.match(sys, /Speak WOUNDS in BANDS/i);
  assert.match(sys, /NEVER a raw HP total or a damage number/i);
  assert.match(sys, /The Limping Grey \(bloodied; telegraphs: snarls/);
  assert.match(sys, /Upcoming order: you → The Limping Grey → you/);
  // and the user-payload scene JSON carries the combat grounding
  assert.match(msgs[1].content, /"combat"/);
});

test("combat directive: ABSENT out of combat", () => {
  const msgs = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: { name: "Hollow Pine" }, combat: null });
  assert.doesNotMatch(msgs[0].content, /COMBAT is live/);
});

// ── item 9: the fabricated-damage auditor (calibration) ────────────────────────
const LIVE = { status: "active", combatId: "cbt_x" };

test("auditor FLAGS a fabricated damage/HP number inside a live fight (true-positive)", () => {
  const probe = "Your blade bites deep. The wolf takes 8 damage and drops to 3 HP, snarling.";
  const hits = detectFabricatedCombatNumbers(probe, LIVE);
  assert.ok(hits.length >= 2, "both the damage number and the remaining-HP claim flag");
  const kinds = hits.map((h) => h.kind);
  assert.ok(kinds.includes("raw_damage"));
  assert.ok(kinds.includes("hp_number") || kinds.includes("remaining_hp"));
});

test("auditor does NOT flag a clean wound-band narration (true-negative)", () => {
  const clean = "Your blade bites deep. The Grey staggers back, bloodied, frost steaming off its ruined jaw. It circles, favoring the crippled leg.";
  assert.deepEqual(detectFabricatedCombatNumbers(clean, LIVE), [], "wounds in bands, no numbers → clean");
});

test("auditor is silent out of combat (numbers there are unremarkable)", () => {
  assert.deepEqual(detectFabricatedCombatNumbers("You count 8 coins into her palm.", null), []);
  assert.deepEqual(detectFabricatedCombatNumbers("You count 8 coins.", { status: "won" }), []);
});
