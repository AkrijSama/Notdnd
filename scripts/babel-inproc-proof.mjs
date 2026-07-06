// In-process Babel starter-slice proof. Drives the EXACT server functions the
// HTTP route calls (createWorldOnboardingRun → getSoloRun → buildSoloScenePayload
// → resolveSoloAction), short of the HTTP/JSON wrapper and the live GM prose model.
// Used because this session's sandbox kills long-lived `node server/index.js`
// servers (exit 144 at spawn); every assertion here is server-deterministic and
// identical to what the selfplay `babel` HTTP harness asserts.
//
// Run: INKBORNE_DB_PATH=/tmp/x.sqlite INKBORNE_SCENARIO= node scripts/babel-inproc-proof.mjs

import { createWorldOnboardingRun } from "../server/campaign/onboarding.js";
import { getSoloRun, saveSoloRun } from "../server/db/repository.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { resolveSoloAction } from "../server/solo/actions.js";

const FINGERPRINT = ["ashfall", "ember tavern", "the ember", "grim dark", "dark fantasy", "barrow", "torch-lit", "ruins", "rubble", "scuff", "crumbling", "cobblestone"];

let pass = 0, fail = 0;
const results = [];
function assert(label, cond, expected, got) {
  const ok = Boolean(cond);
  if (ok) pass += 1; else fail += 1;
  results.push(`${ok ? "  ✓" : "  ✗ FAIL"} ${label}${ok ? "" : `  (expected ${expected}, got ${got})`}`);
}

// The SAME deliberately-contaminating worldgen base the selfplay harness injects:
// a Babel run over it must scrub every ruins/dark-fantasy term.
const RUINS_WORLD = {
  name: "Ashfall Reach", tone: "grim dark fantasy",
  startingLocationName: "The Ember Tavern", startingLocationType: "ruins",
  flavor: "an ash-choked frontier of crumbling keeps, torch-lit barrows, and cobblestone ruins"
};
const CHARACTER = { name: "Wren", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } };

const run0 = () => {};
void run0;

