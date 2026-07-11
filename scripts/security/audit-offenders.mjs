#!/usr/bin/env node
// INJECTION-ATTEMPT VISIBILITY (anti-tamper phase 1, item 3). Read-only tooling:
// aggregates the live auditors' flag lines (system-lore / deadline-referent /
// pronoun-enforcement / spit / repeated-gesture / phantom-commit) from the
// per-run transcript logs into per-user counts — the ban-review list.
// NO auto-bans, NO thresholds. Humans decide.
//
// Usage: node scripts/security/audit-offenders.mjs [--days N] [--dir data/logs/runs]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const DIR = path.resolve(process.cwd(), argVal("--dir", "data/logs/runs"));
const DAYS = Number(argVal("--days", "14"));
const cutoff = Date.now() - DAYS * 86_400_000;

const FLAG_RES = [
  { kind: "system-lore", re: /system-lore VIOLATION:.*user=(\S+)/ },
  { kind: "deadline-referent", re: /deadline-referent VIOLATION:.*user=(\S+)/ },
  { kind: "pronoun-repair", re: /pronoun-enforcement repaired.*user=(\S+)/ },
  { kind: "spit", re: /spit VIOLATION.*user=(\S+)/ },
  { kind: "repeated-gesture", re: /repeated-gesture guard:.*user=(\S+)/ },
  { kind: "phantom-commit", re: /#27\/B2 committed.*user=(\S+)/ },
  // pre-item-3 lines carry no user= — count them under (unattributed) so the
  // historical volume stays visible instead of silently vanishing.
  { kind: "system-lore", re: /system-lore VIOLATION:(?!.*user=)/, anon: true },
  { kind: "deadline-referent", re: /deadline-referent VIOLATION:(?!.*user=)/, anon: true },
  { kind: "spit", re: /spit VIOLATION(?!.*user=)/, anon: true },
  { kind: "pronoun-repair", re: /pronoun-enforcement repaired(?!.*user=)/, anon: true },
  { kind: "repeated-gesture", re: /repeated-gesture guard:(?!.*user=)/, anon: true },
  { kind: "phantom-commit", re: /#27\/B2 committed(?!.*user=)/, anon: true }
];

if (!fs.existsSync(DIR)) {
  console.log(`no log dir at ${DIR} — nothing to report`);
  process.exit(0);
}

const perUser = new Map(); // user -> { kind -> count }
let files = 0;
for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith(".log")) continue;
  const full = path.join(DIR, name);
  const stat = fs.statSync(full);
  if (stat.mtimeMs < cutoff) continue;
  files += 1;
  const text = fs.readFileSync(full, "utf8");
  for (const line of text.split("\n")) {
    for (const { kind, re, anon } of FLAG_RES) {
      const m = re.exec(line);
      if (!m) continue;
      const user = anon ? "(unattributed)" : m[1];
      const rec = perUser.get(user) || {};
      rec[kind] = (rec[kind] || 0) + 1;
      perUser.set(user, rec);
      break;
    }
  }
}

console.log(`audit-offenders — ${files} run log(s) scanned (last ${DAYS}d, ${DIR})`);
if (perUser.size === 0) {
  console.log("no auditor flags found — clean.");
  process.exit(0);
}
const rows = [...perUser.entries()]
  .map(([user, kinds]) => ({ user, total: Object.values(kinds).reduce((a, b) => a + b, 0), kinds }))
  .sort((a, b) => b.total - a.total);
for (const { user, total, kinds } of rows) {
  console.log(`  ${user}  total=${total}  ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(" ")}`);
}
