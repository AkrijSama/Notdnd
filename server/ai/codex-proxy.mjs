// PERSONAL-TESTING sidecar: OpenAI-compatible /v1/chat/completions proxy in
// front of the ChatGPT Codex backend, authenticated with the OWNER'S ChatGPT
// subscription via the Codex CLI's saved login (~/.codex/auth.json).
//
// WHY THIS EXISTS (and its hard limits):
//   - It lets the GM cloud chain (server/ai/openrouter.js, lane "codex") replay
//     beats on a frontier model (gpt-5.5) to separate prompt-ceiling from
//     model-ceiling, and to compare interpreter structured-output reliability.
//   - It is SUBSCRIPTION-BOUND: rate-limited to the owner's rolling usage
//     window, no SLA, and the endpoint/contract is unofficial (public
//     reverse-engineering of the Codex CLI) and can change without notice.
//   - It must NEVER serve external users. It is a testing instrument, not
//     infrastructure. The lane is flag-gated off by default and skipped for
//     any battery/harness caller (see openrouter.js).
//
// AUTH HYGIENE: auth.json contents are treated like a password — never logged,
// never copied, never embedded in responses. Only the token's expiry and the
// account id LENGTH may appear in diagnostics.
//
// 401 CONTRACT: tokens expire; the Codex CLI refreshes auth.json during its own
// use. On a 401/403 from the backend we re-read auth.json (optionally nudging
// `codex login status`, which performs the refresh) and retry ONCE; a second
// 401 is returned upstream so the chain falls to its next lane.
//
// Run:  node server/ai/codex-proxy.mjs        (binds 127.0.0.1 only)
// Env:  NOTDND_CODEX_PROXY_PORT (default 8788)
//       CODEX_AUTH_PATH        (default ~/.codex/auth.json)
//       CODEX_BACKEND_URL      (default https://chatgpt.com/backend-api/codex/responses)
//       CODEX_REASONING_EFFORT (default "low"; "off" omits the reasoning field)
//       CODEX_PROXY_NO_SPAWN   (tests: never shell out to `codex login status`)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_PORT = 8788;

export function defaultAuthPath() {
  return process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");
}

// Reads {token, accountId} from auth.json. Returns null on any problem —
// callers surface a clean 401 upstream, never the file contents.
export function readCodexAuth(authPath = defaultAuthPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = String(parsed?.tokens?.access_token || "").trim();
    const accountId = String(parsed?.tokens?.account_id || "").trim();
    return token ? { token, accountId } : null;
  } catch {
    return null;
  }
}

// Nudge the Codex CLI to refresh a stale token in auth.json. Best-effort and
// bounded; disabled in tests via CODEX_PROXY_NO_SPAWN.
function nudgeCodexRefresh() {
  if (String(process.env.CODEX_PROXY_NO_SPAWN || "").trim()) {
    return;
  }
  try {
    spawnSync("codex", ["login", "status"], { timeout: 15000, stdio: "ignore" });
  } catch {
    // The re-read below decides what happens; a failed nudge is not an error.
  }
}

// chat-completions messages -> Codex Responses payload. System messages become
// `instructions`; the rest become Responses `input` items. PURE (unit-testable).
export function chatToResponsesPayload(body, model) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.filter((m) => m?.role === "system").map((m) => String(m?.content ?? "")).join("\n\n");
  const input = messages
    .filter((m) => m?.role !== "system")
    .map((m) => ({
      type: "message",
      role: m?.role === "assistant" ? "assistant" : "user",
      content: [{ type: m?.role === "assistant" ? "output_text" : "input_text", text: String(m?.content ?? "") }]
    }));
  const payload = {
    model,
    instructions: system || "You are a helpful assistant.",
    input,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    // The Codex backend serves SSE only; the proxy re-shapes it for the caller.
    stream: true,
    include: []
  };
  const effort = String(process.env.CODEX_REASONING_EFFORT || "low").trim().toLowerCase();
  if (effort && effort !== "off") {
    payload.reasoning = { effort };
  }
  return payload;
}

