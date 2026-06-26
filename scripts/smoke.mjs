import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const host = process.env.NOTDND_HOST || process.env.HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_PORT || process.env.PORT || 4273);
const baseUrl = `http://${host}:${port}`;

let passCount = 0;
let failCount = 0;
let waitlistDuplicateBehavior = "unknown";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTest(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passCount += 1;
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failCount += 1;
    console.error(`FAIL ${name} (${Date.now() - started}ms)`);
    console.error(`  ${String(error?.stack || error?.message || error)}`);
  }
}

function printGroup(name) {
  console.log(`\n=== ${name} ===`);
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

async function waitForHealth(timeoutMs = 15_000) {
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
      // retry while server is starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

function encodeMaskedTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  if (payload.length >= 126) {
    throw new Error("WebSocket smoke payload too large");
  }
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }

    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + payloadLength;
    if (offset + totalLength > buffer.length) {
      break;
    }

    if (opcode === 0x1) {
      const payload = buffer.subarray(offset + headerLength + maskLength, offset + totalLength);
      messages.push(payload.toString("utf8"));
    }

    offset += totalLength;
  }

  return {
    messages,
    remaining: buffer.subarray(offset)
  };
}

function makeWsClient({ token, campaignId }) {
  const socket = net.createConnection({ host, port });
  const key = crypto.randomBytes(16).toString("base64");

  let stage = "handshake";
  let handshakeBuffer = "";
  let frameBuffer = Buffer.alloc(0);
  const events = [];
  const waiters = [];

  function deliver(event) {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (waiter.predicate(event)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
        return;
      }
    }
    events.push(event);
  }

  function waitFor(predicate, timeoutMs = 5000) {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (predicate(event)) {
        events.splice(i, 1);
        return Promise.resolve(event);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError = new Error("WAIT_TIMEOUT");
        timeoutError.code = "WAIT_TIMEOUT";
        const idx = waiters.findIndex((entry) => entry.resolve === resolve);
        if (idx !== -1) {
          waiters.splice(idx, 1);
        }
        reject(timeoutError);
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  const connectedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket connect timeout"));
    }, 5000);

    socket.on("connect", () => {
      socket.write([
        `GET /ws?campaignId=${encodeURIComponent(campaignId)}&token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      if (stage === "handshake") {
        handshakeBuffer += chunk.toString("binary");
        const marker = handshakeBuffer.indexOf("\r\n\r\n");
        if (marker === -1) {
          return;
        }

        const headers = handshakeBuffer.slice(0, marker);
        if (!headers.includes("101 Switching Protocols")) {
          clearTimeout(timer);
          reject(new Error("WebSocket handshake failed"));
          return;
        }

        const rest = Buffer.from(handshakeBuffer.slice(marker + 4), "binary");
        frameBuffer = Buffer.concat([frameBuffer, rest]);
        stage = "frames";
        clearTimeout(timer);
        resolve();
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }

      if (stage === "frames") {
        const decoded = decodeFrames(frameBuffer);
        frameBuffer = decoded.remaining;
        for (const raw of decoded.messages) {
          try {
            deliver(JSON.parse(raw));
          } catch {
            // ignore malformed payloads
          }
        }
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return {
    connectedPromise,
    waitFor,
    send(message) {
      socket.write(encodeMaskedTextFrame(JSON.stringify(message)));
    },
    clearEvents() {
      events.length = 0;
    },
    close() {
      socket.end();
    }
  };
}

async function expectNoEvent(client, predicate, timeoutMs = 1500) {
  try {
    const event = await client.waitFor(predicate, timeoutMs);
    throw new Error(`Unexpected event: ${String(event?.type || "unknown")}`);
  } catch (error) {
    if (error?.code === "WAIT_TIMEOUT") {
      return;
    }
    throw error;
  }
}

function startServer() {
  const child = spawn(process.execPath, ["scripts/start-test-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NOTDND_HOST: host,
      NOTDND_MOCK_OPENROUTER: "true",
      NOTDND_STREAM: "true"
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

function mdEntity({ type, name, tags, relations, body }) {
  const relationLines = (relations || [])
    .map((relation) => `  - target: \"${relation.target}\"\n    type: ${relation.type}`)
    .join("\n");

  return [
    "---",
    `type: ${type}`,
    `name: \"${name}\"`,
    `tags: [${(tags || []).join(", ")}]`,
    "relations:",
    relationLines,
    "lastAccessed: 2026-03-04T12:00:00Z",
    "lastUpdated: 2026-03-04T12:00:00Z",
    "accessCount: 1",
    "confidence: 0.95",
    "---",
    "",
    body,
    ""
  ].join("\n");
}

async function main() {
  const localTmp = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-smoke-local-"));
  const localDbPath = path.join(localTmp, "smoke.db.json");
  const localMemoryRoot = path.join(localTmp, "memory");

  process.env.NOTDND_DB_PATH = localDbPath;
  process.env.NOTDND_MEMORY_ROOT = localMemoryRoot;
  process.env.NOTDND_MOCK_OPENROUTER = "true";

  const repository = await import("../server/db/repository.js");
  const memoryStore = await import("../server/gm/memoryStore.js");
  const triggerParser = await import("../server/gm/triggerParser.js");
  const promptProfiles = await import("../server/gm/promptProfiles.js");
  const onboarding = await import("../server/campaign/onboarding.js");
  const prompting = await import("../server/gm/prompting.js");

  repository.initializeDatabase();
  repository.resetDatabase();

  printGroup("Memory Store");
  const memoryCampaignId = `cmp_smoke_memory_${Date.now()}`;
  const memoryCampaignRoot = path.join(localMemoryRoot, memoryCampaignId);
  const memoryDir = path.join(memoryCampaignRoot, "memory");

  await runTest("1) create temp campaign and initialize index", async () => {
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "mira.md"),
      mdEntity({
        type: "npc",
        name: "Mira",
        tags: ["ashenmoor", "tavern-keeper", "quest-giver"],
        relations: [
          { target: "The Shattered Flagon", type: "resides_in" },
          { target: "The Missing Shipment", type: "investigating" }
        ],
        body: "Mira tends bar in [[The Shattered Flagon]] and worries about [[The Missing Shipment]]."
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(memoryDir, "the-shattered-flagon.md"),
      mdEntity({
        type: "location",
        name: "The Shattered Flagon",
        tags: ["ashenmoor", "tavern"],
        relations: [{ target: "Ashenmoor", type: "located_in" }],
        body: "A tavern in [[Ashenmoor]] where rumors move faster than ale. [[Mira]] runs the house."
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(memoryDir, "the-missing-shipment.md"),
      mdEntity({
        type: "quest",
        name: "The Missing Shipment",
        tags: ["quest", "caravan"],
        relations: [{ target: "Ashenmoor", type: "threatens" }],
        body: "A caravan vanished on the road to [[Ashenmoor]]."
      }),
      "utf8"
    );

    const rebuilt = await memoryStore.rebuildCampaignIndex(memoryCampaignId);
    assert(rebuilt.entities >= 3, "expected at least 3 entities indexed");
  });

  await runTest("2) search tavern finds location", async () => {
    const results = await memoryStore.search(memoryCampaignId, "tavern", { limit: 5 });
    assert(results.some((entry) => entry.name === "The Shattered Flagon"), "expected tavern result");
  });

  await runTest("3) type filter npc returns only NPC rows", async () => {
    const results = await memoryStore.search(memoryCampaignId, "mira", { type: "npc", limit: 5 });
    assert(results.length >= 1, "expected npc results");
    assert(results.every((entry) => entry.type === "npc"), "type filter failed");
  });

  await runTest("4) getRelated(Mira, 1) traverses linked graph", async () => {
    const related = await memoryStore.getRelated(memoryCampaignId, "Mira", 1);
    const names = new Set((related.entities || []).map((entry) => entry.name));
    assert(names.has("Mira"), "missing Mira root");
    assert(names.has("The Shattered Flagon"), "missing linked tavern");
  });

  await runTest("5) upsertEntity creates new file with frontmatter", async () => {
    const entity = await memoryStore.upsertEntity(memoryCampaignId, {
      name: "Captain Rook",
      type: "npc",
      tags: ["smuggler"],
      body: "A smuggler who keeps one eye on the river and one on the law.",
      relations: [{ target: "Ashenmoor", type: "operates_in" }]
    });

    const filePath = path.join(memoryDir, entity.fileName);
    const raw = await fs.readFile(filePath, "utf8");
    assert(raw.includes("---"), "missing frontmatter boundary");
    assert(raw.includes("name: \"Captain Rook\""), "missing frontmatter name");
  });

  await runTest("6) upsert existing entity updates without duplicates", async () => {
    await memoryStore.upsertEntity(memoryCampaignId, {
      name: "Mira",
      type: "npc",
      tags: ["updated"],
      body: "Mira keeps the tavern ledger under lock and key.",
      relations: [{ target: "The Shattered Flagon", type: "resides_in" }]
    });
    const files = await fs.readdir(memoryDir);
    const miraFiles = files.filter((file) => file.toLowerCase().includes("mira") && file.endsWith(".md"));
    assert(miraFiles.length === 1, `expected one Mira file, got ${miraFiles.length}`);
  });

  await runTest("7) buildContextWindow respects proxy budget", async () => {
    const context = await memoryStore.buildContextWindow(memoryCampaignId, "mira tavern shipment", 1500);
    assert(context.length <= 6000, `expected <= 6000 chars, got ${context.length}`);
  });

  await runTest("8) buildContextWindow includes relevant and related entities", async () => {
    const context = await memoryStore.buildContextWindow(memoryCampaignId, "mira tavern shipment", 1500);
    assert(context.includes("Mira"), "expected Mira in context window");
    assert(context.includes("The Shattered Flagon"), "expected tavern in context window");
  });

  await runTest("9) recordAccess bumps lastAccessed and accessCount", async () => {
    const before = await memoryStore.getEntity(memoryCampaignId, "Mira");
    await memoryStore.recordAccess(memoryCampaignId, "Mira");
    const after = await memoryStore.getEntity(memoryCampaignId, "Mira");
    assert(Number(after.accessCount) === Number(before.accessCount) + 1, "accessCount did not increment");
    assert(new Date(after.lastAccessed).getTime() >= new Date(before.lastAccessed).getTime(), "lastAccessed did not advance");
  });

  await runTest("10) cleanup temp campaign directory", async () => {
    await fs.rm(memoryCampaignRoot, { recursive: true, force: true });
    await fs.access(memoryCampaignRoot).then(
      () => {
        throw new Error("campaign directory should be removed");
      },
      () => {}
    );
  });

  printGroup("Trigger Parser");

  await runTest("11) parse clean CHECK trigger", async () => {
    const parsed = triggerParser.parseTriggers("You force the latch. [CHECK: Strength DC 14]");
    assert(parsed.triggers.length === 1, "expected one trigger");
    assert(parsed.triggers[0].type === "CHECK", "expected CHECK type");
    assert(parsed.narrative === "You force the latch.", "expected clean narrative");
  });

  await runTest("12) parse INITIATIVE embedded in prose", async () => {
    const parsed = triggerParser.parseTriggers("Steel flashes [INITIATIVE] around the room.");
    assert(parsed.triggers.some((entry) => entry.type === "INITIATIVE"), "expected INITIATIVE trigger");
  });

  await runTest("13) parse multiple triggers in one response", async () => {
    const parsed = triggerParser.parseTriggers("[CHECK: DEX DC 12] [DAMAGE: 1d8+3 slashing] [NEW_ENTITY: name=Garrick type=npc]");
    assert(parsed.triggers.length === 3, "expected three triggers");
    assert(parsed.triggers[0].type === "CHECK", "CHECK order mismatch");
    assert(parsed.triggers[1].type === "DAMAGE", "DAMAGE order mismatch");
    assert(parsed.triggers[2].type === "NEW_ENTITY", "NEW_ENTITY order mismatch");
  });

  await runTest("14) no triggers leaves narrative unchanged", async () => {
    const source = "Mira watches the door while thunder rolls.";
    const parsed = triggerParser.parseTriggers(source);
    assert(parsed.triggers.length === 0, "expected zero triggers");
    assert(parsed.narrative === source, "narrative changed unexpectedly");
  });

  await runTest("15) malformed CHECK without colon parses leniently", async () => {
    const parsed = triggerParser.parseTriggers("[CHECK Strength DC14]");
    assert(parsed.triggers.length === 1, "expected one trigger");
    assert(parsed.triggers[0].type === "CHECK", "expected CHECK");
    assert(parsed.triggers[0].parsed.dc === 14, "expected DC 14");
  });

  await runTest("16) variant trigger names parse correctly", async () => {
    const parsed = triggerParser.parseTriggers("[SKILL CHECK: Dexterity DC 12] [ROLL INITIATIVE] [TREASURE: rare]");
    const types = parsed.triggers.map((entry) => entry.type);
    assert(types.includes("CHECK"), "missing CHECK variant");
    assert(types.includes("INITIATIVE"), "missing INITIATIVE variant");
    const loot = parsed.triggers.find((entry) => entry.type === "LOOT");
    assert(loot?.parsed?.tier === "rare", "expected rare loot tier");
  });

  await runTest("17) DC clamp handles low/high bounds", async () => {
    const low = triggerParser.parseTriggers("[CHECK: Strength DC 0]").triggers[0];
    const high = triggerParser.parseTriggers("[CHECK: Strength DC 35]").triggers[0];
    assert(low.parsed.dc === 1, "expected low clamp to 1");
    assert(high.parsed.dc === 30, "expected high clamp to 30");
  });

  printGroup("Prompt Profiles");

  await runTest("18) getProfile resolves grok prefix", async () => {
    const profile = promptProfiles.getProfile("x-ai/grok-3");
    assert(profile.maxResponseTokens === 600, "unexpected grok max tokens");
    assert(String(profile.triggerFormat).includes("CRITICAL"), "missing grok trigger format");
  });

  await runTest("19) getProfile resolves venice prefix", async () => {
    const profile = promptProfiles.getProfile("venice/uncensored:free");
    assert(profile.maxResponseTokens === 400, "unexpected venice max tokens");
    assert(String(profile.triggerFormat).includes("EXACT trigger syntax"), "missing venice trigger format");
  });

  await runTest("20) unknown model uses default meta-llama profile", async () => {
    const unknown = promptProfiles.getProfile("unknown-model/v1");
    const fallback = promptProfiles.getProfile("meta-llama/llama-3.3-70b-instruct:free");
    assert(unknown.responseStyle === fallback.responseStyle, "unknown model did not fallback to meta-llama profile");
  });

  await runTest("21) all profiles expose required fields", async () => {
    const catalog = promptProfiles.listProfiles();
    const required = ["triggerFormat", "responseStyle", "structuredHints", "temperature", "maxResponseTokens", "stopSequences"];
    for (const [prefix, profile] of Object.entries(catalog)) {
      for (const key of required) {
        assert(profile[key] !== undefined, `${prefix} missing ${key}`);
      }
      assert(Array.isArray(profile.stopSequences), `${prefix} stopSequences must be array`);
    }
  });

  printGroup("Onboarding");

  await runTest("22) createOnboardingCampaign seeds campaign and memory graph", async () => {
    repository.resetDatabase();
    const login = repository.loginUser({ email: "demo@notdnd.local", password: "demo1234" });
    const { campaignId } = await onboarding.createOnboardingCampaign(login.user.id, {
      characterName: "Nyx",
      archetype: "a disgraced knight",
      backstorySnippet: "I fled the capital after betraying my order."
    });

    const state = repository.getState({ userId: login.user.id });
    assert(state.campaigns.some((entry) => entry.id === campaignId), "missing onboarding campaign");

    const onboardingMemoryDir = path.join(localMemoryRoot, campaignId, "memory");
    const seedFiles = (await fs.readdir(onboardingMemoryDir)).filter((entry) => entry.endsWith(".md"));
    assert(seedFiles.length >= 9, `expected >=9 seed docs, got ${seedFiles.length}`);

    const roleSeed = await fs.readFile(path.join(onboardingMemoryDir, "03-npc-the-tavern-keeper.md"), "utf8");
    assert(roleSeed.includes("type: npc"), "tavern keeper role seed frontmatter missing type");
    assert(roleSeed.includes('name: "The Tavern Keeper"'), "tavern keeper role seed missing role name");
    assert(roleSeed.includes("[[The Shattered Flagon]]"), "tavern keeper role seed missing wiki links");

    const playerEntity = await memoryStore.getEntity(campaignId, "Nyx");
    assert(playerEntity, "player_character entity missing");
    assert(/disgraced knight/i.test(playerEntity.body), "archetype missing from player entity");
    assert(/fled the capital/i.test(playerEntity.body), "backstory snippet missing from player entity");

    await fs.rm(path.join(localMemoryRoot, campaignId), { recursive: true, force: true });
  });

  printGroup("Server Smoke");
  const server = startServer();

  try {
    await runTest("23) server health endpoint is available", async () => {
      const health = await waitForHealth();
      assert(health.service === "notdnd-api", "unexpected health service name");
    });

    let token = "";
    let campaignId = "";

    await runTest("24) login and fetch campaign id", async () => {
      const login = await httpRequest("/api/auth/login", {
        method: "POST",
        body: { email: "demo@notdnd.local", password: "demo1234" }
      });
      token = login.payload.token;
      assert(token, "missing auth token");
      const state = await httpRequest("/api/state", { token });
      campaignId = state.payload.state.selectedCampaignId;
      assert(campaignId, "missing selected campaign");
    });

    printGroup("Waitlist");

    await runTest("25) POST /api/waitlist accepts valid email", async () => {
      const response = await httpRequest("/api/waitlist", {
        method: "POST",
        body: { email: "smoke.waitlist@example.com", interest: "All of it" }
      });
      assert(response.payload.success === true, "waitlist success missing");
    });

    await runTest("26) POST /api/waitlist rejects invalid email", async () => {
      const response = await httpRequest("/api/waitlist", {
        method: "POST",
        body: { email: "invalid-email", interest: "AI Game Master" },
        expectedStatus: 400
      });
      assert(response.payload.ok === false, "expected error response");
    });

    await runTest("27) duplicate waitlist handling is documented", async () => {
      await httpRequest("/api/waitlist", {
        method: "POST",
        body: { email: "smoke.duplicate@example.com", interest: "Multiplayer" }
      });
      await httpRequest("/api/waitlist", {
        method: "POST",
        body: { email: "smoke.duplicate@example.com", interest: "Never-Forget Memory" }
      });

      const list = await httpRequest("/api/waitlist", { token });
      const matches = (list.payload.entries || []).filter((entry) => entry.email === "smoke.duplicate@example.com");
      if (matches.length >= 2) {
        waitlistDuplicateBehavior = "allow";
      } else if (matches.length === 1) {
        waitlistDuplicateBehavior = "dedupe";
      } else {
        throw new Error("duplicate email not persisted");
      }
    });

    printGroup("API Routes");

    await runTest("28) GET /api/ai/usage without auth returns 401", async () => {
      const response = await httpRequest(`/api/ai/usage?campaignId=${encodeURIComponent(campaignId)}`, {
        expectedStatus: 401
      });
      assert(response.payload.code === "UNAUTHORIZED", "expected UNAUTHORIZED code");
    });

    await runTest("29) GET /api/ai/usage with auth returns usage shape", async () => {
      const response = await httpRequest(`/api/ai/usage?campaignId=${encodeURIComponent(campaignId)}`, { token });
      assert(response.payload.usage, "missing usage payload");
      assert(typeof response.payload.usage.promptTokens === "number", "promptTokens should be a number");
      assert(response.payload.modelTiers?.narrative, "missing model tier mapping");
    });

    await runTest("30) POST /api/gm/respond companion hits pipeline and trigger parser", async () => {
      const response = await httpRequest("/api/gm/respond", {
        method: "POST",
        token,
        body: {
          campaignId,
          mode: "companion",
          message: "I try to pick the lock behind the bar.",
          playerName: "Demo GM"
        }
      });
      assert(typeof response.payload.narrative === "string" && response.payload.narrative.length > 0, "missing narrative");
      assert(Array.isArray(response.payload.mechanical?.rolls), "missing mechanical rolls");
      assert(response.payload.mechanical.rolls.some((roll) => roll.type === "check"), "expected check roll result");
      assert(!response.payload.narrative.includes("[CHECK"), "narrative should not include trigger tags");
    });

    await runTest("31) runGmPipeline builds profiled system prompt (direct)", async () => {
      const login = repository.loginUser({ email: "demo@notdnd.local", password: "demo1234" });
      const state = repository.getState({ userId: login.user.id });
      const response = await prompting.runGmPipeline({
        campaignId: state.selectedCampaignId,
        message: "Tell me about Mira.",
        mode: "companion",
        playerName: "Demo GM",
        actorUserId: login.user.id
      });
      assert(response.meta?.systemPrompt?.includes("[TRIGGER FORMAT]"), "missing trigger format prompt section");
      assert(response.meta?.systemPrompt?.includes("[RESPONSE STYLE]"), "missing response style prompt section");
      assert(typeof response.meta?.profile?.temperature === "number", "missing profile temperature metadata");
    });

    await runTest("32) GET /api/gm/memory returns entity list", async () => {
      const response = await httpRequest(`/api/gm/memory?campaignId=${encodeURIComponent(campaignId)}`, { token });
      assert(Array.isArray(response.payload.entities), "entities should be an array");
    });

    await runTest("33) POST /api/gm/memory/search routes through memoryStore", async () => {
      await httpRequest("/api/gm/memory", {
        method: "POST",
        token,
        body: {
          campaignId,
          entity: {
            name: "Smoke Search Tavern",
            type: "location",
            tags: ["smoke", "tavern"],
            body: "A test tavern for smoke route validation."
          }
        }
      });

      const response = await httpRequest("/api/gm/memory/search", {
        method: "POST",
        token,
        body: {
          campaignId,
          query: "smoke tavern",
          limit: 5
        }
      });

      assert(Array.isArray(response.payload.results), "results should be array");
      assert(response.payload.results.some((entry) => entry.name === "Smoke Search Tavern"), "search did not return inserted entity");
    });

    printGroup("WebSocket Session Sync");

    await runTest("34) 2 WS clients sync player message + ai_thinking, OOC skips AI", async () => {
      const clientA = makeWsClient({ token, campaignId });
      const clientB = makeWsClient({ token, campaignId });

      try {
        await clientA.connectedPromise;
        await clientB.connectedPromise;
        await clientA.waitFor((event) => event.type === "connected", 5000);
        await clientB.waitFor((event) => event.type === "connected", 5000);

        clientA.send({
          type: "gm_player_message",
          message: "I step into the rain and draw steel.",
          playerName: "Demo GM"
        });

        const echoed = await clientB.waitFor(
          (event) => event.type === "player_message" && /draw steel/i.test(String(event.text || "")),
          5000
        );
        assert(echoed.playerName === "Demo GM", "player message did not fan out");
        await clientA.waitFor((event) => event.type === "ai_thinking", 5000);
        await clientB.waitFor((event) => event.type === "ai_thinking", 5000);
        await clientA.waitFor((event) => event.type === "ai_response", 5000);
        await clientB.waitFor((event) => event.type === "ai_response", 5000);

        clientA.clearEvents();
        clientB.clearEvents();

        clientA.send({
          type: "gm_player_message",
          message: "(OOC) quick table check",
          playerName: "Demo GM",
          ooc: true
        });

        await clientB.waitFor((event) => event.type === "player_message" && event.ooc === true, 5000);
        await expectNoEvent(clientA, (event) => event.type === "ai_thinking" || event.type === "ai_response", 1500);
        await expectNoEvent(clientB, (event) => event.type === "ai_thinking" || event.type === "ai_response", 1500);
      } finally {
        clientA.close();
        clientB.close();
      }
    });
  } finally {
    await server.stop();
  }

  await fs.rm(localTmp, { recursive: true, force: true });

  const total = passCount + failCount;
  console.log("\n=== Smoke Summary ===");
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total: ${total}`);
  console.log(`Waitlist duplicate handling: ${waitlistDuplicateBehavior}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
