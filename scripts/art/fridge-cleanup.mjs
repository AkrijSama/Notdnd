// ---------------------------------------------------------------------------
// FRIDGE CLEANUP (INSP) — acts on the read-only audit in
// scratchpad/fridge-manifest.txt. Two lifecycle actions, per the asset laws:
//
//   (a) DESTROY the 14 TOSS-rated debris (asset-lifecycle law, owner 2026-07-20:
//       toss = DESTROY — the png + its sidecar are deleted, never retained).
//   (b) QUARANTINE the 11 no-recipe-meta assets (fridge-taster mechanism): set the
//       `quarantine` sidecar marker + rating != "keep" so they are HELD FOR OWNER
//       REVIEW and served to NOTHING (library.queryAssets drops any quarantined
//       asset), under the 30-day auto-trash law (fridgeTaster.sweepQuarantine).
//
// IDEMPOTENT: a destroyed asset re-runs as a no-op; an already-quarantined asset
// keeps its original marker (the 30-day clock is not reset). SAFE: a destroy target
// still on disk whose rating is NOT "toss" is refused (never destroys a keep).
//
//   node scripts/art/fridge-cleanup.mjs             # apply
//   node scripts/art/fridge-cleanup.mjs --dry-run   # preview, change nothing
//
// The manifest is the authority for WHICH assets (it names each suspect + class);
// this script re-verifies each against disk before acting. Pure filesystem, no GPU,
// no network.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAsset, addAsset, destroyAsset, assetExists, libraryRoot } from "./library.mjs";
import { buildQuarantine } from "../../server/solo/fridgeTaster.js";

// (a) TOSS-DEBRIS — rating="toss", still on disk. DESTROY (png + sidecar). 14 ids
// from the manifest's toss-debris class.
const DESTROY_IDS = Object.freeze([
  "babel-npcbody-npc-herbalist",
  "babel-npcbody-npc-scholar",
  "babel-npcbody-npc-smith",
  "babel-npcbody-npc-warden",
  "babel-scene-forest-path-anime",
  "babel-scene-forest-path-dark-fantasy",
  "babel-scene-town-gate-anime",
  "babel-scene-town-gate-dark-fantasy",
  "babel-scene-town-square-anime",
  "babel-scene-town-square-dark-fantasy",
  "babel-worldcard-anime-1",
  "babel-worldcard-anime-2",
  "babel-worldcard-anime-3",
  "babel-worldcard-anime-4"
]);

// (b) NO-RECIPE-META — keep-rated but pre prompt-contract (epoch unverifiable).
// QUARANTINE (held for owner review). 11 ids from the manifest's no-recipe-meta class.
const QUARANTINE_IDS = Object.freeze([
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_npc_creature_5b9e3030_base",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_npc_mile_defc1ab5_base",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_npc_wolf_1d2f6f0a_base",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_npc_wolf_4a10ecce_base",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_npc_wolf_92bd8ca1_base",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_player",
  "babel-scene-green-static-fringe-anime",
  "live_run_61fb9c16-61fe-4e81-8f0b-ef9ef9992596_loc_loc_waking_mile",
  "live_run_bbcb7b08-9dce-4f05-983c-87de6842368e_loc_loc_waking_mile",
  "babel-worldcard-anime-live",
  "worldcard-exemplar-realistic-live"
]);

const QUARANTINE_REASON =
  "no recipe meta — pre prompt-contract, epoch unverifiable; held for owner review (INSP fridge-manifest 2026-07-21)";

function pngPath(id) {
  return path.join(libraryRoot(), `${String(id)}.png`);
}

// Destroy one toss-debris asset. Returns a status string:
//   "destroyed" | "already-gone" | "skipped-not-toss"
function destroyOne(id, { dryRun }) {
  const onDisk = assetExists(id) || fs.existsSync(pngPath(id));
  if (!onDisk) return "already-gone";
  const sidecar = getAsset(id);
  if (sidecar && sidecar.rating !== "toss") {
    // SAFETY: the manifest classed this as toss-debris but disk disagrees — refuse.
    return "skipped-not-toss";
  }
  if (dryRun) return "would-destroy";
  destroyAsset(id); // removes png + sidecar (best-effort, never throws)
  return "destroyed";
}

