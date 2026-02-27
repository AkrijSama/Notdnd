import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAiJobProcessor } from "./ai/processor.js";
import { generateWithProvider, listAiProviders } from "./ai/providers.js";
import { readJsonBody, serveStatic, writeJson, writeText } from "./api/http.js";
import { handleQuickstartBuildPayload, handleQuickstartParsePayload } from "./api/quickstartRoutes.js";
import { tokenFromRequest } from "./auth/httpAuth.js";
import {
  addCampaignMember,
  applyOperation,
  createQuickstartCampaignFromParsed,
  getCurrentStateVersion,
  getMetrics,
  getState,
  getUserBySessionToken,
  initializeDatabase,
  listCampaignMembers,
  loginUser,
  logoutSessionToken,
  registerUser,
  resolveStorePath
} from "./db/repository.js";
import { listCampaignMemoryDocs, searchCampaignMemory, writeCampaignMemoryDoc } from "./gm/memoryStore.js";
import { buildAgentGmPrompt, buildFallbackHumanAdvice, buildHumanGmAssistPrompt } from "./gm/prompting.js";
import { parseHomebrewDocuments } from "./homebrew/parser.js";
import { fetchHomebrewUrl } from "./homebrew/urlImport.js";
import { createWsHub } from "./realtime/wsHub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

initializeDatabase();

function routeError(res, error) {
  const statusCode = Number(error?.statusCode) || 400;
  const payload = {
    ok: false,
    error: String(error?.message || error),
    code: error?.code || "REQUEST_FAILED"
  };

  if (error?.code === "VERSION_CONFLICT") {
    payload.expectedVersion = error.expectedVersion;
    payload.currentVersion = error.currentVersion;
  }

  writeJson(res, statusCode, payload);
}

function resolveAuthUser(req) {
  const token = tokenFromRequest(req);
  if (!token) {
    return null;
  }
  return getUserBySessionToken(token);
}

function requireAuth(req) {
  const user = resolveAuthUser(req);
  if (!user) {
    throw Object.assign(new Error("Authentication required."), {
      code: "UNAUTHORIZED",
      statusCode: 401
    });
  }
  return user;
}

function userCanAccessCampaign(userId, campaignId) {
  if (!campaignId || !userId) {
    return false;
  }
  const state = getState({ userId });
  return state.campaigns.some((campaign) => campaign.id === campaignId);
}

function inferCampaignIdForPayload(userId, payload = {}) {
  if (payload.campaignId) {
    return String(payload.campaignId);
  }

  if (payload.mapId) {
    const state = getState({ userId });
    const map = state.maps.find((entry) => entry.id === payload.mapId);
    return map?.campaignId || null;
  }

  const state = getState({ userId });
  return state.selectedCampaignId || null;
}

function lockResourceForOperation(op) {
  if (op === "set_token_position") {
    return "token_move";
  }
  if (op === "toggle_fog_cell") {
    return "fog_edit";
  }
  if (op === "add_initiative_turn") {
    return "initiative_edit";
  }
  return null;
}

function assertOperationLock(user, op, payload = {}) {
  const resource = lockResourceForOperation(op);
  if (!resource) {
    return;
  }

  const campaignId = inferCampaignIdForPayload(user.id, payload);
  if (!campaignId) {
    return;
  }

  const lock = wsHub.getLock(campaignId, resource);
  if (lock && lock.ownerUserId !== user.id) {
    throw Object.assign(new Error(`Resource lock active on ${resource} by ${lock.ownerName || lock.ownerUserId}`), {
      code: "LOCKED",
      statusCode: 423,
      lock
    });
  }
}

function broadcastAuthoritativeState(campaignId, reason, op) {
  if (!campaignId || campaignId === "global") {
    return;
  }

  const clients = wsHub.getClientsInCampaign(campaignId);
  for (const client of clients) {
    const state = getState({ userId: client.user.id });
    wsHub.sendToClient(client.id, {
      type: "sync_state",
      campaignId,
      reason,
      op,
      state,
      stateVersion: state.stateVersion,
      timestamp: Date.now()
    });
  }
}

