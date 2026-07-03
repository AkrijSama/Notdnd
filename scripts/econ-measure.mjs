// UNIT-ECONOMICS MEASUREMENT INSTRUMENT (owner testing only).
//
// Measures REAL per-call token consumption from the GM-call capture corpus
// (data/logs/gm-capture.jsonl, written by NOTDND_GM_CAPTURE=1) instead of
// estimating: every capture entry is classified by call type (narration /
// interpreter / suggestions / memory-extract / player-memory / session-record /
// memory-summarize / history-compress), a sample per class is replayed against
// the REAL Groq tokenizer+models to get exact prompt_tokens and realistic
// completion_tokens, and the sampled ratio calibrates the rest of the corpus.
//
// From that it models a real free-text session (default 35 turns) and prints
// cost/session + a margin table at $9.99 (less LemonSqueezy 5% + $0.50) for
// several routing scenarios (all-70b, cheap-interpreter routing, etc.).
//
// Usage:
//   node scripts/econ-measure.mjs                    # offline: corpus profile only
//   node scripts/econ-measure.mjs --live 3           # + replay 3 samples/class on Groq
//   node scripts/econ-measure.mjs --live 3 --turns 35 --attempt-share 0.7
//
// Live replays run on the OWNER'S Groq key (free tier at time of writing) and
// pace themselves under the 12k TPM window. Never point a battery at this.

import fs from "node:fs";
import path from "node:path";

function loadDotenv() {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
loadDotenv();

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

const CAPTURE = arg("capture", path.resolve(process.cwd(), "data/logs/gm-capture.jsonl"));
const LIVE_SAMPLES = Number(arg("live", "0"));
const SESSION_TURNS = Number(arg("turns", "35"));
// Share of turns that are free-text ATTEMPTS (interpreter fires). The soak
// battery under-represents this (scripted hook turns); real free-text play per
// the corpus/advancement scenarios is attempt-heavy.
const ATTEMPT_SHARE = Number(arg("attempt-share", "0.7"));

// Groq on-demand $/M tokens (input, output) — printed rates, 2026-07.
const RATES = {
  "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
  "llama-3.1-8b-instant": { in: 0.05, out: 0.08 },
  "openai/gpt-oss-120b": { in: 0.15, out: 0.60 }
};

// $9.99 through LemonSqueezy (5% + $0.50) => net to us.
const PRICE = 9.99;
const NET = PRICE * 0.95 - 0.50;

function classify(entry) {
  const sys = String((entry.messages.find((m) => m.role === "system") || {}).content || "");
  if (entry.tier === "narrative") return "narration";
  if (sys.includes("RULES ADJUDICATOR")) return "interpreter";
  if (sys.includes("suggest exactly 3 next actions")) return "suggestions";
  if (sys.includes("Extract NEW or CHANGED facts")) return "memory-extract";
  if (sys.includes("player behavior")) return "player-memory";
  if (sys.includes("Summarize RPG conversation logs")) return "session-record";
  if (sys.includes("Summarize RPG chat logs")) return "history-compress";
  if (sys.includes("campaign memory docs")) return "memory-summarize";
  return "other";
}

function entryChars(entry) {
  return entry.messages.reduce((a, m) => a + String(m.content || "").length, 0);
}

// How often each class fires per free-text turn in a REAL session.
// narration/memory-extract/suggestions: every narrated turn (=1/turn).
// interpreter: attempt turns only. player-memory: every 5th turn
// (prompting.js nextCount % 5). session-record: every ~10 exchanges.
// memory-summarize/history-compress: occasional (doc-threshold), ~2/session each.
function perSessionCalls(cls) {
  switch (cls) {
    case "narration": return SESSION_TURNS;
    case "memory-extract": return SESSION_TURNS;
    case "suggestions": return SESSION_TURNS;
    case "interpreter": return Math.round(SESSION_TURNS * ATTEMPT_SHARE);
    case "player-memory": return Math.floor(SESSION_TURNS / 5);
    case "session-record": return Math.floor(SESSION_TURNS / 10);
    case "history-compress": return 2;
    case "memory-summarize": return 2;
    default: return 0;
  }
}

// Realistic generation ceiling per class for live output measurement
// (narration floor in the engine is 2048; models stop naturally well before).
function maxTokensFor(cls) {
  if (cls === "narration") return 1024;
  if (cls === "suggestions") return 160; // engine cap (suggestions.js)
  if (cls === "interpreter") return 500; // engine cap (attemptInterpreter.js)
  return 512;
}

async function groqCall(messages, model, maxTokens) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 })
    });
    if (r.status === 429) {
      const body = await r.json().catch(() => ({}));
      const wait = /try again in ([0-9.]+)s/.exec(String(body?.error?.message || ""));
      const ms = wait ? Math.ceil(Number(wait[1]) * 1000) + 500 : 15000;
      process.stdout.write(`(429, waiting ${Math.round(ms / 1000)}s) `);
      await new Promise((res) => setTimeout(res, ms));
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`groq ${r.status}: ${String(j?.error?.message || "").slice(0, 120)}`);
    return j.usage;
  }
  throw new Error("groq: rate-limited after 5 attempts");
}

