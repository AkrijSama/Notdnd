// HELD-ITEM CONTRACT — the anti-stale-blocker net (2026-07-21, CLI-2).
//
// THE PROCESS BUG this closes: CLI-1's leak audit HELD four migrations on "the loader
// whitelist is string-only". Stage 3 then widened that whitelist. The two reports never
// reconciled — the blocker went stale SILENTLY, and a held item (systemLore) sat
// "blocked" when it was actually landable. A stale blocker must be LOUD, not silent.
//
// Each test below encodes a still-HELD item's RECORDED BLOCKER as an executable check
// against runtime reality. When a blocker stops describing reality (someone widens the
// loader, generalizes the client gate, renames the run field, or reworks the frozen
// registry) the matching test goes RED — forcing a re-audit of the HELD list in
// docs/design/steel-vs-furniture.md instead of letting the ledger rot.
//
// A GREEN suite here means "every recorded blocker still holds — the HELD list is
// honest." A RED test names the item whose blocker is now stale.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";
import { RANK_LADDER, rankForPlayer } from "../server/solo/progression.js";

// Load babel with an arbitrary set of probe world/origin knobs injected, and return the
// resulting run — the single instrument every loader-carrier blocker check reads.
function runWithProbes(mutate) {
  const scen = JSON.parse(JSON.stringify(loadScenarioFile("babel")));
  mutate(scen);
  const run = createDefaultSoloRun({ runId: "held_probe" });
  loadScenarioIntoRun(run, scen, {});
  return run;
}
const read = (rel) => fs.readFileSync(path.resolve(rel), "utf8");

// ── actionNarration ──────────────────────────────────────────────────────────
// RECORDED BLOCKER: the loader carry set (scenarioLoader.js) does NOT include
// `opening`/`startArea`, so the carrier run.world.opening / run.startArea is dropped.
// UNBLOCK CONDITION: those keys reach run.world after load.
test("HELD actionNarration: loader still DROPS world.opening / world.startArea", () => {
  const run = runWithProbes((s) => {
    s.world.opening = { orientationBeats: ["PROBE"] };
    s.world.startArea = { register: "PROBE" };
  });
  assert.equal(run.world.opening, undefined, "world.opening now reaches run.world — actionNarration may be landable; RE-AUDIT steel-vs-furniture.md §MODERATE");
  assert.equal(run.startArea, undefined, "run.startArea now exists — RE-AUDIT actionNarration");
});

// ── sheetSpec — RESOLVED (JOB 2.2) ─────────────────────────────────────────────
// The blocker is CLEARED: the STATUS WINDOW render no longer keys on variant==="babel"; it
// gates on the world DECLARING a diegetic sheet (world.sheetSpec). This now LOCKS the resolved
// state — if someone re-welds the window to the variant, this goes RED.
test("RESOLVED sheetSpec: the client STATUS WINDOW gates on world.sheetSpec, not variant==='babel'", () => {
  const run = runWithProbes((s) => { s.world.sheetSpec = { stats: [{ label: "X", ability: "strength" }] }; });
  assert.notEqual(run.world.sheetSpec, undefined, "the loader carries world.sheetSpec through both doors");
  const client = read("src/components/soloSceneShell.js");
  assert.ok(
    !client.includes('world.variant === "babel"'),
    "the STATUS WINDOW must NOT be re-welded to variant==='babel' — it gates on world.sheetSpec (JOB 2.2)"
  );
  assert.ok(
    /sheetSpec/.test(client),
    "the client must read world.sheetSpec to open the diegetic window"
  );
});

// ── rankLadder — RESOLVED (JOB 2.1) ────────────────────────────────────────────
// The blocker is CLEARED: rankLadder now rides CARRIED_WORLD_KEYS.array, and rankForPlayer
// reads world.rankLadder (resolveRankLadder) else the E→DG default. This LOCKS the resolved
// state — a dropped array carry, or a rank computed off a fixed ladder, goes RED.
test("RESOLVED rankLadder: an ARRAY world.rankLadder reaches run.world and drives rankForPlayer", () => {
  assert.ok(Array.isArray(RANK_LADDER), "the default ladder stays a fixed array");
  const run = runWithProbes((s) => { s.world.rankLadder = ["Novice", "Adept", "Master", "Grandmaster"]; });
  assert.deepEqual(run.world.rankLadder, ["Novice", "Adept", "Master", "Grandmaster"], "an ARRAY world.rankLadder now reaches run.world (carried as an array slot)");
  // a ranked skill resolves against the WORLD's ladder, not E→DG.
  const rank = rankForPlayer({ babelSkills: [4] }, run.world); // index 4 → 4th rung
  assert.equal(rank, "Grandmaster", "rankForPlayer reads world.rankLadder, not the hardcoded E→DG");
});

// ── imageWorker art-framing ──────────────────────────────────────────────────
// RECORDED BLOCKER: the playerOrigin door (scenarioLoader.js) copies only boost/name/
// feat; a new `artFraming` field is dropped. (Plus the SEALED art choke-point +
// art-path-wall — an art pass, not a loader widening.) UNBLOCK: artFraming reaches run.
test("HELD imageWorker: the playerOrigin door still DROPS a new artFraming field", () => {
  const run = runWithProbes((s) => { s.playerOrigin = { ...(s.playerOrigin || {}), artFraming: "PROBE_ARTFRAMING" }; });
  assert.ok(
    !JSON.stringify(run.player || {}).includes("PROBE_ARTFRAMING"),
    "playerOrigin.artFraming now reaches the run — the loader door widened; RE-AUDIT imageWorker (still art-path-wall gated)"
  );
});

// ── bestiary rapture_drifter / LIMPING_GREY ──────────────────────────────────
// RECORDED BLOCKER: it is NOT the loader (the overlay door is open). It is the
// FROZEN-BLOCK test contract — these blocks resolve from the frozen REGISTRY with NO
// scenario load, and minted-block-pruning asserts frozen blocks are never pruned.
// UNBLOCK CONDITION: moving them to babel.json (overlay-only) makes resolveStatBlock
// return null without a load — which would break ~8 tests. This asserts the contract.
test("HELD bestiary: limping_grey / rapture_drifter still resolve from the FROZEN registry with no scenario load", () => {
  assert.ok(resolveStatBlock("limping_grey"), "limping_grey no longer resolves frozen — if moved to the babel overlay, the frozen-block test contract inverted; RE-AUDIT bestiary");
  assert.ok(resolveStatBlock("rapture_drifter"), "rapture_drifter no longer resolves frozen — RE-AUDIT bestiary's prune contract");
});

// ── the general reconciliation guard (the exact bug that bit) ─────────────────
// systemLore's blocker WAS "loader is string-only". Stage 3 carried it and CLI-2 landed
// the migration. This asserts the migration stayed landed (the carrier survives) — a
// regression here means the loader NARROWED and re-blocked a shipped migration.
test("RECONCILED systemLore: the loader carries world.systemLore (migration stays landable/landed)", () => {
  const run = runWithProbes(() => {});
  assert.ok(run.world.systemLore, "world.systemLore stopped reaching run.world — the loader re-narrowed; the shipped systemLore migration is now broken");
});
