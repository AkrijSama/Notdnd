#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WALK-DOOR HARNESS — the runner. Verifies the DOOR the player walks, not the
// layer beneath it. Targets a RUNNING build over HTTP; issues the exact requests a
// browser issues (guest, no injected token); compares SERVED BYTES to intended
// assets; runs in-process coherence at $0; and reports an explicit UNVERIFIED list
// with a coverage-gated WALK-READY verdict.
//
// USAGE:  node scripts/walk-door-harness.mjs [--json]
//   env NOTDND_HARNESS_BASE_URL   default http://127.0.0.1:4173 (the running build)
//   env NOTDND_HARNESS_LIB_ROOT   default /home/akrij/Notdnd/data/assets/library
//                                 (where intended-asset bytes live on disk)
// ZERO paid cost: no turn narration, no cook. Structural + route + served-bytes only.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LAYERS, DOOR_LAYER_RANK, COOK, DISPLAY, SURFACES, SILENT_FALLBACKS,
  cropInfo, evalDisplayAspect, servedBytesVerdict, coverageVerdict, CANNOT_CATCH
} from "./walk-harness/model.mjs";
import { runAllCoherence } from "./walk-harness/coherence.mjs";

const BASE = (process.env.NOTDND_HARNESS_BASE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const LIB_ROOT = process.env.NOTDND_HARNESS_LIB_ROOT || "/home/akrij/Notdnd/data/assets/library";
const JSON_OUT = process.argv.includes("--json");
const REFERENCE_VIEWPORT = { width: 1440, height: 900, label: "1440x900 desktop (full-bleed stage)" };
const CROP_THRESHOLD_PCT = 20; // Job 3.3: a crop above this is a finding, not a note.

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
async function http(pathOrUrl, { token, method = "GET" } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers });
  return res;
}
async function httpBytes(p, opts) { const res = await http(p, opts); const buf = Buffer.from(await res.arrayBuffer()); return { status: res.status, buf, ctype: res.headers.get("content-type") }; }
function diskSha(assetIdOrPath) {
  const p = assetIdOrPath.startsWith("/") ? assetIdOrPath : path.join(LIB_ROOT, assetIdOrPath);
  return fs.existsSync(p) ? sha(fs.readFileSync(p)) : null;
}