// Quarantine one no-recipe-meta asset. Returns:
//   "quarantined" | "already-quarantined" | "not-found"
function quarantineOne(id, { dryRun }) {
  const sidecar = getAsset(id);
  if (!sidecar) return "not-found";
  if (sidecar.quarantine && typeof sidecar.quarantine === "object") {
    return "already-quarantined"; // keep the existing marker — do not reset the clock
  }
  if (dryRun) return "would-quarantine";
  const quarantine = buildQuarantine({
    model: "fridge-cleanup",
    assessment: { reason: QUARANTINE_REASON, checks: [] }
  });
  const tags = Array.isArray(sidecar.tags) ? sidecar.tags : [];
  addAsset({
    ...sidecar,
    // Canonical quarantine state (fridge-taster suspect): rating != "keep" + marker.
    rating: null,
    quarantine,
    tags: [...new Set([...tags, "quarantine", "fridge-cleanup:no-recipe-meta"])]
  });
  return "quarantined";
}

export function runFridgeCleanup({ dryRun = false } = {}) {
  const tally = { destroyed: [], alreadyGone: [], skippedNotToss: [], quarantined: [], alreadyQuarantined: [], notFound: [] };

  for (const id of DESTROY_IDS) {
    const r = destroyOne(id, { dryRun });
    if (r === "destroyed" || r === "would-destroy") tally.destroyed.push(id);
    else if (r === "already-gone") tally.alreadyGone.push(id);
    else if (r === "skipped-not-toss") tally.skippedNotToss.push(id);
  }
  for (const id of QUARANTINE_IDS) {
    const r = quarantineOne(id, { dryRun });
    if (r === "quarantined" || r === "would-quarantine") tally.quarantined.push(id);
    else if (r === "already-quarantined") tally.alreadyQuarantined.push(id);
    else if (r === "not-found") tally.notFound.push(id);
  }
  return tally;
}

function report(tally, { dryRun }) {
  const mode = dryRun ? "DRY-RUN (no changes written)" : "APPLIED";
  const lines = [];
  lines.push(`fridge-cleanup — ${mode}`);
  lines.push(`library root: ${libraryRoot()}`);
  lines.push("");
  lines.push(`DESTROY (toss-debris): ${tally.destroyed.length}/${DESTROY_IDS.length} ${dryRun ? "would be destroyed" : "destroyed"}`);
  for (const id of tally.destroyed) lines.push(`  - ${id}`);
  if (tally.alreadyGone.length) {
    lines.push(`  already-gone (idempotent no-op): ${tally.alreadyGone.length}`);
    for (const id of tally.alreadyGone) lines.push(`    · ${id}`);
  }
  if (tally.skippedNotToss.length) {
    lines.push(`  SKIPPED — on disk but rating!=toss (safety refuse): ${tally.skippedNotToss.length}`);
    for (const id of tally.skippedNotToss) lines.push(`    ! ${id}`);
  }
  lines.push("");
  lines.push(`QUARANTINE (no-recipe-meta): ${tally.quarantined.length}/${QUARANTINE_IDS.length} ${dryRun ? "would be quarantined" : "quarantined"}`);
  for (const id of tally.quarantined) lines.push(`  - ${id}`);
  if (tally.alreadyQuarantined.length) {
    lines.push(`  already-quarantined (idempotent no-op): ${tally.alreadyQuarantined.length}`);
    for (const id of tally.alreadyQuarantined) lines.push(`    · ${id}`);
  }
  if (tally.notFound.length) {
    lines.push(`  NOT-FOUND (no sidecar on disk): ${tally.notFound.length}`);
    for (const id of tally.notFound) lines.push(`    ? ${id}`);
  }
  return lines.join("\n");
}

// Run when invoked directly (not on import — keeps node --check / tests side-effect free).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
  const tally = runFridgeCleanup({ dryRun });
  // eslint-disable-next-line no-console
  console.log(report(tally, { dryRun }));
}
