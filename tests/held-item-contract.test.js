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
import { RANK_LADDER } from "../server/solo/progression.js";

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

// ── sheetSpec ────────────────────────────────────────────────────────────────
// The LOADER blocker is GONE (Stage 3 carries world.sheetSpec). The live blocker is now
// the CLIENT: the STATUS WINDOW render is hard-gated on `variant === "babel"`
// (soloSceneShell.js). A server-only migration would be dead furniture for other worlds.
// UNBLOCK CONDITION: the client render stops keying on variant === "babel".
test("HELD sheetSpec: loader carries world.sheetSpec, but the client STATUS WINDOW still gates on variant", () => {
  const run = runWithProbes((s) => { s.world.sheetSpec = { stats: [{ label: "X", ability: "strength" }] }; });
  assert.notEqual(run.world.sheetSpec, undefined, "the loader is expected to carry world.sheetSpec (Stage 3) — if this drops, the recorded blocker moved");
  const client = read("src/components/soloSceneShell.js");
  assert.ok(
    client.includes('variant === "babel"'),
    "the client STATUS WINDOW no longer gates on variant === \"babel\" — sheetSpec's player door may be open; RE-AUDIT sheetSpec (client half is CLI-1 fenced)"
  );
});

// ── rankLadder ───────────────────────────────────────────────────────────────
// RECORDED BLOCKER (loader half): RANK_LADDER is an ARRAY and carryObject skips arrays,
// so an array-shaped world.rankLadder is dropped. (The other two halves — the
// babelSkills→rankedSkills DB rename, and the variant-gated client display — are not
// runtime-probed here; see the ledger.) UNBLOCK: an array world.rankLadder reaches run.
test("HELD rankLadder: RANK_LADDER is a fixed array and the loader DROPS an array world.rankLadder", () => {
  assert.ok(Array.isArray(RANK_LADDER), "RANK_LADDER stopped being a fixed array — RE-AUDIT rankLadder");
  const run = runWithProbes((s) => { s.world.rankLadder = ["E", "D", "C"]; });
  assert.equal(run.world.rankLadder, undefined, "an ARRAY world.rankLadder now reaches run.world — RE-AUDIT rankLadder's loader half");
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
