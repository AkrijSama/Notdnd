// ---------------------------------------------------------------------------
// TASTE-QUARANTINE — run the REAL (vision) fridge taster over library assets.
//
//   node --env-file=.env scripts/art/taste-quarantine.mjs --calibrate
//       Calibration: 3 known-good keeps must PASS, 1 planted wrong-subject must FLAG.
//
//   node --env-file=.env scripts/art/taste-quarantine.mjs
//       DRY RUN over every quarantined asset -> verdict table. MUTATES NOTHING.
//
//   node --env-file=.env scripts/art/taste-quarantine.mjs --apply <id>=fridge,<id>=trash
//   node --env-file=.env scripts/art/taste-quarantine.mjs --apply accept-recommendations
//       OWNER-STAMPED execution. Only this mode ever changes state.
//
// Quarantine resolution on the first batch is owner-stamped by law: this tool
// PRESENTS verdicts and never auto-destroys. Per-image cost is logged to the
// fridge-taster cost ledger and printed at the end.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { allAssets, getAsset, libraryRoot } from "./library.mjs";
import { listQuarantined, resolveQuarantine } from "../../server/solo/fridgeTaster.js";
import { visionAssess, tasterLedger, TASTER_VISION_MODEL, TASTER_VISION_PRICING } from "../../server/ai/tasterVision.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valAfter = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

// HARD COST FENCE for this tool (owner dispatch 2026-07-21): ≤ $0.05 total.
const COST_FENCE_USD = Number(process.env.NOTDND_TASTER_COST_FENCE_USD || 0.05);

function pngFor(id) {
  return path.join(libraryRoot(), `${id}.png`);
}

