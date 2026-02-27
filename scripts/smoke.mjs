import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const port = Number(process.env.SMOKE_PORT || process.env.PORT || 4273);
const host = process.env.NOTDND_HOST || process.env.HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, { method = "GET", token = "", body } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(`${method} ${path} failed: ${payload.error || response.status}`);
  }
  return payload;
}

function encodeMaskedTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  if (payload.length >= 126) {
    throw new Error("Smoke websocket payload too large");
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
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }

    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + length;
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

async function websocketSmoke({ token, campaignId }) {
  const socket = net.createConnection({ host, port });
  const key = crypto.randomBytes(16).toString("base64");
  let stage = "handshake";
  let handshakeBuffer = "";
  let frameBuffer = Buffer.alloc(0);
  const messageTypes = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("websocket smoke timeout"));
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

        const headerText = handshakeBuffer.slice(0, marker);
        assert(headerText.includes("101 Switching Protocols"), "websocket handshake failed");
        const rest = Buffer.from(handshakeBuffer.slice(marker + 4), "binary");
        frameBuffer = Buffer.concat([frameBuffer, rest]);
        stage = "frames";
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }

      if (stage === "frames") {
        const decoded = decodeFrames(frameBuffer);
        frameBuffer = decoded.remaining;
        for (const raw of decoded.messages) {
          const payload = JSON.parse(raw);
          messageTypes.push(payload.type);
          if (payload.type === "connected") {
            socket.write(encodeMaskedTextFrame(JSON.stringify({ type: "cursor_update", x: 2, y: 3, label: "move" })));
          }
          if (payload.type === "cursor_state") {
            clearTimeout(timer);
            socket.end();
            resolve();
          }
        }
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return messageTypes;
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await request("/api/health");
      if (health.ok) {
        return health;
      }
    } catch {
      // retry until server is ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function main() {
  const server = spawn(process.execPath, ["scripts/start-test-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NOTDND_HOST: host
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForHealth();
    assert(health.service === "notdnd-api", "health check failed");

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { email: "demo@notdnd.local", password: "demo1234" }
    });
    assert(login.token, "login token missing");
    const token = login.token;

    const state = await request("/api/state", { token });
    const campaignId = state.state.selectedCampaignId;
    assert(campaignId, "selected campaign missing");

    const providers = await request("/api/ai/providers", { token });
    assert(providers.providers.some((entry) => entry.key === "local"), "local provider missing");
    assert(providers.providers.some((entry) => entry.key === "chatgpt"), "chatgpt provider missing");

    const memoryDocs = await request(`/api/gm/memory?campaignId=${encodeURIComponent(campaignId)}`, { token });
    assert(memoryDocs.docs.length === 3, "expected 3 memory docs");

    await request("/api/gm/memory", {
      method: "POST",
      token,
      body: {
        campaignId,
        docKey: "timeline",
        content: "# Shared Timeline\n\n## Smoke\nThe party recovered the ember key.\n"
      }
    });

    const memorySearch = await request("/api/gm/memory/search", {
      method: "POST",
      token,
      body: { campaignId, query: "ember key", limit: 5 }
    });
    assert(memorySearch.results.length >= 1, "memory search returned no results");

    const humanResponse = await request("/api/gm/respond", {
      method: "POST",
      token,
      body: {
        campaignId,
        mode: "human",
        provider: "local",
        model: "local-gm-v1",
        message: "Need pacing help for the reveal."
      }
    });
    assert(humanResponse.result.text, "human gm response missing text");

    const quickstartParse = await request("/api/quickstart/parse", {
      method: "POST",
      token,
      body: {
        files: [
          {
            name: "smoke-homebrew.md",
            content: "# Harbor Siege\nLocation: Drowned Harbor\nNPC: Captain Vey\nMonster: Harbor Ghoul\nSpell: Salt Ward\nItem: Tideglass Key\nEncounter: Harbor Ambush\nRule: Flood Clock"
          }
        ]
      }
    });
    assert((quickstartParse.parsed.summary.scenes || 0) >= 1, "quickstart parse scenes missing");

    const quickstartBuild = await request("/api/quickstart/build", {
      method: "POST",
      token,
      body: {
        campaignName: "Smoke Campaign",
        setting: "Storm Coast",
        players: ["Kai", "Rune"],
        parsed: quickstartParse.parsed
      }
    });
    assert(quickstartBuild.launch.campaignId, "quickstart build missing campaign id");

    const wsMessages = await websocketSmoke({ token, campaignId });
    assert(wsMessages.includes("connected"), "websocket connected missing");
    assert(wsMessages.includes("cursor_state"), "websocket cursor_state missing");

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      campaignId,
      builtCampaignId: quickstartBuild.launch.campaignId,
      wsMessages
    }, null, 2));
  } finally {
    if (!server.killed) {
      server.kill("SIGTERM");
    }
    await new Promise((resolve) => server.once("exit", resolve));
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
