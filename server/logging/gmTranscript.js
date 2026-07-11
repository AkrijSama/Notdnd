// GM GENERATION TRANSCRIPTS — one JSONL record per GM generation, appended to
// data/logs/gm-transcripts/<runId>.jsonl. This is fine-tune dataset groundwork:
// the FULL prompt message array (the training input) + the raw, pre-trim model
// output (the training target), captured at the single chokepoint every GM call
// flows through (runGmPipeline). Every unpersisted turn is a thrown-away example.
//
// DESIGN CONTRACT:
// - Append-only, one JSON object per line. fsync is NOT required.
// - Best-effort by design: a write failure NEVER throws into the turn path — it
//   logs a warning and returns false. Persistence must never fail a turn.
// - Kill-switch: INKBORNE_GM_TRANSCRIPTS=false disables all capture (default ON).
// - No secrets: promptMessages come from our own prompt assembly (system prompt +
//   grounded context + player input) and carry no API keys. Verified by grep.
// - Size guard: promptMessages default to a generous cap (the prompt IS the
//   dataset); INKBORNE_GM_TRANSCRIPTS_MAX_PROMPT_BYTES bounds pathological
//   grounding contexts with a truncation marker rather than dropping the record.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_PROMPT_BYTES = 2 * 1024 * 1024; // 2MB — generous; prompt is the dataset

function captureEnabled() {
  return String(process.env.INKBORNE_GM_TRANSCRIPTS ?? "true").trim().toLowerCase() !== "false";
}

function transcriptsDir() {
  // Env override exists purely for test isolation; production uses the default.
  const override = String(process.env.NOTDND_GM_TRANSCRIPTS_DIR || "").trim();
  return override || path.resolve(process.cwd(), "data/logs/gm-transcripts");
}

function maxPromptBytes() {
  const v = Number(process.env.INKBORNE_GM_TRANSCRIPTS_MAX_PROMPT_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PROMPT_BYTES;
}

// Provider is not carried on the model result; derive it from the model id so the
// dataset records where each generation came from without a caller change.
export function inferProvider(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  if (m.includes("gemini")) return "google";
  if (m.includes("deepseek")) return "openrouter";
  if (m.includes("llama") || m.includes("groq")) return "groq";
  if (m.includes("gpt")) return "openai";
  if (m.includes("inkborne") || m.includes(":8b") || m.includes("local")) return "local";
  return "openrouter";
}

function sanitizeFileKey(key) {
  return String(key || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "unknown";
}

// Bound the promptMessages payload with a marker (never drop the record). Returns
// { promptMessages, promptTruncated }.
function guardPromptSize(promptMessages) {
  const messages = Array.isArray(promptMessages) ? promptMessages : [];
  const cap = maxPromptBytes();
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") <= cap) {
    return { promptMessages: messages, promptTruncated: false };
  }
  const perMessage = Math.max(256, Math.floor(cap / Math.max(1, messages.length)));
  const truncated = messages.map((msg) => {
    if (msg && typeof msg.content === "string" && Buffer.byteLength(msg.content, "utf8") > perMessage) {
      return { role: msg.role ?? null, content: `${msg.content.slice(0, perMessage)}…[TRUNCATED ${msg.content.length - perMessage} chars]`, __truncated: true };
    }
    return msg;
  });
  return { promptMessages: truncated, promptTruncated: true };
}

/**
 * Append one GM-generation record. Best-effort; never throws.
 * @param {{ ts?: string, runId?: string|null, campaignId?: string|null,
 *   turnRef?: any, callType?: string|null, model?: string|null,
 *   provider?: string|null, finishReason?: string|null,
 *   promptMessages?: Array<{role:string,content:string}>, rawOutput?: string|null,
 *   trimmedOutput?: string|null, latencyMs?: number|null, trimApplied?: boolean,
 *   handlesRetry?: boolean }} record
 * @returns {boolean} true if a line was written
 */
export function recordGmGeneration(record = {}) {
  try {
    if (!captureEnabled()) {
      return false;
    }
    const fileKey = sanitizeFileKey(record.runId || record.campaignId);
    const { promptMessages, promptTruncated } = guardPromptSize(record.promptMessages);
    const line = JSON.stringify({
      ts: record.ts || new Date().toISOString(),
      runId: record.runId ?? null,
      campaignId: record.campaignId ?? null,
      turnRef: record.turnRef ?? null,
      callType: record.callType ?? null,
      model: record.model ?? null,
      provider: record.provider ?? inferProvider(record.model),
      finishReason: record.finishReason ?? null,
      promptMessages,
      promptTruncated,
      rawOutput: typeof record.rawOutput === "string" ? record.rawOutput : null,
      trimmedOutput: typeof record.trimmedOutput === "string" ? record.trimmedOutput : null,
      latencyMs: Number.isFinite(record.latencyMs) ? record.latencyMs : null,
      contextMs: Number.isFinite(record.contextMs) ? record.contextMs : null,
      trimApplied: Boolean(record.trimApplied),
      handlesRetry: Boolean(record.handlesRetry)
    });
    const dir = transcriptsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${fileKey}.jsonl`), `${line}\n`);
    return true;
  } catch (error) {
    // Best-effort: a persistence failure must NEVER fail a turn.
    try {
      console.warn(`[gm-transcript] persist failed (best-effort, turn unaffected): ${String(error?.message || error).slice(0, 160)}`);
    } catch {
      // even the warning is best-effort
    }
    return false;
  }
}
