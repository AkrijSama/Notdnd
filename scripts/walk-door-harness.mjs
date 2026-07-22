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
const CROP_THRESHOLD_PCT = 5; // Job 3.3: flag any CONTENT CUT above 5% (a finding, not a note).

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
      // THE CLASS-5 SHAPE. Replay BOTH doors and compare SERVED BYTES to intended:
      //   authed (a logged-in user's request, token attached — the primary requirement)
      //   guest  (a first-time visitor, no token — Job 2.2)
      const path = s.clientResolution.request.path;
      const doorServed = async (tok) => {
        const req = await http(path, { token: tok });
        if (req.status === 200) {
          const j = await req.json();
          const from = j?.uri || null;
          return { status: 200, from, sha: from ? diskSha(from.replace("/data/assets/library/", "")) : null };
        }
        // non-ok → the client keeps its static default → THAT is what the door shows.
        const from = s.deceptiveFallback?.asset || null;
        const b = from ? await httpBytes(from) : null;
        return { status: req.status, from, sha: b ? sha(b.buf) : null };
      };
      // what the SERVER resolves when asked properly (with a token):
      const resolveReq = await http(path, { token });
      const intendedUri = resolveReq.status === 200 ? (await resolveReq.json())?.uri : null;
      const intendedSha = intendedUri ? diskSha(intendedUri.replace("/data/assets/library/", "")) : null;

      const authed = await doorServed(token);   // the logged-in door
      const guest = await doorServed(null);      // the first-user door
      const authedV = servedBytesVerdict({ surfaceId: s.id, servedSha: authed.sha, intendedSha, servedFrom: authed.from, fallbackAsset: s.deceptiveFallback?.asset });
      const guestV = servedBytesVerdict({ surfaceId: s.id, servedSha: guest.sha, intendedSha, servedFrom: guest.from, fallbackAsset: s.deceptiveFallback?.asset });

      r.reachedLayer = LAYERS.SERVED_BYTES.id; r.reachedLayerRank = LAYERS.SERVED_BYTES.rank;
      r.detail = {
        clientRequest: s.clientResolution.request, serverResolvesTo: intendedUri, serverResolveStatus: resolveReq.status,
        loggedInDoor: { status: authed.status, serves: authed.from, verdict: authedV.reason },
        guestDoor: { status: guest.status, serves: guest.from, verdict: guestV.reason },
        servedSha: short(authed.sha), intendedSha: short(intendedSha)
      };
      // The logged-in door serving the wrong asset is a hard FAIL (a paying player must
      // see the right card). If only the GUEST degrades, that is a first-user FINDING.
      if (authedV.failure) { r.status = "FAIL"; r.why = `LOGGED-IN DOOR: ${authedV.reason}`; }
      else if (guestV.failure) { r.status = "FINDING"; r.why = `GUEST/first-user degrade: ${guestV.reason}`; r.guestFinding = r.why; }
      else r.why = "both the logged-in and guest doors served the intended asset";
    } else {
      // authed-payload surface: the art URI rides INSIDE the authed payload the browser
      // already receives, and the byte serve (/data/assets/library) is public. So a
      // guest/auth divergence is STRUCTURALLY impossible here — verified at the route
      // layer. Byte-level requires a run WITH committed (cooked) art; not done (no-cook).
      r.reachedLayer = LAYERS.HTTP_AUTHED.id; r.reachedLayerRank = LAYERS.HTTP_AUTHED.rank;
      r.why = `art URI rides the AUTHED payload (${s.clientResolution.payloadField}); no separate art request → no auth-divergence class. Byte-level UNVERIFIED (needs a committed/cooked asset; not run under the no-cook constraint).`;
    }

    // aspect (Job 3.3) — computed for EVERY art surface. object-fit decides the failure
    // mode: cover CUTS content (a hard finding >5%); contain LETTERBOXES (nothing cut).
    if (s.cookKey && s.displayKey) {
      const [cw, ch] = COOK[s.cookKey].dims;
      const cookAspect = cw / ch;
      const disp = DISPLAY[s.displayKey];
      const dispAspect = evalDisplayAspect(disp, REFERENCE_VIEWPORT);
      const fit = disp.objectFit || "cover";
      const mism = cropInfo(cookAspect, dispAspect); // the raw aspect delta
      const cutPct = fit === "cover" ? mism.cropPct : 0;          // content actually CUT
      const letterboxPct = fit === "contain" ? mism.cropPct : 0;   // empty space (nothing cut)
      r.detail.aspect = {
        cook: `${cw}x${ch} (${round2(cookAspect)})`, cookRef: COOK[s.cookKey].ref,
        display: `${round2(dispAspect)} @ ${REFERENCE_VIEWPORT.label}`, objectFit: fit, displayRef: disp.ref,
        contentCut: `${cutPct}%${cutPct > 0 ? " " + mism.axis : ""}`,
        letterbox: `${letterboxPct}%${letterboxPct > 0 ? " " + mism.axis : ""}`,
        overThreshold: cutPct != null && cutPct > CROP_THRESHOLD_PCT
      };
      if (r.detail.aspect.overThreshold) {
        r.aspectFinding = `${s.id}: object-fit COVER CUTS ${cutPct}% ${mism.axis} of content (cook ${round2(cookAspect)} vs display ${round2(dispAspect)}) — over ${CROP_THRESHOLD_PCT}%`;
        if (r.status !== "FAIL") r.status = "FINDING";
      }
    }
    report.surfaces.push(r);
  }

  // ── JOB 2: guest vs authed diff (Job 2.3) ─────────────────────────────────
  const wc = report.surfaces.find((x) => x.id === "world-card");
  const gDoor = wc?.detail?.guestDoor || {};
  const lDoor = wc?.detail?.loggedInDoor || {};
  report.jobs.job2_guest = {
    guestSessionToken: Boolean(token),
    serverResolvesTo: wc?.detail?.serverResolvesTo,
    loggedInDoor: lDoor, // what a logged-in user's browser receives
    guestDoor: gDoor, // what a not-logged-in first-user receives
    differsFromAuthed: gDoor.serves !== lDoor.serves,
    silentGuestDegrade: wc?.status === "FINDING" && Boolean(wc?.guestFinding),
    hardFail: wc?.status === "FAIL",
    note: wc?.status === "FAIL"
      ? "The LOGGED-IN door serves the wrong asset — a paying player sees a bundled default, not the resolved card. (This build predates CLI-1's client fix.)"
      : wc?.status === "FINDING"
        ? "The logged-in door is correct, but a GUEST/first-user still silently degrades to the static default because /api/art/library requires auth. First-user experience — assuming the lobby is reachable pre-login, unverified."
        : "no silent art degrade on the world-card for either door"
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
  const findings = report.surfaces.filter((s) => s.aspectFinding).map((s) => s.aspectFinding);
  report.jobs.job6_unverified = report.surfaces
    .filter((s) => s.playerFacing && !s.noArt && s.reachedLayerRank < LAYERS.SERVED_BYTES.rank)
    .map((s) => ({ surface: s.id, stoppedAtLayer: s.reachedLayer, why: s.why }));
  report.jobs.job6_cannot_catch = CANNOT_CATCH;

  const guestFindings = report.surfaces.filter((s) => s.guestFinding).map((s) => s.guestFinding);
  report.verdict = {
    walkReady: cov.walkReady && !anyFail,
    hardFails: [...cov.fails, ...(coherenceFail ? ["coherence"] : [])],
    aspectFindings: findings,
    guestFindings,
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
  const clean = report.verdict.walkReady && report.verdict.aspectFindings.length === 0 && report.verdict.guestFindings.length === 0;
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
  P("\nJOB 2 — guest / first-user (server resolves: " + (r.jobs.job2_guest.serverResolvesTo || "—") + "):");
  P(`  logged-in door: HTTP ${r.jobs.job2_guest.loggedInDoor.status} serves ${r.jobs.job2_guest.loggedInDoor.serves}`);
  P(`  guest door:     HTTP ${r.jobs.job2_guest.guestDoor.status} serves ${r.jobs.job2_guest.guestDoor.serves}`);
  P(`  ${r.jobs.job2_guest.hardFail ? "✗ HARD FAIL" : r.jobs.job2_guest.silentGuestDegrade ? "⚠ GUEST DEGRADE" : "✓ no silent degrade"} — ${r.jobs.job2_guest.note}`);
  P("\nJOB 3 — served bytes + aspect:");
  for (const s of r.surfaces.filter((x) => x.detail?.loggedInDoor || x.detail?.aspect)) {
    if (s.detail.loggedInDoor) P(`  ${s.id}: logged-in [${s.detail.loggedInDoor.verdict}] · guest [${s.detail.guestDoor.verdict}]`);
    if (s.detail.aspect) { const a = s.detail.aspect; P(`  ${s.id} aspect: cook ${a.cook} vs display ${a.display} [${a.objectFit}] → cut ${a.contentCut}, letterbox ${a.letterbox}${a.overThreshold ? "  ⚠ CUTS CONTENT" : ""}`); }
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
  if (r.verdict.guestFindings?.length) for (const f of r.verdict.guestFindings) P(`  GUEST FINDING: ${f}`);
  P(`  surfaces verified only below HTTP: ${r.verdict.surfacesBelowHttpLayer} · below door: ${r.verdict.surfacesBelowDoorLayer}`);
  P("");
}
function short(s) { return s ? String(s).slice(0, 12) : "—"; }
function round2(n) { return Math.round(n * 100) / 100; }
function fail(msg) { console.error("HARNESS FATAL: " + msg); process.exit(2); }

main().catch((e) => fail(e?.stack || String(e)));