const wsHub = createWsHub({
  authenticateToken(token) {
    return getUserBySessionToken(token);
  },
  canJoinCampaign(user, campaignId) {
    return Boolean(user && userCanAccessCampaign(user.id, campaignId));
  },
  onClientMessage(message, client, { sendToClient }) {
    if (message?.type !== "op" || !message?.op) {
      return;
    }

    const user = client.user;

    try {
      assertOperationLock(user, message.op, message.payload || {});

      const opResult = applyOperation(message.op, message.payload || {}, {
        actorUserId: user.id,
        expectedVersion: message.expectedVersion
      });
      const campaignId = inferCampaignIdForPayload(user.id, message.payload || {});
      const snapshot = getState({ userId: user.id });

      sendToClient(client.id, {
        type: "op_applied",
        op: message.op,
        result: opResult,
        stateVersion: snapshot.stateVersion,
        selectedCampaignId: snapshot.selectedCampaignId,
        timestamp: Date.now()
      });

      if (campaignId) {
        broadcastAuthoritativeState(campaignId, "websocket-op", message.op);
      }
    } catch (error) {
      sendToClient(client.id, {
        type: "op_error",
        op: message.op,
        error: String(error.message || error),
        code: error?.code || "REQUEST_FAILED",
        currentVersion: error?.currentVersion,
        expectedVersion: error?.expectedVersion,
        lock: error?.lock,
        timestamp: Date.now()
      });
    }
  }
});

