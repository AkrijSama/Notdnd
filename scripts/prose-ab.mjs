// PROSE-CEILING A/B INSTRUMENT (owner testing only).
//
// Replays ONE real turn's EXACT GM context against two named provider lanes and
// prints both outputs side-by-side with attribution + latency — the instrument
// for separating prompt-ceiling from model-ceiling on flat beats.
//
// Raw material: the GM-call capture (NOTDND_GM_CAPTURE=1 on the server appends
// every narrative/utility call's exact messages to data/logs/gm-capture.jsonl).
// The turn is located by timestamp: the per-run transcript block for turn N
// (data/logs/runs/<runId>.log) is matched to the closest preceding narrative
// capture entry.
//
// Usage:
//   node scripts/prose-ab.mjs --run <runId> --turn <N> [--lanes local,codex]
//   node scripts/prose-ab.mjs --capture-index <i> [--lanes local,groq]
//
// Lanes: local | codex | gemini | groq. The codex lane needs the sidecar
// running (node server/ai/codex-proxy.mjs) and burns the OWNER'S ChatGPT
// subscription window — never point a battery at it.

import fs from "node:fs";
import path from "node:path";
import { buildCloudLane, requestViaCloudChain, resolveGmProvider, gmCapturePath } from "../server/ai/openrouter.js";

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
// A/B integrity: a lane failure must FAIL VISIBLY, never silently substitute
// the local model's prose for the lane under test.
process.env.INKBORNE_GM_LOCAL_FALLBACK = "false";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

function readCaptures() {
  const file = gmCapturePath();
  if (!fs.existsSync(file)) {
    console.error(`No capture file at ${file}. Run the server with NOTDND_GM_CAPTURE=1 and play a turn first.`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, i) => {
    try {
      return { index: i, ...JSON.parse(line) };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Locates turn N's timestamp in the per-run transcript, then the closest
// PRECEDING narrative capture entry (the GM call happens just before the
// transcript block is appended) within a 5-minute window.
function findCaptureForTurn(runId, turnNumber, captures) {
  const logFile = path.resolve(process.cwd(), "data/logs/runs", `${String(runId).replace(/[^a-zA-Z0-9_.-]/g, "_")}.log`);
  if (!fs.existsSync(logFile)) {
    console.error(`No run transcript at ${logFile}`);
    process.exit(1);
  }
  const blocks = [...fs.readFileSync(logFile, "utf8").matchAll(/^===== TURN ([0-9T:.Z-]+) =====$/gm)];
  const block = blocks[turnNumber - 1];
  if (!block) {
    console.error(`Run ${runId} has ${blocks.length} turns; --turn ${turnNumber} not found.`);
    process.exit(1);
  }
  const turnTs = Date.parse(block[1]);
  const candidates = captures
    .filter((c) => c.tier === "narrative")
    .map((c) => ({ ...c, delta: turnTs - Date.parse(c.ts) }))
    .filter((c) => c.delta >= -5000 && c.delta < 300000)
    .sort((a, b) => a.delta - b.delta);
  if (!candidates.length) {
    console.error(`No narrative capture entry near turn ${turnNumber} (${block[1]}). Was the server running with NOTDND_GM_CAPTURE=1?`);
    process.exit(1);
  }
  return candidates[0];
}

function laneByName(name) {
  const key = String(name).trim().toLowerCase();
  if (key === "local") {
    return { name: "local", provider: resolveGmProvider("mainline", { fallback: true }) };
  }
  const lane = buildCloudLane(key);
  if (!lane) {
    console.error(`Unknown lane "${name}" (expected local|codex|gemini|groq).`);
    process.exit(1);
  }
  if (lane.skip) {
    console.error(`Lane "${name}" unavailable: ${lane.skip}`);
    process.exit(1);
  }
  return lane;
}

const laneNames = String(arg("lanes", "local,codex")).split(",").map((s) => s.trim()).filter(Boolean);
if (laneNames.length !== 2) {
  console.error("Provide exactly two lanes, e.g. --lanes local,codex");
  process.exit(1);
}

const captures = readCaptures();
const captureIndex = arg("capture-index");
const entry = captureIndex !== null
  ? captures.find((c) => c.index === Number(captureIndex))
  : findCaptureForTurn(arg("run") ?? (console.error("--run <runId> (or --capture-index) is required"), process.exit(1)), Number(arg("turn", "1")), captures);
if (!entry) {
  console.error("Capture entry not found.");
  process.exit(1);
}

console.log(`\n=== PROSE A/B — capture #${entry.index} (${entry.tier}, campaign ${entry.campaignId}, captured ${entry.ts}) ===`);
const userMsg = entry.messages.find((m) => m.role === "user");
console.log(`player context (user message, first 300 chars):\n  ${String(userMsg?.content || "").slice(0, 300).replace(/\n/g, "\n  ")}\n`);

const results = [];
for (const name of laneNames) {
  const lane = laneByName(name);
  const label = lane.provider.modelLabel || lane.provider.model;
  process.stdout.write(`→ ${lane.name} (${label}) ... `);
  try {
    const res = await requestViaCloudChain(entry.messages, [lane], { temperature: 0.85 });
    console.log(`${res.latencyMs}ms`);
    results.push({ lane: lane.name, label: res.model, latencyMs: res.latencyMs, content: res.content });
  } catch (error) {
    console.log("FAILED");
    results.push({ lane: lane.name, label, latencyMs: null, content: `<<LANE FAILED: ${String(error?.message || error).slice(0, 240)}>>` });
  }
}

for (const r of results) {
  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`LANE: ${r.lane}  |  MODEL: ${r.label}  |  LATENCY: ${r.latencyMs === null ? "n/a" : `${r.latencyMs}ms`}`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(r.content);
}
console.log();
