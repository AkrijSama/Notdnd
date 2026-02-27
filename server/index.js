import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAiJobProcessor } from "./ai/processor.js";
import { generateWithProvider, listAiProviders } from "./ai/providers.js";
import { readJsonBody, serveStatic, writeJson, writeText } from "./api/http.js";
import { handleQuickstartBuildPayload, handleQuickstartParsePayload } from "./api/quickstartRoutes.js";
import {
  applyOperation,
  createQuickstartCampaignFromParsed,
  getState,
  initializeDatabase,
  resolveStorePath
} from "./db/repository.js";
import { createWsHub } from "./realtime/wsHub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

initializeDatabase();

const wsHub = createWsHub({
  onClientMessage(message, _client, { broadcast }) {
    if (message?.type !== "op" || !message?.op) {
      return;
    }

    try {
      const opResult = applyOperation(message.op, message.payload || {});
      const snapshot = getState();
      broadcast({
        type: "op_applied",
        op: message.op,
        result: opResult,
        selectedCampaignId: snapshot.selectedCampaignId,
        timestamp: Date.now()
      });
      wsHub.broadcastStateChanged({
        campaignId: message.payload?.campaignId || snapshot.selectedCampaignId || "global",
        reason: "websocket-op",
        op: message.op
      });
    } catch (error) {
      broadcast({
        type: "op_error",
        op: message.op,
        error: String(error.message || error),
        timestamp: Date.now()
      });
    }
  }
});

const aiProcessor = createAiJobProcessor({
  onJobUpdated(evt) {
    wsHub.broadcastStateChanged({
      campaignId: evt.campaignId || "global",
      reason: "ai-job",
      op: "set_ai_job_status"
    });
  }
});

async function handleApi(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    writeJson(res, 200, {
      ok: true,
      service: "notdnd-api",
      timestamp: Date.now(),
      dbPath: resolveStorePath(),
      realtimeConnections: wsHub.connectionCount()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    writeJson(res, 200, {
      ok: true,
      state: getState()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ai/providers") {
    writeJson(res, 200, {
      ok: true,
      providers: listAiProviders()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/generate") {
    try {
      const payload = await readJsonBody(req);
      const result = await generateWithProvider({
        provider: payload.provider,
        type: payload.type,
        prompt: payload.prompt,
        model: payload.model
      });
      writeJson(res, 200, { ok: true, result });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error.message || error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ops") {
    try {
      const payload = await readJsonBody(req);
      const op = String(payload.op || "");
      if (!op) {
        throw new Error("op is required");
      }

      const opPayload = payload.payload || {};
      const result = applyOperation(op, opPayload);

      if (op === "queue_ai_job") {
        aiProcessor.processJob(result.id, {
          provider: opPayload.providerName,
          model: opPayload.modelValue
        });
      }

      const snapshot = getState();
      wsHub.broadcastStateChanged({
        campaignId: opPayload.campaignId || snapshot.selectedCampaignId || "global",
        reason: "api-op",
        op
      });

      writeJson(res, 200, {
        ok: true,
        result,
        state: snapshot
      });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error.message || error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quickstart/build") {
    try {
      const payload = await readJsonBody(req);
      const response = handleQuickstartBuildPayload(payload, {
        createQuickstartCampaignFromParsed,
        getState
      });
      wsHub.broadcastStateChanged({
        campaignId: response.launch.campaignId,
        reason: "quickstart-build",
        op: "quickstart_build"
      });

      writeJson(res, 200, {
        ok: true,
        ...response
      });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error.message || error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quickstart/parse") {
    try {
      const payload = await readJsonBody(req);
      writeJson(res, 200, { ok: true, ...handleQuickstartParsePayload(payload) });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error.message || error) });
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if ((req.url || "").startsWith("/api/")) {
    const handled = await handleApi(req, res);
    if (!handled) {
      writeText(res, 404, "Not found");
    }
    return;
  }

  serveStatic(req, res, repoRoot);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wsHub.handleUpgrade(req, socket, head);
});

const port = Number(process.env.PORT || 4173);
server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed to start Notdnd server on port ${port}:`, error.message || error);
  process.exit(1);
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Notdnd server listening on http://localhost:${port}`);
});
