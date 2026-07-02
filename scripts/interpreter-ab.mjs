// INTERPRETER RELIABILITY A/B INSTRUMENT (owner testing only).
//
// Runs a fixed battery of ~10 varied attempt-interpreter calls through each
// named provider lane and reports the STRUCTURED-OUTPUT FALLBACK RATE — how
// often the lane's response fails extractJsonObject/coerceInterpreterOutput
// and would drop the engine back to its deterministic default. This is the
// instrument for comparing frontier-model interpreter reliability against the
// current local/Groq baseline.
//
// Usage:
//   node scripts/interpreter-ab.mjs --lanes local,codex [--n 10]
//   node scripts/interpreter-ab.mjs --lanes local --n 10   # baseline only
//
// Lanes: local | codex | gemini | groq. The codex lane needs the sidecar
// running (node server/ai/codex-proxy.mjs) and burns the OWNER'S ChatGPT
// subscription window — never point a battery at it.

import fs from "node:fs";
import path from "node:path";
import { buildCloudLane, requestViaCloudChain, resolveGmProvider } from "../server/ai/openrouter.js";
import { buildAttemptInterpreterMessages, extractJsonObject, coerceInterpreterOutput } from "../server/gm/attemptInterpreter.js";

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
// A/B integrity: a lane failure must FAIL VISIBLY (counted as a fallback),
// never silently substitute the local model for the lane under test.
process.env.INKBORNE_GM_LOCAL_FALLBACK = "false";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

// Varied attempt contexts spanning the interpreter's consequence space:
// harmless checks (type "none" territory), physical risk (damage), object
// degradation (objectState/retryEffect), possession claims (requiredItem),
// social contests, and trivial no-check actions.
const CASES = [
  {
    intent: "search the empty shelves for anything the looters missed",
    targetId: "obj_shelves",
    location: { name: "Ransacked Larder", description: "Bare shelves, overturned crates, flour dust on the floor." },
    hp: { current: 14, max: 18 }
  },
  {
    intent: "climb the crumbling wall to reach the bell tower window",
    targetId: "loc_belltower",
    location: { name: "Chapel Yard", description: "A leaning stone chapel; its bell tower wall is cracked and mossy." },
    hp: { current: 9, max: 18 }
  },
  {
    intent: "pick the rusted lock on the strongbox with my thieves' tools",
    targetId: "obj_strongbox",
    location: { name: "Wrecked Coach", description: "A road-agent's coach on its side, a strongbox bolted under the seat." },
    hp: { current: 18, max: 18 }
  },
  {
    intent: "persuade the ferryman to take me across for half fare",
    targetId: "npc_ferryman",
    location: { name: "Reedmarsh Crossing", description: "A rope-ferry over slow black water; the ferryman counts coins." },
    hp: { current: 12, max: 16 }
  },
  {
    intent: "unlock the cellar door with the brass key I took from the innkeeper",
    targetId: "obj_cellar_door",
    location: { name: "Inn Cellar Stairs", description: "Narrow stairs down to a banded oak door, cold air seeping through." },
    hp: { current: 16, max: 16 }
  },
  {
    intent: "leap the gap between the warehouse rooftops",
    targetId: "loc_rooftops",
    location: { name: "Dockside Rooftops", description: "Rain-slick shingles, a two-meter gap over an alley three floors down." },
    hp: { current: 7, max: 15 }
  },
  {
    intent: "recall what I know about the ward-sigils carved over the gate",
    targetId: "obj_ward_sigils",
    location: { name: "Old North Gate", description: "A sealed gate crowded with chiseled sigils, half worn away." },
    hp: { current: 15, max: 15 }
  },
  {
    intent: "carefully unfold the water-damaged map without tearing it",
    targetId: "obj_old_map",
    location: { name: "Survey Office", description: "Mildewed drawers of charts; one brittle map matters." },
    hp: { current: 13, max: 14 }
  },
  {
    intent: "sneak past the dozing warehouse guard to the side door",
    targetId: "npc_guard",
    location: { name: "Bonded Warehouse", description: "Crates stacked high; a guard nods over a shuttered lantern." },
    hp: { current: 11, max: 15 }
  },
  {
    intent: "drink some water from my waterskin",
    targetId: null,
    location: { name: "Roadside Camp", description: "A small fire, a bedroll, the road quiet in both directions." },
    hp: { current: 10, max: 15 }
  }
];

function providerInputFor(c) {
  return {
    ok: true,
    context: {
      intent: c.intent,
      targetId: c.targetId,
      location: c.location,
      player: { resources: { hitPoints: c.hp } }
    }
  };
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
if (!laneNames.length) {
  console.error("Provide at least one lane, e.g. --lanes local,codex");
  process.exit(1);
}
const n = Math.max(1, Math.min(CASES.length, Number(arg("n", String(CASES.length))) || CASES.length));
const cases = CASES.slice(0, n);

console.log(`\n=== INTERPRETER A/B — ${cases.length} attempt calls per lane ===\n`);

const summary = [];
for (const name of laneNames) {
  const lane = laneByName(name);
  const label = lane.provider.modelLabel || lane.provider.model;
  console.log(`LANE: ${lane.name} (${label})`);
  let fallbacks = 0;
  const latencies = [];
  for (const [i, c] of cases.entries()) {
    const messages = buildAttemptInterpreterMessages(providerInputFor(c));
    let verdict;
    try {
      const res = await requestViaCloudChain(messages, [lane], { temperature: 0.2, maxResponseTokens: 500 });
      latencies.push(res.latencyMs);
      const coerced = coerceInterpreterOutput(extractJsonObject(res.content), providerInputFor(c).context);
      if (coerced) {
        const fc = coerced.failureConsequence && typeof coerced.failureConsequence === "object"
          ? coerced.failureConsequence.type
          : "(none proposed)";
        verdict = `ok       ${res.latencyMs}ms  consequence=${fc}${coerced.requiredItem ? ` requiredItem=${coerced.requiredItem.name}` : ""}`;
      } else {
        fallbacks += 1;
        verdict = `FALLBACK ${res.latencyMs}ms  (unparseable/empty structured output)`;
      }
    } catch (error) {
      fallbacks += 1;
      verdict = `FALLBACK (lane error: ${String(error?.message || error).slice(0, 160)})`;
    }
    console.log(`  [${String(i + 1).padStart(2)}] ${verdict}  — ${c.intent.slice(0, 60)}`);
  }
  const rate = ((fallbacks / cases.length) * 100).toFixed(0);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  console.log(`  → fallback rate: ${fallbacks}/${cases.length} (${rate}%)${avg !== null ? `, avg latency ${avg}ms` : ""}\n`);
  summary.push({ lane: lane.name, label, fallbacks, total: cases.length, rate: `${rate}%`, avgLatencyMs: avg });
}

console.log("=== SUMMARY ===");
for (const s of summary) {
  console.log(`${s.lane.padEnd(8)} ${String(s.label).padEnd(24)} fallback ${s.fallbacks}/${s.total} (${s.rate})${s.avgLatencyMs !== null ? `  avg ${s.avgLatencyMs}ms` : ""}`);
}
console.log();
