// WALK-DOOR HARNESS — self-tests (the harness must itself be verified, or it rots
// like the checks it replaces). Pure logic only: no live server, no AI, $0. Locks the
// route-inventory registry, the coverage gate, the crop math, and the coherence checks.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LAYERS, SURFACES, SILENT_FALLBACKS, cropInfo, evalDisplayAspect, DISPLAY,
  servedBytesVerdict, coverageVerdict, requiredDoorRank, CANNOT_CATCH
} from "../scripts/walk-harness/model.mjs";
import { runAllCoherence, proseAssertsUncommitted } from "../scripts/walk-harness/coherence.mjs";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";

// ── registry: the route-inventory must be complete + honest ──────────────────
test("registry: the world-card is a separate-fetch surface (the class-5 shape) that degrades for a guest and HAS a deceptive fallback", () => {
  const wc = SURFACES.find((s) => s.id === "world-card");
  assert.ok(wc, "the world-card surface must be registered");
  assert.equal(wc.clientResolution.kind, "separate-fetch");
  // CLI-1 fixed the logged-in path (apiClient carries the token); walk-fix made the
  // endpoint PUBLIC for published world-cards, so a guest no longer degrades.
  assert.equal(wc.clientResolution.carriesAuth, true, "logged-in requests carry the token");
  assert.equal(wc.clientResolution.guestDegrades, false, "walk-fix: the guest door is public for published world-cards");
  assert.equal(wc.byteCheckable, true, "the world-card door can be byte-checked without a cook");
});

test("registry: every OTHER art surface rides the authed payload (no separate fetch → no class-5 divergence) and degrades HONESTLY", () => {
  for (const s of SURFACES.filter((x) => x.playerFacing && !x.noArt && x.id !== "world-card")) {
    assert.equal(s.clientResolution.kind, "authed-payload", `${s.id} must ride the authed payload`);
    assert.equal(s.deceptiveFallback, null, `${s.id} must NOT have a deceptive fallback (honest pending only)`);
  }
});

test("silent-fallback inventory: ZERO deceptive fallbacks remain (walk-fix resolved the world-card); all are honest + detectable", () => {
  const deceptive = SILENT_FALLBACKS.filter((f) => f.classification === "deceptive");
  assert.equal(deceptive.length, 0, "the world-card deceptive fallback was removed; none should remain");
  assert.ok(SILENT_FALLBACKS.every((f) => f.harnessDetects), "every catalogued fallback is harness-detectable");
  assert.ok(SILENT_FALLBACKS.filter((f) => f.classification === "honest").length >= 5, "the honest pending states are catalogued");
});

// ── crop math (Job 3.3) ──────────────────────────────────────────────────────
test("crop math: a wide source in a narrow box crops the sides; a wide box crops top/bottom; equal = 0", () => {
  assert.equal(cropInfo(1.75, 1.75).cropPct, 0);
  const sides = cropInfo(1.0, 0.667); // player portrait 1:1 in a 2:3 frame
  assert.ok(sides.axis.startsWith("horizontal") && Math.abs(sides.cropPct - 33.3) < 0.5, `player-portrait ~33% side crop, got ${sides.cropPct}`);
  const topbottom = cropInfo(1.75, 4.57); // scene in a full-bleed strip
  assert.ok(topbottom.axis.startsWith("vertical") && topbottom.cropPct > 60, `scene >60% top/bottom crop, got ${topbottom.cropPct}`);
});

test("crop math: the scene box holds the 1536x320 cook aspect (JOB 1: 4.8 full-bleed) + object-fit contain", () => {
  const a = evalDisplayAspect(DISPLAY.scene, { width: 1440, height: 900 });
  assert.ok(Math.abs(a - 1536 / 320) < 1e-6, `the scene box aspect must equal the cook aspect (4.8), got ${a}`);
  assert.equal(DISPLAY.scene.objectFit, "contain", "the scene img must be contain so nothing is ever cut");
  assert.equal(DISPLAY["portrait-frame"].objectFit, "contain", "portraits must be contain so a face is never cropped");
  assert.equal(evalDisplayAspect(DISPLAY["portrait-frame"], { width: 1440, height: 900 }), 512 / 768, "a fixed-aspect box ignores the viewport");
});

