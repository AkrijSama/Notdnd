// PROSE LADDER (owner testing only) — prompt-ceiling vs model-ceiling grid.
//
// Extends scripts/prose-ab.mjs from one-turn/two-lanes to a full grid:
// N real captured beats × 3 prompt variants × 3 model lanes, with the
// narration-state auditor (scripts/selfplayAudit.mjs) run over every output.
//
// Prompt variants are applied as TRANSFORMS over the captured messages —
// the live prompt (server/gm/*) is untouched:
//   current  — the captured advance-mandate prompt verbatim
//   contract — STYLE CONTRACT: hard 80-120 word budget, mandatory structure
//              (consequence → one NEW committed-state fact → pressure/decision),
//              every sentence must reference committed state, re-description ban
//   terse    — TERSE GM: 40-70 words, blunt, information-dense, zero atmosphere
//              unless state-grounded
//
// Raw material: a gm-capture.jsonl (narrative-tier entries) plus a scenes file
// (per-turn sceneAfter payloads) produced by replaying the owner's session.
//
// Usage:
//   node scripts/prose-ladder.mjs --capture <gm-capture.jsonl> \
//     --scenes <replay-turns.json> --out <report.md> \
//     [--lanes openrouter,openrouter:openai/gpt-oss-120b,gemini]
//
// PAID lanes spend real credit — never point a battery at this script.

import fs from "node:fs";
import path from "node:path";
import { buildCloudLane, requestViaCloudChain } from "../server/ai/openrouter.js";
import { auditProseAgainstState, knownNamesFromScene } from "./selfplayAudit.mjs";

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
// Grid integrity: a lane failure must FAIL VISIBLY, never silently substitute
// the local model's prose for the cell under test.
process.env.INKBORNE_GM_LOCAL_FALLBACK = "false";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

// ─────────────────────────── prompt variants ────────────────────────────────
// Seam: the captured system prompt's [STYLE] block and the captured user
// message's instruction tail (everything from "Narrate the CONCRETE outcome"
// on) are replaced; state/context blocks are preserved verbatim.

const CONTRACT_STYLE = `[STYLE] STYLE CONTRACT (hard, non-negotiable):
- Budget: 80-120 words total. Never exceed 120.
- Structure, in order: (1) the concrete consequence of the player's action; (2) exactly ONE new fact drawn from the committed game state you were given; (3) end on pressure or a decision the player must make now.
- Every sentence must reference a committed state element (a named location, NPC, item, object, or quest from the context above). A sentence that references none is forbidden.
- BANNED: re-describing the established scene, mood-only sentences, atmosphere padding, restating what the player already knows.
- Second person, present tense.`;

const TERSE_STYLE = `[STYLE] TERSE GM:
- 40-70 words. Blunt, information-dense.
- Zero atmosphere unless the detail is grounded in the committed game state you were given.
- State what changed, what the player now knows, and what demands a response. Nothing else.
- Second person, present tense.`;

const CONTRACT_INSTRUCTION = `Narrate the outcome under this HARD contract: 80-120 words total. Structure, in order: (1) the concrete consequence of this action; (2) exactly ONE new fact drawn from the committed game state above; (3) end on pressure or a decision. Every sentence must reference a committed state element (named location, NPC, item, object, or quest from the context). Do NOT re-describe the established scene; no mood-only sentences. Never invent places, exits, items, or people the state has not established. Do not restate dice or mechanics, and do not use bracketed trigger tags.`;

const TERSE_INSTRUCTION = `Narrate the outcome in 40-70 words: blunt and information-dense. State what changed, what the player now learns, and what demands a response next. Zero atmosphere unless the detail is grounded in the committed game state above. Never invent places, exits, items, or people the state has not established. Do not restate dice or mechanics, and do not use bracketed trigger tags.`;