function readBytes(id) {
  const p = pngFor(id);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

// What a LIBRARY asset is supposed to depict, derived from its id/tags/prompt.
// There is no live run here, so this is the offline mirror of
// imageWorker.expectedSubjectFor. Unknown => "" => the assessor treats the
// "expected subject present?" question as n/a rather than failing it.
export function expectedSubjectForAsset(a) {
  const id = String(a.id || "");
  const tags = (Array.isArray(a.tags) ? a.tags : []).map(String);
  const subjectTag = tags.find((t) => t.startsWith("subject:")) || "";
  const subject = subjectTag.replace("subject:", "");
  if (a.kind === "portrait" || a.kind === "fullbody") {
    // Species truth is encoded in the npc id/subject slug for live assets.
    if (/wolf/i.test(id) || /wolf/i.test(subject)) {
      return "a wolf — a four-legged animal, NOT a human";
    }
    if (/creature|chaosling|beast/i.test(id) || /creature|chaosling|beast/i.test(subject)) {
      return "a non-human creature (not an ordinary human person)";
    }
    if (/player/i.test(id)) return "the player character — a human person";
    return ""; // unknown named NPC -> n/a, judged on the generic canon questions
  }
  if (a.kind === "scene" || a.kind === "world-card") {
    // The location name is the leading clause of the assembled prompt.
    const p = String(a.promptUsed || "");
    const lead = p.split(",").slice(0, 2).join(",").trim();
    return lead.length > 8 ? lead.slice(0, 160) : "";
  }
  return "";
}

async function assessAsset(a, { expectedOverride = null } = {}) {
  const bytes = readBytes(a.id);
  if (!bytes) return { id: a.id, error: "png missing on disk" };
  try {
    const r = await visionAssess({
      id: a.id,
      bytes,
      kind: a.kind,
      promptUsed: a.promptUsed || "",
      expectedSubject: expectedOverride != null ? expectedOverride : expectedSubjectForAsset(a)
    });
    return { id: a.id, kind: a.kind, world: a.world, ...r };
  } catch (error) {
    return { id: a.id, kind: a.kind, world: a.world, error: String(error?.message || error) };
  }
}

function fenceCheck(label) {
  const spent = tasterLedger().totals().costUsd;
  if (spent > COST_FENCE_USD) {
    console.error(`\nCOST FENCE HIT ($${spent.toFixed(4)} > $${COST_FENCE_USD.toFixed(2)}) — stopping before ${label}.`);
    printLedger();
    process.exit(2);
  }
}

function printLedger() {
  const t = tasterLedger().totals();
  console.log(
    `\n[cost ledger] model=${TASTER_VISION_MODEL} · ${t.calls} images · ${t.promptTokens}+${t.completionTokens} tok · ` +
      `$${t.costUsd.toFixed(5)} total · $${(t.calls ? t.costUsd / t.calls : 0).toFixed(6)}/image ` +
      `· fence $${COST_FENCE_USD.toFixed(2)} (${t.costUsd <= COST_FENCE_USD ? "UNDER" : "OVER"})`
  );
  console.log(
    `[pricing] $${TASTER_VISION_PRICING.promptPerM}/M in · $${TASTER_VISION_PRICING.completionPerM}/M out`
  );
}

// ── CALIBRATION ──────────────────────────────────────────────────────────────
// 3 known-good fridge keeps must PASS; 1 PLANTED wrong-subject must FLAG. The
// plant reuses a REAL asset (no new cooking) but declares a subject it does not
// depict — the biplane-class question: "is the expected subject actually here?"
const CALIBRATION_GOOD = [
  { id: "w7_player_illustrated_exemplar", expected: "Corin Vale — a human man, ordinary human person" },
  { id: "babel-portrait-courier-realistic", expected: "a human man, a courier" },
  { id: "w7_player_cinematic_exemplar", expected: "Corin Vale — a human man, ordinary human person" }
];

// Cases that MUST be flagged.
//  1. PLANTED wrong-subject — a real asset declared as something it does not depict.
//  2. A REAL modern-intrusion find surfaced by calibration itself: this asset is a
//     current fridge KEEP whose pixels show a woman with an umbrella beside TRAIN
//     TRACKS under a POWER-LINE TOWER in a pre-modern fantasy world. It is the
//     biplane class, live in the library. With the committed setting supplied, the
//     taster must catch it.
const CALIBRATION_FLAG = [
  {
    id: "live_run_f5_loc_loc_waking_mile",
    label: "PLANTED wrong-subject",
    expected: "a bustling stone marketplace crowded with merchant stalls and townsfolk at noon"
  },
  {
    id: "babel-scene-hollow-pine-anime",
    label: "REAL modern-intrusion (a live fridge keep)",
    expected: ""
  }
];

async function calibrate() {
  console.log(`CALIBRATION — model ${TASTER_VISION_MODEL}\n`);
  let pass = 0;
  let fail = 0;

  for (const c of CALIBRATION_GOOD) {
    const a = getAsset(c.id);
    if (!a) {
      console.log(`  SKIP  ${c.id} — not in library`);
      continue;
    }
    fenceCheck(c.id);
    const r = await assessAsset(a, { expectedOverride: c.expected });
    const ok = r.verdict === "pass";
    console.log(`  ${ok ? "OK  " : "MISS"} known-good ${c.id}`);
    console.log(`        verdict=${r.verdict || "ERROR"} observed="${r.observedSubject || r.error || ""}"`);
    if (!ok) console.log(`        reason: ${r.reason || r.error}`);
    ok ? (pass += 1) : (fail += 1);
  }

  for (const c of CALIBRATION_FLAG) {
    const a = getAsset(c.id);
    if (!a) {
      console.log(`  SKIP  ${c.id} — not in library`);
      continue;
    }
    fenceCheck(c.id);
    const r = await assessAsset(a, { expectedOverride: c.expected });
    const flagged = r.verdict === "suspect";
    console.log(`  ${flagged ? "OK  " : "MISS"} ${c.label} ${c.id}`);
    if (c.expected) console.log(`        declared="${c.expected}"`);
    console.log(`        verdict=${r.verdict || "ERROR"} observed="${r.observedSubject || r.error || ""}"`);
    console.log(`        reason: ${r.reason || r.error || ""}`);
    flagged ? (pass += 1) : (fail += 1);
  }

  console.log(`\nCALIBRATION RESULT: ${pass} correct, ${fail} wrong.`);
  printLedger();
  return fail === 0;
}

// ── DRY RUN over the quarantine pen ──────────────────────────────────────────
function recommendFate(r) {
  if (r.error) return "hold (assessment error)";
  return r.verdict === "pass" ? "fridge" : "trash";
}

async function dryRun() {
  const pen = listQuarantined();
  console.log(`QUARANTINE PEN — ${pen.length} assets · model ${TASTER_VISION_MODEL} · DRY RUN (nothing is mutated)\n`);
  const rows = [];
  for (const a of pen) {
    fenceCheck(a.id);
    const r = await assessAsset(a);
    rows.push({ ...r, recommend: recommendFate(r), expected: expectedSubjectForAsset(a) });
    console.log(`  ${r.verdict === "pass" ? "PASS   " : r.error ? "ERROR  " : "SUSPECT"} ${a.id}`);
  }

  console.log("\n" + "=".repeat(112));
  console.log("VERDICT TABLE (owner-stamped resolution required — NOTHING destroyed)");
  console.log("=".repeat(112));
  for (const r of rows) {
    console.log(`\n  asset      : ${r.id}`);
    console.log(`  kind/world : ${r.kind} / ${r.world ?? "-"}`);
    console.log(`  expected   : ${r.expected || "(unknown — judged on generic canon questions)"}`);
    console.log(`  observed   : ${r.observedSubject || "-"}`);
    console.log(`  verdict    : ${r.error ? "ERROR" : r.verdict}`);
    console.log(`  reason     : ${r.reason || r.error || "-"}`);
    console.log(`  RECOMMEND  : ${r.recommend}`);
  }
  const keep = rows.filter((r) => r.recommend === "fridge").length;
  const trash = rows.filter((r) => r.recommend === "trash").length;
  const hold = rows.filter((r) => r.recommend.startsWith("hold")).length;
  console.log(`\nSUMMARY: ${keep} → fridge · ${trash} → trash · ${hold} → hold`);
  console.log("Resolve with: --apply <id>=fridge,<id>=trash   (or --apply accept-recommendations)");
  printLedger();

  // Machine-readable sidecar for the report / a later --apply.
  const out = path.join(libraryRoot(), "..", "quarantine-verdicts.json");
  try {
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model: TASTER_VISION_MODEL, rows }, null, 2));
    console.log(`\nverdicts written: ${out}`);
  } catch { /* best-effort */ }
  return rows;
}