const aiProcessor = createAiJobProcessor({
  onJobUpdated(evt) {
    if (evt.campaignId) {
      broadcastAuthoritativeState(evt.campaignId, "ai-job", "set_ai_job_status");
    }
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

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const payload = await readJsonBody(req);
      const result = registerUser(payload);
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const payload = await readJsonBody(req);
      const result = loginUser(payload);
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      const token = tokenFromRequest(req);
      if (!token) {
        throw Object.assign(new Error("Authentication required."), { code: "UNAUTHORIZED", statusCode: 401 });
      }
      logoutSessionToken(token);
      writeJson(res, 200, { ok: true });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    try {
      const user = requireAuth(req);
      writeJson(res, 200, { ok: true, user });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics") {
    try {
      const user = requireAuth(req);
      if (!user.isAdmin) {
        throw Object.assign(new Error("Admin access required."), { code: "FORBIDDEN", statusCode: 403 });
      }
      writeJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        metrics: {
          ...getMetrics(),
          realtimeConnections: wsHub.connectionCount()
        }
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    try {
      const user = requireAuth(req);
      writeJson(res, 200, {
        ok: true,
        state: getState({ userId: user.id })
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/campaign/members") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      const members = listCampaignMembers(campaignId, { actorUserId: user.id });
      writeJson(res, 200, { ok: true, members });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/campaign/members") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const result = addCampaignMember(payload, { actorUserId: user.id });
      const state = getState({ userId: user.id });
      if (payload.campaignId) {
        broadcastAuthoritativeState(String(payload.campaignId), "member-update", "campaign_member_add");
      }
      writeJson(res, 200, { ok: true, result, state });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ai/providers") {
    try {
      requireAuth(req);
      writeJson(res, 200, {
        ok: true,
        providers: listAiProviders()
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/generate") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      const result = await generateWithProvider({
        provider: payload.provider,
        type: payload.type,
        prompt: payload.prompt,
        model: payload.model
      });
      writeJson(res, 200, { ok: true, result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/gm/memory") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      if (!userCanAccessCampaign(user.id, campaignId)) {
        throw Object.assign(new Error("Campaign access denied."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }
      writeJson(res, 200, {
        ok: true,
        docs: listCampaignMemoryDocs(campaignId)
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gm/memory") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      const docKey = String(payload.docKey || "");
      if (!campaignId || !docKey) {
        throw Object.assign(new Error("campaignId and docKey are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      if (!userCanAccessCampaign(user.id, campaignId)) {
        throw Object.assign(new Error("Campaign access denied."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }
      writeJson(res, 200, {
        ok: true,
        doc: writeCampaignMemoryDoc(campaignId, docKey, payload.content || "")
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gm/memory/search") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      const query = String(payload.query || "").trim();
      if (!campaignId || !query) {
        throw Object.assign(new Error("campaignId and query are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      if (!userCanAccessCampaign(user.id, campaignId)) {
        throw Object.assign(new Error("Campaign access denied."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }
      writeJson(res, 200, {
        ok: true,
        results: searchCampaignMemory(campaignId, query, {
          docKey: payload.docKey || null,
          limit: payload.limit || 5
        })
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gm/respond") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      const message = String(payload.message || "").trim();
      if (!campaignId || !message) {
        throw Object.assign(new Error("campaignId and message are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      if (!userCanAccessCampaign(user.id, campaignId)) {
        throw Object.assign(new Error("Campaign access denied."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }

      const state = getState({ userId: user.id });
      const gmSettings = state.gmSettings || {};
      const mode = payload.mode === "agent" ? "agent" : payload.mode === "human" ? "human" : (gmSettings.gmMode === "agent" ? "agent" : "human");
      const provider = String(payload.provider || gmSettings.agentProvider || "local");
      const model = String(payload.model || gmSettings.agentModel || "");
      const memorySnippets = searchCampaignMemory(campaignId, message, { limit: 5 });
      const prompt = mode === "agent"
        ? buildAgentGmPrompt({ state, campaignId, message, memorySnippets })
        : buildHumanGmAssistPrompt({ state, campaignId, message, memorySnippets });

      const result = provider === "placeholder" && mode === "human"
        ? {
            provider,
            model: model || "AI_GM_MODEL_VALUE",
            text: buildFallbackHumanAdvice({ state, campaignId, message, memorySnippets })
          }
        : await generateWithProvider({
            provider,
            type: "gm",
            prompt,
            model
          });

      applyOperation(
        "push_chat_line",
        {
          campaignId,
          speaker: user.displayName || "User",
          text: message
        },
        { actorUserId: user.id }
      );
      applyOperation(
        "push_chat_line",
        {
          campaignId,
          speaker: mode === "agent" ? "Agent GM" : "GM Copilot",
          text: result.text || "No response text returned."
        },
        { internal: true }
      );
      broadcastAuthoritativeState(campaignId, "gm-response", "push_chat_line");

      writeJson(res, 200, {
        ok: true,
        mode,
        result,
        memorySnippets
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ops") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const op = String(payload.op || "");
      if (!op) {
        throw Object.assign(new Error("op is required"), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      const opPayload = payload.payload || {};
      assertOperationLock(user, op, opPayload);
      const result = applyOperation(op, opPayload, {
        actorUserId: user.id,
        expectedVersion: payload.expectedVersion
      });

      if (op === "queue_ai_job") {
        aiProcessor.processJob(result.id, {
          provider: opPayload.providerName,
          model: opPayload.modelValue
        });
      }

      const snapshot = getState({ userId: user.id });
      const campaignId = inferCampaignIdForPayload(user.id, opPayload) || snapshot.selectedCampaignId || null;
      if (campaignId) {
        broadcastAuthoritativeState(campaignId, "api-op", op);
      }

      writeJson(res, 200, {
        ok: true,
        result,
        state: snapshot
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quickstart/build") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      if (payload.expectedVersion !== undefined && payload.expectedVersion !== null) {
        const expected = Number(payload.expectedVersion);
        const current = getCurrentStateVersion();
        if (Number.isFinite(expected) && expected !== current) {
          throw Object.assign(new Error("State version conflict."), {
            code: "VERSION_CONFLICT",
            statusCode: 409,
            expectedVersion: expected,
            currentVersion: current
          });
        }
      }
      const response = handleQuickstartBuildPayload(payload, {
        createQuickstartCampaignFromParsed(request) {
          return createQuickstartCampaignFromParsed({
            ...request,
            actorUserId: user.id
          });
        },
        getState() {
          return getState({ userId: user.id });
        }
      });
      broadcastAuthoritativeState(response.launch.campaignId, "quickstart-build", "quickstart_build");

      writeJson(res, 200, {
        ok: true,
        ...response
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quickstart/parse") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      writeJson(res, 200, { ok: true, ...handleQuickstartParsePayload(payload) });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/homebrew/import-url") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      const fetched = await fetchHomebrewUrl(payload.url);
      const parsed = parseHomebrewDocuments([fetched.file]);
      writeJson(res, 200, {
        ok: true,
        fetched: {
          sourceUrl: fetched.sourceUrl,
          fileName: fetched.file.name,
          contentType: fetched.contentType
        },
        parsed
      });
    } catch (error) {
      routeError(res, error);
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
const host = process.env.NOTDND_HOST || process.env.HOST || "127.0.0.1";
server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed to start Notdnd server on ${host}:${port}:`, error.message || error);
  process.exit(1);
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Notdnd server listening on http://${host}:${port}`);
});
