// Extracts the REAL-PLAYER free-text corpus from the project's own history:
// per-run transcript logs (data/logs/runs/*.log) + persisted run timelines in
// the sqlite DB. Dedupes, marks harness-authored phrasings (verbatim strings in
// scripts/selfplay.mjs), classifies every input with the ENGINE'S OWN detectors
// against a rich standard fixture, and writes tests/fixtures/real-player-corpus.json.
//
// Rebuild any time with:  node scripts/corpusExtract.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyCorpusInput, buildRichFixtureRun, looksLikeQuestion } from "./selfplayAudit.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LOG_DIR = path.join(ROOT, "data", "logs", "runs");
const DB = path.join(ROOT, "server", "db", "notdnd.sqlite");
const OUT = path.join(ROOT, "tests", "fixtures", "real-player-corpus.json");
const SELFPLAY_SRC = fs.readFileSync(path.join(ROOT, "scripts", "selfplay.mjs"), "utf8");

function norm(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// 1) Transcript logs: attempt intents + talk player messages.
const fromLogs = new Set();
for (const file of fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"))) {
  const body = fs.readFileSync(path.join(LOG_DIR, file), "utf8");
  for (const m of body.matchAll(/action: attempt — "([^"\n]{2,400})"/g)) {
    fromLogs.add(norm(m[1]));
  }
}

// 2) DB timelines: payload.intent on attempt events (older runs predating the
// transcript logger — this is where the owner's crash inputs live).
const fromDb = new Set();
try {
  const rows = execFileSync("sqlite3", [DB, "SELECT data FROM campaigns;"], {
    maxBuffer: 1024 * 1024 * 256,
    encoding: "utf8"
  });
  for (const m of rows.matchAll(/"intent":"((?:[^"\\]|\\.){2,400}?)"/g)) {
    try {
      fromDb.add(norm(JSON.parse(`"${m[1]}"`)));
    } catch {
      /* skip malformed */
    }
  }
} catch (error) {
  console.error("DB extraction skipped:", error.message);
}

// Merge + dedupe (case-insensitive).
const seen = new Map();
for (const [source, set] of [["log", fromLogs], ["db", fromDb]]) {
  for (const text of set) {
    const key = text.toLowerCase();
    if (!text || text.length < 3) continue;
    if (!seen.has(key)) {
      seen.set(key, { text, sources: [source] });
    } else if (!seen.get(key).sources.includes(source)) {
      seen.get(key).sources.push(source);
    }
  }
}

// Mark harness-authored phrasings: a verbatim (case-insensitive) occurrence in
// selfplay.mjs source means the harness already tests it — the interesting rows
// are the ones it does NOT.
const selfplayLower = SELFPLAY_SRC.toLowerCase();
const fixture = buildRichFixtureRun();
const entries = [...seen.values()]
  .map(({ text, sources }) => ({
    text,
    sources,
    harnessAuthored: selfplayLower.includes(text.toLowerCase()),
    class: classifyCorpusInput(fixture, text),
    question: looksLikeQuestion(text)
  }))
  .sort((a, b) => a.class.localeCompare(b.class) || a.text.localeCompare(b.text));

const byClass = {};
for (const e of entries) {
  byClass[e.class] = (byClass[e.class] || 0) + 1;
}
const realOnly = entries.filter((e) => !e.harnessAuthored).length;

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      extractedAt: new Date().toISOString(),
      total: entries.length,
      realPlayer: realOnly,
      harnessAuthored: entries.length - realOnly,
      byClass,
      entries
    },
    null,
    2
  )
);
console.log(`corpus: ${entries.length} unique inputs (${realOnly} real-player, ${entries.length - realOnly} harness-authored)`);
console.log("by class:", JSON.stringify(byClass));
console.log("->", path.relative(ROOT, OUT));