// ── APPLY (owner-stamped) ────────────────────────────────────────────────────
async function apply(spec) {
  let fates = new Map();
  if (spec === "accept-recommendations") {
    const out = path.join(libraryRoot(), "..", "quarantine-verdicts.json");
    if (!fs.existsSync(out)) {
      console.error("no quarantine-verdicts.json — run the dry run first.");
      process.exit(1);
    }
    const saved = JSON.parse(fs.readFileSync(out, "utf8"));
    for (const r of saved.rows || []) {
      if (r.recommend === "fridge" || r.recommend === "trash") fates.set(r.id, r.recommend);
    }
  } else {
    for (const pair of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [id, fate] = pair.split("=");
      if (!id || !["fridge", "trash"].includes(fate)) {
        console.error(`bad --apply entry "${pair}" (expected <id>=fridge|trash)`);
        process.exit(1);
      }
      fates.set(id, fate);
    }
  }
  console.log(`APPLYING ${fates.size} owner-stamped fates:\n`);
  for (const [id, fate] of fates) {
    try {
      const r = resolveQuarantine(id, fate);
      console.log(`  ${fate.toUpperCase().padEnd(6)} ${id}${r.destroyed ? " (destroyed)" : ""}`);
    } catch (e) {
      console.error(`  FAILED ${id}: ${e.message}`);
    }
  }
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY && !has("--apply")) {
    console.error("OPENROUTER_API_KEY is not set — run with `node --env-file=.env`.");
    process.exit(1);
  }
  if (has("--calibrate")) {
    const ok = await calibrate();
    process.exit(ok ? 0 : 1);
  }
  if (has("--apply")) {
    await apply(valAfter("--apply"));
    return;
  }
  await dryRun();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