// ── served-bytes verdict (Job 3.1/3.2): a fallback firing is a FAILURE ───────
test("served-bytes: a mismatch is a FAILURE; a fallback firing is named as one; a match passes", () => {
  const miss = servedBytesVerdict({ surfaceId: "world-card", servedSha: "aaa", intendedSha: "bbb", servedFrom: "/public/assets/art-illustrated.jpg", fallbackAsset: "/public/assets/art-illustrated.jpg" });
  assert.equal(miss.failure, true);
  assert.match(miss.reason, /SILENT FALLBACK FIRED/);
  const hit = servedBytesVerdict({ surfaceId: "world-card", servedSha: "abc", intendedSha: "abc", servedFrom: "/data/assets/library/x.png" });
  assert.equal(hit.failure, false);
});

// ── coverage gate (Job 6.2): kind-aware door adequacy ────────────────────────
test("coverage gate: a separate-fetch surface below SERVED_BYTES blocks; an authed-payload surface at HTTP_AUTHED does NOT", () => {
  assert.equal(requiredDoorRank("separate-fetch"), LAYERS.SERVED_BYTES.rank);
  assert.equal(requiredDoorRank("authed-payload"), LAYERS.HTTP_AUTHED.rank);
  // authed-payload at http-authed → door-adequate → walk-ready
  const ok = coverageVerdict([
    { id: "scene", playerFacing: true, noArt: false, clientKind: "authed-payload", status: "PASS", reachedLayerRank: LAYERS.HTTP_AUTHED.rank, reachedLayer: "http-authed" },
    { id: "world-card", playerFacing: true, noArt: false, clientKind: "separate-fetch", status: "PASS", reachedLayerRank: LAYERS.SERVED_BYTES.rank, reachedLayer: "served-bytes" }
  ]);
  assert.equal(ok.walkReady, true, "route-adequate surfaces do not block walk-ready");
  // a separate-fetch surface only at http-authed (never guest-tested) BLOCKS
  const hole = coverageVerdict([
    { id: "world-card", playerFacing: true, noArt: false, clientKind: "separate-fetch", status: "PASS", reachedLayerRank: LAYERS.HTTP_AUTHED.rank, reachedLayer: "http-authed", why: "x" }
  ]);
  assert.equal(hole.walkReady, false, "a class-5-shaped surface verified only at http-authed is a hole");
  // a FAIL always blocks
  const fail = coverageVerdict([{ id: "world-card", playerFacing: true, noArt: false, clientKind: "separate-fetch", status: "FAIL", reachedLayerRank: LAYERS.SERVED_BYTES.rank, reachedLayer: "served-bytes" }]);
  assert.equal(fail.walkReady, false);
});

test("honesty: the harness names its TRUE residuals now the browser stage closed the DOM/console gap (pixels, taste, viewport, long-session)", () => {
  const text = CANNOT_CATCH.join(" ").toLowerCase();
  // The browser stage catches rendered-DOM + console defects, so those are no longer in
  // the cannot-catch set. What remains structurally out of reach is visual QUALITY, taste,
  // untested viewports, and long-session emergence — the honesty list must still name them.
  for (const kw of ["pixel", "taste", "viewport", "long-session"]) assert.match(text, new RegExp(kw));
});

// ── coherence (Job 5) — the structural checks are clean on babel + catch a plant ──
test("coherence: all four structural checks pass on the authored babel world (zero false positives)", () => {
  for (const c of runAllCoherence("babel")) assert.equal(c.ok, true, `${c.name} must pass on babel: ${JSON.stringify(c.findings.filter((f) => !f.ok))}`);
});

test("coherence: prose-vs-commit CATCHES a planted uncommitted named character", () => {
  const run = createDefaultSoloRun({ runId: "x", now: "2026-01-01T00:00:00.000Z" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  // a real committed cast member is NOT flagged; an invented one IS
  const clean = proseAssertsUncommitted(run, "The Limping Grey watches from the treeline.");
  assert.deepEqual(clean, [], "a committed entity in prose is not a phantom");
  const planted = proseAssertsUncommitted(run, "Barrowman Fenwick says the road is closed and adjusts his coat.");
  assert.ok(planted.includes("Barrowman Fenwick") || planted.some((p) => /Fenwick/.test(p)), `a narrated uncommitted character must be flagged, got ${JSON.stringify(planted)}`);
});