// Replaces the [STYLE] block (through the blank line before [WORLD CONTEXT])
// and the user instruction tail. Throws if the expected seams are missing so a
// capture-format drift fails loudly instead of silently testing the wrong prompt.
function applyVariant(messages, variant) {
  if (variant === "current") return messages;
  const styleBlock = variant === "contract" ? CONTRACT_STYLE : TERSE_STYLE;
  const instruction = variant === "contract" ? CONTRACT_INSTRUCTION : TERSE_INSTRUCTION;
  return messages.map((m) => {
    if (m.role === "system") {
      if (!/\[STYLE\][\s\S]*?\n\n(?=\[WORLD CONTEXT\])/.test(m.content)) {
        throw new Error("system prompt missing [STYLE]…[WORLD CONTEXT] seam");
      }
      return { ...m, content: m.content.replace(/\[STYLE\][\s\S]*?\n\n(?=\[WORLD CONTEXT\])/, `${styleBlock}\n\n`) };
    }
    if (m.role === "user") {
      const cut = m.content.indexOf("Narrate the CONCRETE outcome");
      if (cut === -1) throw new Error(`user message missing instruction seam: ${m.content.slice(0, 80)}`);
      return { ...m, content: `${m.content.slice(0, cut).trim()} ${instruction}` };
    }
    return m;
  });
}

const VARIANTS = ["current", "contract", "terse"];

// ─────────────────────────────── lanes ──────────────────────────────────────
// "openrouter" | "gemini" | "groq" | "<lane>:<pinned/model>" (prose-ab semantics).
function laneByName(name) {
  const raw = String(name).trim();
  const [providerKey, ...modelParts] = raw.split(":");
  const lane = buildCloudLane(providerKey.toLowerCase());
  if (!lane) {
    console.error(`Unknown lane "${name}"`);
    process.exit(1);
  }
  if (lane.skip) {
    console.error(`Lane "${name}" unavailable: ${lane.skip}`);
    process.exit(1);
  }
  const pinnedModel = modelParts.join(":").trim();
  if (pinnedModel) {
    lane.provider = { ...lane.provider, model: pinnedModel };
    lane.name = raw;
  }
  // Ask OpenRouter for real per-call cost accounting (usage.cost in the response).
  if (providerKey.toLowerCase() === "openrouter") {
    lane.provider.extraBody = { ...(lane.provider.extraBody || {}), usage: { include: true } };
  }
  return lane;
}

// ─────────────────────────── grounding metrics ──────────────────────────────
// Beyond the auditor's phantom tally: a sentence is "ungrounded" when it names
// NO committed-state element at all (mood-only sentence). Crude and consistent
// across cells — a comparator, not an absolute score.
const GROUND_STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "you", "your", "with", "for", "night"]);