async function main() {
  const report = { at: new Date().toISOString(), base: BASE, build: null, jobs: {}, surfaces: [], verdict: null };

  // reachability + build sha (never diagnose against a server that isn't the build)
  let status;
  try { status = await (await http("/api/debug/status")).json(); }
  catch { fail(`server unreachable at ${BASE} — the harness verifies a RUNNING build; start the play-server first.`); }
  report.build = status?.build || null;

  // real front-door token (a GUEST session — no injected token, no test hook)
  const guestRes = await (await http("/api/auth/guest", { method: "POST" })).json();
  const token = guestRes?.token || null;

  // ── JOB 1: layer inventory ────────────────────────────────────────────────
  report.jobs.job1_layers = Object.values(LAYERS).map((l) => ({ layer: l.id, rank: l.rank, catches: l.catches, misses: l.misses }));

  // ── per-surface verification ──────────────────────────────────────────────
  for (const s of SURFACES) {
    const r = { id: s.id, label: s.label, playerFacing: s.playerFacing, noArt: Boolean(s.noArt), clientKind: s.clientResolution.kind, status: "PASS", reachedLayer: null, reachedLayerRank: -1, why: "", detail: {} };

    if (s.noArt) { r.reachedLayer = "n/a"; r.reachedLayerRank = LAYERS.PIXELS.rank; r.why = "no image surface (text only)"; report.surfaces.push(r); continue; }

    if (s.clientResolution.kind === "separate-fetch") {
      // THE CLASS-5 SHAPE. Replay the client's EXACT request (raw, no auth), then
      // resolve what it actually shows, and compare served bytes to intended.
      const clientReq = await http(s.clientResolution.request.path, { token: s.clientResolution.carriesAuth ? token : null });
      const authedResolve = await http(s.clientResolution.request.path, { token }); // what the SERVER resolves if asked properly
      const authedJson = authedResolve.status === 200 ? await authedResolve.json() : null;
      const intendedUri = authedJson?.uri || null;
      const intendedSha = intendedUri ? diskSha(intendedUri.replace("/data/assets/library/", "")) : null;

      // what the door actually serves: if the client's request wasn't ok, the client
      // keeps its static default → THAT is the served asset.
      const clientOk = clientReq.status === 200;
      let servedFrom, servedSha;
      if (clientOk) {
        const j = await clientReq.json();
        servedFrom = j?.uri || null;
        servedSha = servedFrom ? diskSha(servedFrom.replace("/data/assets/library/", "")) : null;
      } else {
        servedFrom = s.deceptiveFallback?.asset || null;
        const b = servedFrom ? await httpBytes(servedFrom) : null;
        servedSha = b ? sha(b.buf) : null;
      }
      const verdict = servedBytesVerdict({ surfaceId: s.id, servedSha, intendedSha, servedFrom, fallbackAsset: s.deceptiveFallback?.asset });
      r.reachedLayer = LAYERS.SERVED_BYTES.id; r.reachedLayerRank = LAYERS.SERVED_BYTES.rank;
      r.detail = {
        clientRequest: s.clientResolution.request, clientCarriesAuth: s.clientResolution.carriesAuth,
        clientRequestStatus: clientReq.status, serverResolvesTo: intendedUri, serverResolveStatus: authedResolve.status,
        doorServes: servedFrom, servedSha: short(servedSha), intendedSha: short(intendedSha), verdict: verdict.reason
      };
      if (verdict.failure) { r.status = "FAIL"; r.why = verdict.reason; }
      else r.why = "door served the intended asset (served bytes == resolved)";
    } else {
      // authed-payload surface: the art URI rides INSIDE the authed payload the browser
      // already receives, and the byte serve (/data/assets/library) is public. So a
      // guest/auth divergence is STRUCTURALLY impossible here — verified at the route
      // layer. Byte-level requires a run WITH committed (cooked) art; not done (no-cook).
      r.reachedLayer = LAYERS.HTTP_AUTHED.id; r.reachedLayerRank = LAYERS.HTTP_AUTHED.rank;
      r.why = `art URI rides the AUTHED payload (${s.clientResolution.payloadField}); no separate art request → no auth-divergence class. Byte-level UNVERIFIED (needs a committed/cooked asset; not run under the no-cook constraint).`;
    }

    // aspect / crop (Job 3.3) — computed for every art surface
    if (s.cookKey && s.displayKey) {
      const [cw, ch] = COOK[s.cookKey].dims;
      const cookAspect = cw / ch;
      const dispAspect = evalDisplayAspect(DISPLAY[s.displayKey], REFERENCE_VIEWPORT);
      const crop = cropInfo(cookAspect, dispAspect);
      r.detail.aspect = {
        cook: `${cw}x${ch} (${round2(cookAspect)})`, cookRef: COOK[s.cookKey].ref,
        display: `${round2(dispAspect)} @ ${REFERENCE_VIEWPORT.label}`, displayRef: DISPLAY[s.displayKey].ref,
        crop: `${crop.cropPct}% ${crop.axis}`, overThreshold: crop.cropPct != null && crop.cropPct > CROP_THRESHOLD_PCT
      };
      if (r.detail.aspect.overThreshold) {
        r.aspectFinding = `${s.id}: display crops ${crop.cropPct}% ${crop.axis} (cook ${round2(cookAspect)} vs display ${round2(dispAspect)}) — over ${CROP_THRESHOLD_PCT}% threshold`;
        if (r.status !== "FAIL") r.status = "FINDING";
      }
    }
    report.surfaces.push(r);
  }

  // ── JOB 2: guest vs authed diff ───────────────────────────────────────────
  const wc = report.surfaces.find((x) => x.id === "world-card");
  report.jobs.job2_guest = {
    guestSessionToken: Boolean(token),
    worldCardGuestRequestStatus: wc?.detail?.clientRequestStatus,
    worldCardServerResolvesTo: wc?.detail?.serverResolvesTo,
    worldCardDoorServes: wc?.detail?.doorServes,
    silentDegrade: wc?.status === "FAIL",
    note: wc?.status === "FAIL"
      ? "A guest (and every logged-in user, since the client's world-card fetch omits the token) sees a bundled default, not the resolved asset. FIRST-USER EXPERIENCE NEVER TESTED before this harness."
      : "no silent art degrade detected for a guest on the world-card"
  };

  // ── JOB 4: silent-fallback inventory ──────────────────────────────────────
  report.jobs.job4_fallbacks = SILENT_FALLBACKS.map((f) => ({ id: f.id, classification: f.classification, harnessDetects: f.harnessDetects, userSees: f.userSees, ref: f.ref, recommend: f.recommend }));
  report.jobs.job4_architectural_defects = SILENT_FALLBACKS.filter((f) => f.classification === "deceptive");

  // ── JOB 5: coherence (in-process, $0) ─────────────────────────────────────
  report.jobs.job5_coherence = runAllCoherence("babel").map((c) => ({ name: c.name, ok: c.ok, failed: c.failed, total: c.total, failures: c.findings.filter((x) => !x.ok).map((x) => x.detail), warnings: c.warnings || [] }));

  // ── JOB 6: honesty — UNVERIFIED list + coverage verdict + cannot-catch ────
  const cov = coverageVerdict(report.surfaces);
  const coherenceFail = report.jobs.job5_coherence.some((c) => !c.ok);
  const anyFail = report.surfaces.some((s) => s.status === "FAIL") || coherenceFail;
  const findings = report.surfaces.filter((s) => s.status === "FINDING").map((s) => s.aspectFinding);
  report.jobs.job6_unverified = report.surfaces
    .filter((s) => s.playerFacing && !s.noArt && s.reachedLayerRank < LAYERS.SERVED_BYTES.rank)
    .map((s) => ({ surface: s.id, stoppedAtLayer: s.reachedLayer, why: s.why }));
  report.jobs.job6_cannot_catch = CANNOT_CATCH;

  report.verdict = {
    walkReady: cov.walkReady && !anyFail,
    hardFails: [...cov.fails, ...(coherenceFail ? ["coherence"] : [])],
    aspectFindings: findings,
    surfacesBelowHttpLayer: cov.belowHttpCount,
    surfacesBelowDoorLayer: cov.unverifiedBelowDoor.length,
    unverifiedBelowDoor: cov.unverifiedBelowDoor,
    reason: cov.walkReady && !anyFail
      ? "no FAIL and every player-facing art surface reached at least the door layer"
      : anyFail ? "a surface or a coherence check FAILED — not walk-ready"
      : "player-facing surfaces remain verified only below the door layer — not walk-ready"
  };

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); }
  else printHuman(report);
  // Green ONLY when fully clean: walk-ready (no broken door) AND no open findings
  // (an over-threshold crop is a finding, not a note — it must keep the run non-green).
  const clean = report.verdict.walkReady && report.verdict.aspectFindings.length === 0;
  process.exit(clean ? 0 : 1);
}