// Parses the backend's Responses SSE stream. Invokes onDelta(text) per
// output_text delta; resolves { content, usage } at response.completed.
async function consumeResponsesSse(response, onDelta) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let content = "";
  let usage = {};
  let failed = null;
  const handle = (json) => {
    const type = String(json?.type || "");
    if (type === "response.output_text.delta" && typeof json.delta === "string") {
      content += json.delta;
      onDelta?.(json.delta);
    } else if (type === "response.completed") {
      const u = json?.response?.usage || {};
      usage = { prompt_tokens: Number(u.input_tokens || 0), completion_tokens: Number(u.output_tokens || 0) };
      // Belt-and-braces: if no deltas arrived, lift the final text off the
      // completed response's output items.
      if (!content) {
        for (const item of json?.response?.output || []) {
          for (const part of item?.content || []) {
            if (typeof part?.text === "string") {
              content += part.text;
            }
          }
        }
      }
    } else if (type === "response.failed" || type === "error") {
      failed = String(json?.response?.error?.message || json?.message || "codex backend reported failure");
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        try {
          handle(JSON.parse(data));
        } catch {
          // Ignore malformed chunks.
        }
      }
    }
  }
  if (failed) {
    const error = new Error(failed);
    error.statusCode = 502;
    throw error;
  }
  return { content, usage };
}

async function callBackend(backendUrl, auth, payload) {
  return fetch(backendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.token}`,
      "chatgpt-account-id": auth.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: crypto.randomUUID()
    },
    body: JSON.stringify(payload)
  });
}

function writeJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function chatChunk(model, delta) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;
}

/**
 * Creates (but does not start) the proxy server. Factory so tests can point it
 * at a mock backend + a temp auth file. `listen()` binds 127.0.0.1 ONLY —
 * this must never be reachable off-box.
 */
export function createCodexProxy({
  backendUrl = process.env.CODEX_BACKEND_URL || DEFAULT_BACKEND_URL,
  authPath = defaultAuthPath()
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        const auth = readCodexAuth(authPath);
        writeJson(res, auth ? 200 : 503, { ok: Boolean(auth), authPath, authenticated: Boolean(auth) });
        return;
      }
      if (req.method !== "POST" || !String(req.url || "").includes("/chat/completions")) {
        writeJson(res, 404, { error: { message: "codex-proxy: only POST /v1/chat/completions and GET /healthz" } });
        return;
      }
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        writeJson(res, 400, { error: { message: "invalid JSON body" } });
        return;
      }
      const model = String(body.model || process.env.CODEX_MODEL || "gpt-5.5");
      const payload = chatToResponsesPayload(body, model);

      let auth = readCodexAuth(authPath);
      if (!auth) {
        writeJson(res, 401, { error: { message: `codex-proxy: not authenticated (run \`codex login\`; expected ${authPath})` } });
        return;
      }

      let upstream = await callBackend(backendUrl, auth, payload);
      // EXPIRED TOKEN: the CLI refreshes auth.json — nudge it, RE-READ, retry ONCE.
      if (upstream.status === 401 || upstream.status === 403) {
        nudgeCodexRefresh();
        auth = readCodexAuth(authPath);
        if (auth) {
          console.warn(`[codex-proxy] ${upstream.status} from backend — re-read auth.json, retrying once`);
          upstream = await callBackend(backendUrl, auth, payload);
        }
      }
      if (!upstream.ok) {
        const raw = await upstream.text();
        let message = raw.slice(0, 300);
        try {
          const parsed = JSON.parse(raw);
          message = parsed?.error?.message || parsed?.detail || message;
        } catch { /* keep the raw snippet */ }
        console.warn(`[codex-proxy] backend ${upstream.status}: ${String(message).slice(0, 160)}`);
        writeJson(res, upstream.status, { error: { message: `codex backend ${upstream.status}: ${message}` } });
        return;
      }

      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const { content, usage } = await consumeResponsesSse(upstream, (delta) => res.write(chatChunk(model, delta)));
        res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        void content;
        return;
      }
      const { content, usage } = await consumeResponsesSse(upstream, null);
      writeJson(res, 200, {
        id: `codexproxy-${crypto.randomUUID()}`,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage
      });
    } catch (error) {
      console.warn(`[codex-proxy] request failed: ${String(error?.message || error).slice(0, 200)}`);
      if (!res.headersSent) {
        writeJson(res, error?.statusCode || 502, { error: { message: String(error?.message || "codex-proxy internal error") } });
      } else {
        res.end();
      }
    }
  });
  return server;
}

// CLI entry: verify the Codex CLI is authenticated, then serve on localhost.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const status = spawnSync("codex", ["login", "status"], { timeout: 20000, stdio: "ignore" });
  if (status.status !== 0) {
    console.error("[codex-proxy] `codex login status` failed — run `codex login` first. Refusing to start.");
    process.exit(1);
  }
  const port = Number(process.env.NOTDND_CODEX_PROXY_PORT || DEFAULT_PORT);
  createCodexProxy().listen(port, "127.0.0.1", () => {
    console.log(`[codex-proxy] listening on http://127.0.0.1:${port}/v1/chat/completions (personal testing only)`);
  });
}