function groundingStats(prose, scene) {
  const tokens = new Set();
  for (const name of knownNamesFromScene(scene)) {
    for (const t of name.split(/\s+/)) {
      const clean = t.replace(/[^a-z']/g, "");
      if (clean.length >= 4 && !GROUND_STOP.has(clean)) tokens.add(clean);
    }
  }
  const sentences = String(prose).split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  let ungrounded = 0;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (![...tokens].some((t) => lower.includes(t))) ungrounded += 1;
  }
  return { sentences: sentences.length, ungrounded };
}

const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

// ────────────────────────────── inputs ──────────────────────────────────────
const capturePath = arg("capture") || (console.error("--capture <gm-capture.jsonl> required"), process.exit(1));
const scenesPath = arg("scenes") || (console.error("--scenes <replay-turns.json> required"), process.exit(1));
const outPath = arg("out") || "prose-ladder-report.md";
const laneNames = String(arg("lanes", "openrouter,openrouter:openai/gpt-oss-120b,gemini")).split(",").map((s) => s.trim()).filter(Boolean);

const captures = fs.readFileSync(capturePath, "utf8").split("\n").filter(Boolean)
  .map((line, i) => ({ index: i, ...JSON.parse(line) }));
const narrativeCaptures = captures.filter((c) => c.tier === "narrative");
const replay = JSON.parse(fs.readFileSync(scenesPath, "utf8"));
const turns = replay.turns;

// Pair narrative captures to replay turns. The opening (arrival) narration has
// no turn; when there is exactly one extra narrative capture, drop the first.
let beatCaptures = narrativeCaptures;
if (narrativeCaptures.length === turns.length + 1) beatCaptures = narrativeCaptures.slice(1);
if (beatCaptures.length !== turns.length) {
  console.error(`Cannot pair ${narrativeCaptures.length} narrative captures to ${turns.length} turns.`);
  process.exit(1);
}

const beats = turns.map((turn, i) => ({
  turn: turn.turn,
  intent: turn.intent,
  fixedRoll: turn.fixedRoll,
  capture: beatCaptures[i],
  scene: turn.sceneAfter,
  liveNarration: turn.narration || null
}));

const lanes = laneNames.map(laneByName);
console.log(`Grid: ${beats.length} beats × ${VARIANTS.length} variants × ${lanes.length} lanes = ${beats.length * VARIANTS.length * lanes.length} calls`);

// ─────────────────────────────── run grid ───────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const beat of beats) {
  for (const variant of VARIANTS) {
    const messages = applyVariant(beat.capture.messages, variant);
    for (const laneName of laneNames) {
      const lane = laneByName(laneName); // fresh lane per call (no shared mutation)
      const cell = `${variant} × ${lane.name}`;
      process.stdout.write(`beat ${beat.turn} | ${cell} ... `);
      let res = null;
      let error = null;
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
          res = await requestViaCloudChain(messages, [lane], { temperature: 0.85, maxResponseTokens: 2048 });
        } catch (e) {
          error = e;
          if (attempt === 0) await sleep(4000);
        }
      }
      if (res) {
        const audit = auditProseAgainstState(res.content, beat.scene);
        const grounding = groundingStats(res.content, beat.scene);
        console.log(`${res.latencyMs}ms, ${wordCount(res.content)}w, phantoms ${audit.phantoms.length}, ungrounded ${grounding.ungrounded}/${grounding.sentences}`);
        results.push({
          beat: beat.turn, intent: beat.intent, variant, lane: lane.name, model: res.model,
          latencyMs: res.latencyMs, tokensUsed: res.tokensUsed, cost: res.cost,
          words: wordCount(res.content), phantoms: audit.phantoms, grounding, content: res.content.trim()
        });
      } else {
        console.log(`FAILED (${String(error?.message || error).slice(0, 120)})`);
        results.push({
          beat: beat.turn, intent: beat.intent, variant, lane: lane.name, model: null,
          latencyMs: null, tokensUsed: null, cost: null, words: 0,
          phantoms: [], grounding: { sentences: 0, ungrounded: 0 },
          content: `<<CELL FAILED: ${String(error?.message || error).slice(0, 240)}>>`, failed: true
        });
      }
      // Pace the free gemini lane well under its RPM cap.
      await sleep(lane.name.startsWith("gemini") ? 5000 : 800);
    }
  }
}

// ─────────────────────────────── report ─────────────────────────────────────
const cellKey = (r) => `${r.variant} × ${r.lane}`;
const byCell = new Map();
for (const r of results) {
  if (!byCell.has(cellKey(r))) byCell.set(cellKey(r), []);
  byCell.get(cellKey(r)).push(r);
}

const md = [];
md.push(`# Prose Ladder — prompt vs model on the fluff-verdict beats`);
md.push(``);
md.push(`Source session: **${replay.runId}** (owner's fluff-verdict run replayed with identical world/character/actions/rolls to regenerate exact GM contexts; capture: \`${path.basename(capturePath)}\`).`);
md.push(`Grid: ${beats.length} beats × 3 prompt variants (current / style-contract / terse) × ${laneNames.length} model lanes. Temperature 0.85 across all cells. Auditor: \`scripts/selfplayAudit.mjs\` phantom detector + mood-only-sentence tally against each turn's committed scene payload.`);
md.push(``);