(async () => {
  const { runId } = await createWorldOnboardingRun("babel-proof-user", {
    world: RUINS_WORLD, character: CHARACTER, mode: "campaign", scenarioId: "babel"
  });
  let run = getSoloRun(runId);
  let scene = buildSoloScenePayload(run);
  const p = scene.player;

  // (1) WORLD IDENTITY + variant flag
  assert("world name is Babel", scene.world?.name === "Babel", "Babel", scene.world?.name);
  assert("world variant flag is 'babel'", scene.world?.variant === "babel", "babel", scene.world?.variant);
  assert("committed start location is the Green Static fringe", String(scene.location?.name || "").toLowerCase() === "the green static — fringe", "The Green Static — Fringe", scene.location?.name);

  // (2) VOICE opening delivered verbatim (set-piece)
  const opening = String(run.openingNarration || "").replace(/\s+/g, " ");
  for (const beat of ["YOU ARE HEARD", "IT IS CALLED BABEL", "YOUR BODY SLEEPS ELSEWHERE", "I HAVE GIVEN YOU A WINDOW", "BOTH TEACH. CHOOSE"]) {
    assert(`VOICE beat "${beat.slice(0, 22)}…" present`, opening.includes(beat), "present", "MISSING");
  }
  assert("sleeps-law: body never called dead without the not-dead framing", /DO NOT CALL IT DEAD/i.test(opening), "not-dead framing", "missing");

  // (3) Awakening Origin (the Beckoned) applied as the race slot
  assert("player origin is The Beckoned", p.origin === "The Beckoned", "The Beckoned", p.origin);
  assert("origin feat is the STATUS WINDOW", /window/i.test(String(p.originFeat || "")), "The STATUS WINDOW", p.originFeat);
  assert("origin boost applied to INT (+1)", p.abilities.intelligence >= CHARACTER.baseAbilityScores.intelligence + 1, `>= ${CHARACTER.baseAbilityScores.intelligence + 1}`, p.abilities.intelligence);
  assert("origin boost applied to Spirit/WIS (+1)", p.abilities.wisdom >= CHARACTER.baseAbilityScores.wisdom + 1, `>= ${CHARACTER.baseAbilityScores.wisdom + 1}`, p.abilities.wisdom);

  // (4) STATUS WINDOW payload — six stats, level+tier, rank UNASSESSED
  const ab = p.abilities || {};
  assert("six ability scores present", ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"].every((k) => typeof ab[k] === "number"), "six stats", JSON.stringify(ab));
  assert("rank is UNASSESSED (zero ranked skills)", p.rank === "UNASSESSED", "UNASSESSED", p.rank);
  assert("displayed level is 1", p.displayLevel === 1, "1", p.displayLevel);
  assert("milestone is 1", p.milestone === 1, "1", p.milestone);
  assert("milestone tier is Tier I — Local", p.milestoneTier === "Tier I — Local", "Tier I — Local", p.milestoneTier);

  // (5) authored fronts present
  const threadIds = (scene.threads || []).map((t) => t.threadId);
  for (const fid of ["front_salvage", "front_queue", "front_cordon"]) {
    assert(`authored front '${fid}' present`, threadIds.includes(fid), fid, threadIds.join(",") || "none");
  }

  // (6) ZERO worldgen bleed on committed surfaces (whole-run fingerprint scan)
  const committed = JSON.stringify({
    world: run.world, locations: run.locations, npcs: run.npcs, inventory: run.inventory, threads: run.threads,
    sceneLoc: scene.location, moves: scene.availableMoves, suggestions: scene.suggestedActions
  }).toLowerCase();
  const leaked = FINGERPRINT.filter((t) => committed.includes(t));
  assert("ZERO worldgen/ruins fingerprint in committed state", leaked.length === 0, "clean", leaked.join(", ") || "clean");

  // (7) cast present in Hollow Pine (move there)
  let res = resolveSoloAction(run, { type: "move", actorId: "player", toLocationId: "second_location" });
  run = res.run; saveSoloRun(run);
  scene = buildSoloScenePayload(run);
  const townCast = (scene.cast || []).map((c) => c.npcId || c.entityId || c.id);
  for (const nid of ["npc_marshal", "npc_barkeep", "npc_broker", "npc_medic"]) {
    assert(`Hollow Pine cast '${nid}' present`, townCast.includes(nid), nid, townCast.join(",") || "none");
  }

  // (8) CH3 LAW LIVE — safe conversation never rolls
  res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "talk to Marshal Grace about getting licensed" });
  run = res.run; saveSoloRun(run);
  assert("safe conversation with Grace does NOT roll (Ch3 Law 1)", res.attemptResult?.needsCheck === false, "needsCheck:false", `needsCheck:${res.attemptResult?.needsCheck}`);
  assert("safe conversation cannot fail", res.attemptResult?.success === true, "success:true", `success:${res.attemptResult?.success}`);
  assert("safe conversation is the automatic band", res.attemptResult?.band === "automatic", "automatic", res.attemptResult?.band);

  // (9) A REAL CHECK — Static hazard forced to miss by 5+ → FAILURE band, commits state
  res = resolveSoloAction(run, { type: "move", actorId: "player", toLocationId: "start_location" });
  run = res.run; saveSoloRun(run);
  const hpBefore = run.player.resources.hitPoints.current;
  res = resolveSoloAction(run, {
    type: "attempt", actorId: "player",
    intent: "force my way through a knot of corrupted, thorn-wired brush blocking the trail",
    testHook: { fixedRoll: 5, providerOutput: {
      summary: "You attempt: force through the corrupted brush", recommendedAbility: "strength", dc: 12,
      needsCheck: true, edge: false, burden: false,
      successNarration: "You tear through.", failureNarration: "The thorns tear back.",
      proposedEffects: [], failureConsequence: { type: "damage", amount: 3, reason: "the wrong-grown thorns open your forearms" }
    } }
  }, { fixedRoll: 5 });
  run = res.run; saveSoloRun(run);
  const har = res.attemptResult || {};
  assert("a real Static check rolls a d20 (three-band engaged)", har.needsCheck === true && Boolean(har.checkResult), "needsCheck:true+roll", `needsCheck:${har.needsCheck}`);
  assert("miss by 5+ lands the FAILURE band (Ch3 Law 2)", har.band === "failure", "failure", har.band);
  assert("the failed check COMMITS state (never a dead turn)", har.consequence?.applied === true, "applied:true", `applied:${har.consequence?.applied}`);
  const hpAfter = run.player.resources.hitPoints.current;
  assert("the committed cost is visible (HP fell)", hpAfter < hpBefore, `< ${hpBefore}`, hpAfter);

  // ── report ──
  console.log("\n================= BABEL STARTER SLICE — IN-PROCESS PROOF =================\n");
  console.log(results.join("\n"));
  console.log(`\nSTATUS WINDOW readout:`);
  console.log(`  NAME ${p.displayName}   LEVEL ${p.displayLevel}   ${p.milestoneTier}`);
  console.log(`  RANK ${p.rank}   ORIGIN ${p.origin} (feat: ${p.originFeat})`);
  console.log(`  STR ${ab.strength}  DEX ${ab.dexterity}  VIT ${ab.constitution}  Spirit ${ab.wisdom}  INT ${ab.intelligence}  Luck ${ab.charisma}`);
  console.log(`  HP ${p.hitPoints.current}/${p.hitPoints.max}   Static check: ${hpBefore}→${hpAfter} HP (FAILURE band committed)`);
  console.log(`\n--- VOICE opening (first 320 chars, delivered verbatim) ---`);
  console.log(String(run.openingNarration || "").slice(0, 320) + "…");
  console.log(`\n=========================================================================`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF ERROR:", e?.stack || e); process.exit(2); });