function printHuman(r) {
  const P = (s) => console.log(s);
  P(`\n=== WALK-DOOR HARNESS ===  base=${r.base}  build=${r.build?.sha || "?"}\n`);
  P("JOB 1 — verification layers (weakest→strongest):");
  for (const l of r.jobs.job1_layers) P(`  [${l.rank}] ${l.layer.padEnd(13)} catches: ${l.catches}`);
  P("\nPER-SURFACE (the route-inventory, made explicit):");
  P("  surface           kind             reached-layer   status");
  for (const s of r.surfaces) P(`  ${s.id.padEnd(17)} ${s.clientKind.padEnd(16)} ${String(s.reachedLayer).padEnd(15)} ${s.status}`);
  P("\nJOB 2 — guest / first-user:");
  P(`  world-card guest request: HTTP ${r.jobs.job2_guest.worldCardGuestRequestStatus} · server resolves: ${r.jobs.job2_guest.worldCardServerResolvesTo || "—"} · door serves: ${r.jobs.job2_guest.worldCardDoorServes}`);
  P(`  ${r.jobs.job2_guest.silentDegrade ? "✗ SILENT DEGRADE" : "✓ no silent degrade"} — ${r.jobs.job2_guest.note}`);
  P("\nJOB 3 — served bytes + aspect:");
  for (const s of r.surfaces.filter((x) => x.detail?.verdict || x.detail?.aspect)) {
    if (s.detail.verdict) P(`  ${s.id}: ${s.detail.verdict}`);
    if (s.detail.aspect) P(`  ${s.id} aspect: cook ${s.detail.aspect.cook} vs display ${s.detail.aspect.display} → crop ${s.detail.aspect.crop}${s.detail.aspect.overThreshold ? "  ⚠ OVER THRESHOLD" : ""}`);
  }
  P("\nJOB 4 — silent fallbacks (deceptive = architectural defect):");
  for (const f of r.jobs.job4_fallbacks) P(`  [${f.classification}] ${f.id} — ${f.userSees}${f.classification === "deceptive" ? "\n      RECOMMEND: " + f.recommend : ""}`);
  P("\nJOB 5 — coherence (in-process, $0):");
  for (const c of r.jobs.job5_coherence) { P(`  ${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.failed}/${c.total})`); for (const f of c.failures) P(`      ✗ ${f}`); for (const w of c.warnings) P(`      ⚠ ${w}`); }
  P("\nJOB 6 — HONESTY:");
  P("  UNVERIFIED (verified only below the door layer):");
  if (r.jobs.job6_unverified.length === 0) P("    (none)");
  for (const u of r.jobs.job6_unverified) P(`    · ${u.surface} — stopped at ${u.stoppedAtLayer}: ${u.why}`);
  P("  THIS HARNESS STRUCTURALLY CANNOT CATCH:");
  for (const c of r.jobs.job6_cannot_catch) P(`    · ${c}`);
  P(`\n=== VERDICT: ${r.verdict.walkReady ? "WALK-READY" : "NOT WALK-READY"} ===`);
  P(`  ${r.verdict.reason}`);
  if (r.verdict.hardFails.length) P(`  HARD FAILS: ${r.verdict.hardFails.join(", ")}`);
  if (r.verdict.aspectFindings.length) for (const f of r.verdict.aspectFindings) P(`  ASPECT FINDING: ${f}`);
  P(`  surfaces verified only below HTTP: ${r.verdict.surfacesBelowHttpLayer} · below door: ${r.verdict.surfacesBelowDoorLayer}`);
  P("");
}
function short(s) { return s ? String(s).slice(0, 12) : "—"; }
function round2(n) { return Math.round(n * 100) / 100; }
function fail(msg) { console.error("HARNESS FATAL: " + msg); process.exit(2); }

main().catch((e) => fail(e?.stack || String(e)));