md.push(`## Auditor tally (grounding violations per cell)`);
md.push(``);
md.push(`| Cell (prompt × model) | Phantom refs | Mood-only sentences | Avg words | Fails |`);
md.push(`|---|---|---|---|---|`);
for (const [key, rs] of byCell) {
  const ok = rs.filter((r) => !r.failed);
  const phantoms = ok.reduce((n, r) => n + r.phantoms.length, 0);
  const ungrounded = ok.reduce((n, r) => n + r.grounding.ungrounded, 0);
  const sentences = ok.reduce((n, r) => n + r.grounding.sentences, 0);
  const words = ok.length ? Math.round(ok.reduce((n, r) => n + r.words, 0) / ok.length) : 0;
  md.push(`| ${key} | ${phantoms} | ${ungrounded}/${sentences} | ${words} | ${rs.length - ok.length} |`);
}
md.push(``);

md.push(`## Cost / latency per lane`);
md.push(``);
md.push(`| Lane | Calls | Avg latency | p max | Total tokens (in/out) | Reported cost | Cost/call |`);
md.push(`|---|---|---|---|---|---|---|`);
for (const laneName of laneNames) {
  const rs = results.filter((r) => r.lane === laneName && !r.failed);
  if (!rs.length) { md.push(`| ${laneName} | 0 | — | — | — | — | — |`); continue; }
  const avg = Math.round(rs.reduce((n, r) => n + r.latencyMs, 0) / rs.length);
  const max = Math.max(...rs.map((r) => r.latencyMs));
  const tin = rs.reduce((n, r) => n + (r.tokensUsed?.prompt || r.tokensUsed?.prompt_tokens || 0), 0);
  const tout = rs.reduce((n, r) => n + (r.tokensUsed?.completion || r.tokensUsed?.completion_tokens || 0), 0);
  const cost = rs.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  md.push(`| ${laneName} | ${rs.length} | ${avg}ms | ${max}ms | ${tin}/${tout} | ${cost ? `$${cost.toFixed(4)}` : "n/a (free/unreported)"} | ${cost ? `$${(cost / rs.length).toFixed(5)}` : "—"} |`);
}
md.push(``);

md.push(`## Side-by-side, by beat`);
for (const beat of beats) {
  md.push(``);
  md.push(`---`);
  md.push(``);
  md.push(`### Beat ${beat.turn} — "${beat.intent}"${beat.fixedRoll !== null && beat.fixedRoll !== undefined ? ` (roll ${beat.fixedRoll})` : " (no-stakes)"}`);
  if (beat.liveNarration) {
    md.push(``);
    md.push(`> **Live replay narration (what the game actually served):** ${String(beat.liveNarration).trim().replace(/\n+/g, " ")}`);
  }
  for (const variant of VARIANTS) {
    for (const laneName of laneNames) {
      const r = results.find((x) => x.beat === beat.turn && x.variant === variant && x.lane === laneName);
      if (!r) continue;
      md.push(``);
      md.push(`**[${r.variant} × ${r.lane}]** ${r.model ? `\`${r.model}\`` : ""} — ${r.latencyMs === null ? "FAILED" : `${r.latencyMs}ms`}, ${r.words}w, phantoms: ${r.phantoms.length}${r.phantoms.length ? ` (${r.phantoms.map((p) => p.name).join(", ")})` : ""}, mood-only: ${r.grounding.ungrounded}/${r.grounding.sentences}`);
      md.push(``);
      md.push(r.content.split("\n").map((l) => `> ${l}`).join("\n"));
    }
  }
}
md.push(``);

fs.writeFileSync(outPath, md.join("\n"), "utf8");
fs.writeFileSync(outPath.replace(/\.md$/, ".json"), JSON.stringify(results, null, 2), "utf8");
console.log(`\nReport: ${outPath}`);
console.log(`Raw cells: ${outPath.replace(/\.md$/, ".json")}`);
