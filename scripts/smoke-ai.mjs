import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const host = process.env.NOTDND_HOST || process.env.HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_AI_PORT || process.env.PORT || 4275);
const baseUrl = `http://${host}:${port}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.ok) {
          return payload;
        }
      }
    } catch {
      // keep retrying while server boots
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function httpRequest(pathname, { method = "GET", token = "", body, expectedStatus } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (expectedStatus !== undefined) {
    assert(response.status === expectedStatus, `${method} ${pathname} expected ${expectedStatus}, got ${response.status}`);
    return { response, payload };
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(`${method} ${pathname} failed: ${payload?.error || response.status}`);
  }
  return { response, payload };
}

function startServer(envOverrides = {}) {
  const child = spawn(process.execPath, ["scripts/start-test-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NOTDND_HOST: host,
      NOTDND_STREAM: "true",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    async stop() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      await new Promise((resolve) => child.once("exit", resolve));
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
      if (stdout.trim()) {
        process.stdout.write(stdout);
      }
    }
  };
}

async function main() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    console.log("SKIP smoke:ai - OPENROUTER_API_KEY is not set.");
    process.exit(0);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-smoke-ai-"));
  const localDbPath = path.join(tmpRoot, "local-smoke-ai.db.json");
  const localMemoryRoot = path.join(tmpRoot, "local-memory");

  process.env.NOTDND_DB_PATH = localDbPath;
  process.env.NOTDND_MEMORY_ROOT = localMemoryRoot;
  process.env.OPENROUTER_API_KEY = apiKey;
  process.env.NOTDND_GM_MODEL = process.env.NOTDND_GM_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
  process.env.NOTDND_UTILITY_MODEL = process.env.NOTDND_UTILITY_MODEL || "venice/uncensored:free";
  process.env.NOTDND_FALLBACK_MODEL = process.env.NOTDND_FALLBACK_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
  delete process.env.NOTDND_MOCK_OPENROUTER;

  const repository = await import("../server/db/repository.js");
  const openrouter = await import("../server/ai/openrouter.js");

  repository.initializeDatabase();
  repository.resetDatabase();
  const login = repository.loginUser({ email: "demo@notdnd.local", password: "demo1234" });
  const state = repository.getState({ userId: login.user.id });
  const campaignId = state.selectedCampaignId;
  const tiers = openrouter.getModelTiers();

  console.log("=== OpenRouter Live ===");

  const utility = await openrouter.generateUtility(
    [
      { role: "system", content: "You generate concise fantasy names." },
      { role: "user", content: "Generate a name for a tavern." }
    ],
    campaignId
  );
  assert(typeof utility.content === "string" && utility.content.length > 0, "generateUtility returned empty content");
  assert(typeof utility.model === "string" && utility.model.length > 0, "generateUtility missing model");
  assert(typeof utility.tokensUsed?.prompt === "number", "generateUtility missing prompt token usage");
  assert(typeof utility.tokensUsed?.completion === "number", "generateUtility missing completion token usage");
  console.log("PASS generateUtility response shape");

  const narrative = await openrouter.generateNarrative(
    [
      { role: "system", content: "You are an RPG narrator." },
      { role: "user", content: "Describe entering a cursed tavern in 3 sentences." }
    ],
    campaignId
  );
  assert(typeof narrative.content === "string" && narrative.content.length > 0, "generateNarrative returned empty content");
  console.log("PASS generateNarrative non-empty");

  const rawFallback = await openrouter.generateRaw(
    [
      { role: "system", content: "You answer in one sentence." },
      { role: "user", content: "Say hello." }
    ],
    tiers.fallback,
    campaignId
  );
  assert(rawFallback.model === tiers.fallback, `expected fallback model ${tiers.fallback}, got ${rawFallback.model}`);
  console.log("PASS generateRaw fallback model");

  const usage = openrouter.getCampaignUsage(campaignId);
  assert(usage.promptTokens > 0 || usage.completionTokens > 0, "token usage did not increase");
  console.log("PASS token usage tracking");

  const streamedChunks = [];
  const streamed = await openrouter.generateNarrative(
    [
      { role: "system", content: "You are an RPG narrator." },
      { role: "user", content: "Write two short sentences about stormlight on cobblestones." }
    ],
    campaignId,
    {
      stream: true,
      onStream(chunk) {
        streamedChunks.push(String(chunk || ""));
      }
    }
  );
  const assembled = streamedChunks.join("");
  assert(assembled.length > 0, "streaming produced no chunks");
  assert(streamed.content === assembled, "assembled stream does not match final content");
  console.log("PASS streaming assembly");

  console.log("=== Full Loop Live ===");

  const server = startServer({
    OPENROUTER_API_KEY: apiKey,
    NOTDND_GM_MODEL: process.env.NOTDND_GM_MODEL,
    NOTDND_UTILITY_MODEL: process.env.NOTDND_UTILITY_MODEL,
    NOTDND_FALLBACK_MODEL: process.env.NOTDND_FALLBACK_MODEL
  });

  try {
    await waitForHealth();

    const serverLogin = await httpRequest("/api/auth/login", {
      method: "POST",
      body: { email: "demo@notdnd.local", password: "demo1234" }
    });
    const token = serverLogin.payload.token;
    assert(token, "server login missing token");

    const onboardingStart = await httpRequest("/api/onboarding/start", {
      method: "POST",
      token,
      body: {
        characterName: "Veyra",
        archetype: "a fallen inquisitor",
        backstorySnippet: "I betrayed the tribunal to save my sister."
      }
    });
    const onboardingCampaignId = String(onboardingStart.payload.campaignId || "");
    const firstMessage = String(onboardingStart.payload.firstMessage || "");
    assert(onboardingCampaignId, "onboarding campaignId missing");
    assert(firstMessage.length > 120, "firstMessage was not rich enough");
    assert(/veyra/i.test(firstMessage), "firstMessage did not mention the character");
    console.log("PASS onboarding/start real AI narration");

    const companion = await httpRequest("/api/gm/respond", {
      method: "POST",
      token,
      body: {
        campaignId: onboardingCampaignId,
        mode: "companion",
        playerName: "Veyra",
        message: "Tell me about this tavern."
      }
    });
    const companionNarrative = String(companion.payload.narrative || "");
    assert(/shattered flagon|mira/i.test(companionNarrative), "companion response did not reference expected tavern context");
    console.log("PASS companion tavern continuity");

    const sessionLogs = await httpRequest("/api/gm/memory/search", {
      method: "POST",
      token,
      body: {
        campaignId: onboardingCampaignId,
        query: "Session Log",
        type: "session_log",
        limit: 5
      }
    });
    assert((sessionLogs.payload.results || []).length >= 1, "autoMemory did not create or index session_log entries");
    console.log("PASS autoMemory session log update");

    const checkAttempt = await httpRequest("/api/gm/respond", {
      method: "POST",
      token,
      body: {
        campaignId: onboardingCampaignId,
        mode: "companion",
        playerName: "Veyra",
        message: "I try to pick the lock. Include [CHECK: Dexterity DC 12] if a roll is needed."
      }
    });
    const rolls = checkAttempt.payload.mechanical?.rolls || [];
    assert(rolls.some((roll) => roll.type === "check"), "expected parsed CHECK trigger in mechanical output");
    console.log("PASS parsed CHECK trigger through gm/respond");
  } finally {
    await server.stop();
  }

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log("PASS smoke:ai complete");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
