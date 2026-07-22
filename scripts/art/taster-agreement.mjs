// TASTER vs OWNER agreement report (JOB 5 — the payoff).
//
// Reads the owner-verdict dataset (data/owner-verdicts.jsonl, collected by the beta
// thumb) and, for every asset the owner judged where the taster ALSO recorded a
// verdict, computes: total judged, agreement rate, and the DISAGREEMENT BREAKDOWN
// (taster keep / owner trash, and the reverse), sliced by image kind and reason chip.
//
// THE FALSE-KEEP RATE is the number that matters most: assets the taster waved through
// that the owner would bin. Prints an HONEST small-sample warning — a confident
// agreement rate on a handful of assets is noise, and must not read as a finding.
//
// Usage: node scripts/art/taster-agreement.mjs [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const LOG = process.env.NOTDND_OWNER_VERDICTS_PATH || path.join(REPO, "data", "owner-verdicts.jsonl");
const MIN_MEANINGFUL = Number(process.env.NOTDND_AGREEMENT_MIN_SAMPLE) || 30;

const tasterKeep = (v) => ["fridge", "pass", "keep"].includes(String(v || "").toLowerCase());
const tasterBin = (v) => ["trash", "suspect", "toss"].includes(String(v || "").toLowerCase());

function loadLatestPerAsset() {
  let lines = [];
  try { lines = fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()); } catch { return new Map(); }
  const latest = new Map(); // assetId -> the most recent up/down record (clear removes)
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.assetId) continue;
    if (r.verdict === "clear") { latest.delete(r.assetId); continue; }
    if (r.verdict !== "up" && r.verdict !== "down") continue;
    latest.set(r.assetId, r); // later lines overwrite (append-only history, latest wins)
  }
  return latest;
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + "%" : "n/a"; }

function main() {
  const asJson = process.argv.includes("--json");
  const latest = loadLatestPerAsset();
  const all = [...latest.values()];
  const up = all.filter((r) => r.verdict === "up").length;
  const down = all.filter((r) => r.verdict === "down").length;
  const paired = all.filter((r) => r.tasterVerdict != null && (tasterKeep(r.tasterVerdict) || tasterBin(r.tasterVerdict)));

  let agree = 0, falseKeep = 0, falseBin = 0;
  const byKind = {}; const byReason = {};
  for (const r of paired) {
    const ownerKeep = r.verdict === "up";
    const tKeep = tasterKeep(r.tasterVerdict);
    const agreed = ownerKeep === tKeep;
    if (agreed) agree++;
    if (tKeep && !ownerKeep) falseKeep++;      // taster kept, owner would bin — THE number
    if (!tKeep && ownerKeep) falseBin++;        // taster binned, owner would keep
    const k = r.kind || "unknown";
    byKind[k] = byKind[k] || { paired: 0, agree: 0, falseKeep: 0, falseBin: 0 };
    byKind[k].paired++; if (agreed) byKind[k].agree++; if (tKeep && !ownerKeep) byKind[k].falseKeep++; if (!tKeep && ownerKeep) byKind[k].falseBin++;
    if (!ownerKeep) for (const reason of (r.reasons || [])) {
      byReason[reason] = byReason[reason] || { downs: 0, falseKeep: 0 };
      byReason[reason].downs++; if (tKeep) byReason[reason].falseKeep++;
    }
  }

  const report = {
    dataset: LOG,
    totalOwnerJudged: all.length, up, down,
    tasterPaired: paired.length,
    unpaired: all.length - paired.length,
    agreementRate: paired.length ? agree / paired.length : null,
    falseKeep, falseBin,
    byKind, byReason,
    meaningful: paired.length >= MIN_MEANINGFUL
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log("TASTER vs OWNER — agreement report");
  console.log("dataset: " + LOG);
  if (all.length === 0) { console.log("\nNO owner verdicts yet. Walk the game with the beta thumb on, then re-run."); return; }
  console.log("\nowner-judged assets: " + all.length + "  (up " + up + " · down " + down + ")");
  console.log("taster ALSO judged (the comparable pairs): " + paired.length + "  (unpaired, no taster verdict: " + report.unpaired + ")");

  if (paired.length === 0) {
    console.log("\n⚠ ZERO paired assets — the taster has no recorded verdict for anything the owner judged.");
    console.log("  The agreement rate is UNCOMPUTABLE, not 100%. The taster only judged its one quarantine batch;");
    console.log("  either thumb those assets, or persist a taster verdict at cook/intake so future thumbs pair up.");
    return;
  }

  console.log("\nagreement rate: " + pct(agree, paired.length) + "  (" + agree + "/" + paired.length + ")");
  console.log("  FALSE-KEEP (taster kept, owner would BIN — the number that matters): " + falseKeep + "  [" + pct(falseKeep, paired.length) + "]");
  console.log("  false-bin  (taster binned, owner would keep):                        " + falseBin + "  [" + pct(falseBin, paired.length) + "]");

  console.log("\nby image kind:");
  for (const [k, s] of Object.entries(byKind)) console.log("  " + k.padEnd(11) + " pairs " + String(s.paired).padStart(3) + " · agree " + pct(s.agree, s.paired).padStart(6) + " · false-keep " + s.falseKeep + " · false-bin " + s.falseBin);
  if (Object.keys(byReason).length) {
    console.log("\nby reason chip (owner-down reasons; false-keep = taster had kept it anyway):");
    for (const [r, s] of Object.entries(byReason).sort((a, b) => b[1].falseKeep - a[1].falseKeep)) console.log("  " + r.padEnd(14) + " downs " + String(s.downs).padStart(3) + " · false-keep " + s.falseKeep);
  }

  if (!report.meaningful) {
    console.log("\n⚠⚠ SMALL SAMPLE (" + paired.length + " pairs < " + MIN_MEANINGFUL + "). This rate is NOISE, not a finding.");
    console.log("   Do not act on it. Collect more owner verdicts on taster-judged assets before trusting any number above.");
  }
}

main();
