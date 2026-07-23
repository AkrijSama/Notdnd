// JOB 6 — THE MANIFEST LIES. WORLD_BOOK_SLOTS is a hand-maintained bill of materials whose
// `consumer` prose drifts: it marked `deathLaw` a DEAD SLOT long after the slot was wired to the
// death-screen epilogue. A manifest that misdescribes reality is worse than none.
//
// SELF-CHECK POLICY (JOB 6.2): a full runtime-derived `consumer` field is NOT cheap — the engine
// has no reader-registry, and grepping for readers in a test is fragile. So the STRUCTURAL BOM
// (path/label/defaultKind/default → filled/gap via worldBookManifest.SLOT_READERS) stays the
// self-checking part, and this test LOCKS the specific claim that drifted: deathLaw is LIVE, and
// it actually reaches the payload. If someone re-marks it DEAD or unwires the reader, this fails.
import test from "node:test";
import assert from "node:assert/strict";
import { WORLD_BOOK_SLOTS } from "../server/campaign/worldBook.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";

test("JOB 6.1: the manifest's deathLaw entry is not falsely marked DEAD (the exact stale entry this pass found)", () => {
  const slot = WORLD_BOOK_SLOTS.find((s) => s.path === "deathLaw");
  assert.ok(slot, "the deathLaw slot exists in the manifest");
  assert.doesNotMatch(slot.consumer, /DEAD SLOT|NONE:/, "deathLaw is LIVE (the death-screen epilogue) — the manifest must not call it dead");
});

test("JOB 6 self-check: deathLaw is ACTUALLY live — world.deathLaw.epilogue reaches the scene payload", () => {
  const run = createDefaultSoloRun({ runId: "deathlaw_live" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  const p = buildSoloScenePayload(run);
  assert.ok(p.world && p.world.deathLaw && typeof p.world.deathLaw.epilogue === "string" && p.world.deathLaw.epilogue.length > 0,
    "world.deathLaw.epilogue must reach the payload (the death-screen door) — if this drops, deathLaw is no longer live and the manifest entry must change");
});

test("JOB 6.2: every manifest slot still declares a default (the machine-derivable BOM invariant holds)", () => {
  // The one part of the manifest that IS self-checking: no slot may be default-less (THE LAW).
  const bad = WORLD_BOOK_SLOTS.filter((s) => !("default" in s) && !s.mintedBy && s.defaultKind !== "required" && s.defaultKind !== "planned");
  assert.deepEqual(bad.map((s) => s.path), [], "a manifest slot has no default/mint and is not required/planned — the BOM is dishonest about its floor");
});