// ---------------------------------------------------------------------------
const entries = fs.readFileSync(CAPTURE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byClass = {};
for (const e of entries) {
  const cls = classify(e);
  (byClass[cls] ||= { entries: [] }).entries.push(e);
}

console.log(`\n=== CORPUS: ${entries.length} captured GM calls (${CAPTURE}) ===`);
for (const [cls, v] of Object.entries(byClass)) {
  const chars = v.entries.map(entryChars);
  v.avgChars = Math.round(chars.reduce((a, b) => a + b, 0) / chars.length);
  console.log(`  ${cls.padEnd(18)} calls: ${String(v.entries.length).padStart(3)}   avg input chars: ${v.avgChars}`);
}

// Live calibration: replay samples per class on 70b for EXACT prompt_tokens
// (real tokenizer) + realistic completion_tokens.
if (LIVE_SAMPLES > 0) {
  console.log(`\n=== LIVE CALIBRATION (llama-3.3-70b-versatile, ${LIVE_SAMPLES} samples/class) ===`);
  for (const [cls, v] of Object.entries(byClass)) {
    const picks = v.entries.filter((_, i) => i % Math.max(1, Math.floor(v.entries.length / LIVE_SAMPLES)) === 0).slice(0, LIVE_SAMPLES);
    const inToks = [];
    const outToks = [];
    for (const e of picks) {
      process.stdout.write(`  ${cls} sample ... `);
      try {
        const usage = await groqCall(e.messages, "llama-3.3-70b-versatile", maxTokensFor(cls));
        inToks.push(usage.prompt_tokens);
        outToks.push(usage.completion_tokens);
        console.log(`in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
      } catch (err) {
        console.log(`FAILED (${String(err.message).slice(0, 80)})`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (inToks.length) {
      const sampleChars = picks.slice(0, inToks.length).map(entryChars);
      v.tokPerChar = inToks.reduce((a, b) => a + b, 0) / sampleChars.reduce((a, b) => a + b, 0);
      v.inTokens = Math.round(v.avgChars * v.tokPerChar);
      v.outTokens = Math.round(outToks.reduce((a, b) => a + b, 0) / outToks.length);
    }
  }
} else {
  console.log("\n(no --live N: using 3.9 chars/token approximation and class-typical outputs)");
}

// Fill gaps with the cross-class ratio / typical outputs so offline runs still model.
const measuredRatios = Object.values(byClass).map((v) => v.tokPerChar).filter(Boolean);
const fallbackRatio = measuredRatios.length
  ? measuredRatios.reduce((a, b) => a + b, 0) / measuredRatios.length
  : 1 / 3.9;
const TYPICAL_OUT = {
  narration: 350, interpreter: 220, suggestions: 90, "memory-extract": 120,
  "player-memory": 200, "session-record": 90, "history-compress": 150, "memory-summarize": 250, other: 100
};
for (const [cls, v] of Object.entries(byClass)) {
  if (!v.inTokens) v.inTokens = Math.round(v.avgChars * fallbackRatio);
  if (!v.outTokens) v.outTokens = TYPICAL_OUT[cls] ?? 100;
}

// ---------------------------------------------------------------------------
console.log(`\n=== PER-CALL TOKEN PROFILE (measured/calibrated) ===`);
for (const [cls, v] of Object.entries(byClass)) {
  console.log(`  ${cls.padEnd(18)} in: ${String(v.inTokens).padStart(5)}  out: ${String(v.outTokens).padStart(4)}  x${perSessionCalls(cls)}/session`);
}

function sessionTokens(assignment) {
  // assignment: cls -> model. Returns {cost, perModel tokens}
  let cost = 0;
  const detail = {};
  for (const [cls, v] of Object.entries(byClass)) {
    const n = perSessionCalls(cls);
    if (!n) continue;
    const model = assignment[cls] || assignment["*"];
    const rate = RATES[model];
    const inT = v.inTokens * n;
    const outT = v.outTokens * n;
    cost += (inT / 1e6) * rate.in + (outT / 1e6) * rate.out;
    (detail[model] ||= { in: 0, out: 0 });
    detail[model].in += inT;
    detail[model].out += outT;
  }
  return { cost, detail };
}

const SCENARIOS = {
  "all-70b": { "*": "llama-3.3-70b-versatile" },
  "70b-narration + 8b-utility": { "*": "llama-3.1-8b-instant", narration: "llama-3.3-70b-versatile" },
  "120b-narration + 8b-utility": { "*": "llama-3.1-8b-instant", narration: "openai/gpt-oss-120b" },
  "70b-narration + 120b-interp + 8b-rest": { "*": "llama-3.1-8b-instant", narration: "llama-3.3-70b-versatile", interpreter: "openai/gpt-oss-120b" }
};

console.log(`\n=== COST / ${SESSION_TURNS}-TURN SESSION (attempt share ${ATTEMPT_SHARE}) ===`);
const costs = {};
for (const [name, assignment] of Object.entries(SCENARIOS)) {
  const { cost, detail } = sessionTokens(assignment);
  costs[name] = cost;
  const tok = Object.entries(detail).map(([m, d]) => `${m.split("/").pop()}: ${Math.round(d.in / 1000)}k in/${Math.round(d.out / 1000)}k out`).join(", ");
  console.log(`  ${name.padEnd(40)} $${cost.toFixed(4)}   (${tok})`);
}

console.log(`\n=== MARGIN TABLE — $${PRICE} gross, $${NET.toFixed(2)} net after LemonSqueezy (5% + $0.50) ===`);
const SESSION_COUNTS = [8, 15, 30, 60];
for (const [name, cost] of Object.entries(costs)) {
  console.log(`  ${name}`);
  for (const s of SESSION_COUNTS) {
    const spend = cost * s;
    const margin = NET - spend;
    const pct = (margin / NET) * 100;
    console.log(`    ${String(s).padStart(2)} sessions/mo: spend $${spend.toFixed(2).padStart(6)}  margin $${margin.toFixed(2).padStart(6)} (${pct.toFixed(1)}%)${margin < 0 ? "  << UNDERWATER" : ""}`);
  }
  const underwaterAt = Math.ceil(NET / cost);
  console.log(`    breakeven: user goes underwater at ${underwaterAt} sessions/mo`);
}
console.log();
