import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotenv() {
  const envPath = path.resolve(process.cwd(), ".env");
  let raw;
  try {
    raw = fsSync.readFileSync(envPath, "utf8");
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotenv();

import { createAiJobProcessor } from "./ai/processor.js";
import { generateNarrative, generateRaw, getCampaignUsage, getModelTiers } from "./ai/openrouter.js";
import { generateWithProvider, listAiProviders } from "./ai/providers.js";
import { detectImageExt, parseMultipartFile, readJsonBody, readRawBody, serveStatic, writeJson, writeText } from "./api/http.js";
import { handleQuickstartBuildPayload, handleQuickstartParsePayload } from "./api/quickstartRoutes.js";
import { tokenFromRequest } from "./auth/httpAuth.js";
import { createOnboardingCampaign, createWorldOnboardingRun } from "./campaign/onboarding.js";
import { generateWorld, regenerateWorldField } from "./solo/worldGen.js";
import { sanitizePlayerText } from "./solo/safety.js";
import {
  addCampaignMember,
  applyOperation,
  assertCampaignPlayAccess,
  assertCampaignReadAccess,
  assertCampaignWriteAccess,
  completeSoloRun,
  createQuickstartCampaignFromParsed,
  createSoloRun,
  getCampaignRole,
  getCampaignRuntimeState,
  createSoloNpc,
  ensureNpcImageAssets,
  getCurrentStateVersion,
  getMetrics,
  getSoloRun,
  getState,
  getUserBySessionToken,
  initializeDatabase,
  listCampaignMembers,
  listSoloRunsForUser,
  confirmPasswordReset,
  loginUser,
  logoutSessionToken,
  markNpcIntroduced,
  registerUser,
  requestPasswordReset,
  resolveStorePath,
  saveSoloRun,
  setCampaignRuntimeState,
  updateImageAssetStatus,
  updateSoloRunBattleMap,
  updateSoloRunNarration
} from "./db/repository.js";
import {
  buildContextWindow,
  archiveEntity,
  getEntity,
  listEntities,
  rebuildCampaignIndex,
  search,
  upsertEntity
} from "./gm/memoryStore.js";
import { buildSessionSystemPrompt, runGmPipeline } from "./gm/prompting.js";
import { buildActionGmMessage } from "./gm/actionNarration.js";
import { getProfile } from "./gm/promptProfiles.js";
import { applyPreset, getPresets } from "./gm/stylePresets.js";
import { buildStylePromptBlock, getStyleConfig, updateStyleConfig, validateStyleUpdate } from "./gm/styleConfig.js";
import { parseHomebrewDocuments } from "./homebrew/parser.js";
import { fetchHomebrewUrl } from "./homebrew/urlImport.js";
import { createWsHub } from "./realtime/wsHub.js";
import { resolveSoloAction } from "./solo/actions.js";
import { resolveGmNarration } from "./solo/gmProvider.js";
import { buildGmRuntimeStatus } from "./solo/gmSmoke.js";
import { enqueueDraftPortrait, enqueueImageJob, enqueueLocationImageJob, enqueuePlayerImageJob, enqueueVariantImageJob, getDraftPortrait, writeUploadedBasePortrait } from "./solo/imageWorker.js";
import { enqueueIdentityJob, runIdentityJob } from "./solo/npcIdentity.js";
import { buildNpcIntroDirective, buildSoloScenePayload, collectNpcsWithPendingIntro } from "./solo/scene.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const waitlistFilePath = process.env.NOTDND_WAITLIST_PATH
  ? path.resolve(process.env.NOTDND_WAITLIST_PATH)
  : path.join(__dirname, "db", "waitlist.json");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const waitlistInterests = new Set([
  "AI Game Master",
  "Never-Forget Memory",
  "Uncensored Content",
  "Multiplayer",
  "Homebrew Support",
  "All of it"
]);
const previewRateByUser = new Map();

// In-memory rate limiter for unauthenticated auth endpoints (login/register):
// max 10 attempts per client IP per 15-minute window. No dependency — a Map of
// ip -> { count, resetAt }. Blocks credential stuffing / brute force. Per
// process, so it resets on restart (acceptable for this layer).
const AUTH_RATE_LIMIT_MAX = 10;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const authRateByIp = new Map();

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

// Throws a 429 once an IP exceeds the window's attempt budget. Counts every
// attempt (success or failure) so a stuffing run cannot hide behind valid hits.
function enforceAuthRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = authRateByIp.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };
    authRateByIp.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > AUTH_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw Object.assign(new Error("Too many attempts. Please wait and try again."), {
      code: "RATE_LIMITED",
      statusCode: 429,
      retryAfterSec
    });
  }
}

initializeDatabase();

async function readWaitlistEntries() {
  try {
    const raw = await fs.readFile(waitlistFilePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeWaitlistEntries(entries) {
  await fs.mkdir(path.dirname(waitlistFilePath), { recursive: true });
  await fs.writeFile(waitlistFilePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

function normalizeWaitlistInterest(rawInterest) {
  const value = String(rawInterest || "").trim();
  if (!value) {
    return "All of it";
  }

  for (const option of waitlistInterests) {
    if (option.toLowerCase() === value.toLowerCase()) {
      return option;
    }
  }

  return value.slice(0, 120);
}

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
  if (Array.isArray(error?.validationErrors)) {
    payload.validationErrors = error.validationErrors;
  }
  if (error?.actionType) {
    payload.actionType = error.actionType;
  }

  writeJson(res, statusCode, payload);
}

function assertGmOrOwner(user, campaignId) {
  const role = getCampaignRole(campaignId, { actorUserId: user.id });
  if (user.isAdmin || role === "owner" || role === "gm") {
    return role;
  }
  throw Object.assign(new Error("GM or owner access required."), {
    code: "FORBIDDEN",
    statusCode: 403
  });
}

function enforcePreviewRateLimit(userId) {
  const key = String(userId || "");
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 3;
  const bucket = (previewRateByUser.get(key) || []).filter((ts) => now - ts < windowMs);
  if (bucket.length >= maxRequests) {
    throw Object.assign(new Error("Preview rate limit exceeded. Max 3 previews per minute."), {
      code: "RATE_LIMITED",
      statusCode: 429
    });
  }
  bucket.push(now);
  previewRateByUser.set(key, bucket);
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
  try {
    assertCampaignReadAccess(campaignId, { actorUserId: userId });
    return true;
  } catch {
    return false;
  }
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

function pushChatLine(campaignId, speaker, text, context = {}) {
  applyOperation(
    "push_chat_line",
    {
      campaignId,
      speaker,
      text
    },
    context
  );
}

async function runAndPersistGmResponse({
  campaignId,
  message,
  mode,
  actorUserId,
  playerName,
  activePlayers = [],
  stream = false,
  onStream
}) {
  const response = await runGmPipeline({
    campaignId,
    message,
    mode,
    actorUserId,
    playerName,
    activePlayers,
    stream,
    onStream
  });

  const userState = getState({ userId: actorUserId });
  const userName = userState.auth?.user?.displayName || playerName || "Player";

  pushChatLine(campaignId, playerName || userName, message, { actorUserId });
  pushChatLine(campaignId, mode === "companion" ? "Companion GM" : "Agent GM", response.narrative, { internal: true });

  return response;
}

const wsHub = createWsHub({
  authenticateToken(token) {
    return getUserBySessionToken(token);
  },
  canJoinCampaign(user, campaignId) {
    return Boolean(user && userCanAccessCampaign(user.id, campaignId));
  },
  getCampaignRuntime(campaignId) {
    return getCampaignRuntimeState(campaignId, { internal: true });
  },
  setCampaignRuntime(campaignId, patch) {
    const runtime = setCampaignRuntimeState(campaignId, patch, { internal: true });
    broadcastAuthoritativeState(campaignId, "runtime-update", "set_campaign_runtime_state");
    return runtime;
  },
  async onGmPlayerMessage(payload) {
    assertCampaignPlayAccess(payload.campaignId, { actorUserId: payload.actorUserId });
    const result = await runAndPersistGmResponse(payload);
    broadcastAuthoritativeState(payload.campaignId, "gm-response", "push_chat_line");
    return result;
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

function parseMemoryEntityFromPath(pathname) {
  const prefix = "/api/gm/memory/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length).trim();
  if (!raw || raw === "search" || raw === "rebuild") {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunIdFromPath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length).trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunActionPath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/actions")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/actions".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunScenePath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/scene")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/scene".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunMapPath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/map")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/map".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunNpcsPath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/npcs")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/npcs".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function parseSoloRunCompletePath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/complete")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/complete".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

// Player-facing summary of a concluded run (player name, where they ended, how
// long they played, and how it ended). Pure; built from server truth.
function buildRunSummary(run) {
  const createdAt = run.createdAt || null;
  const endedAt = run.completedAt || run.updatedAt || null;
  let timePlayedMs = null;
  if (createdAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(createdAt).getTime();
    timePlayedMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  const location = run.locations?.[run.currentLocationId] || null;
  return {
    runId: run.runId,
    playerName: run.player?.displayName || "Adventurer",
    location: location?.name || run.currentLocationId || null,
    status: run.status,
    outcome: run.outcome || run.status,
    createdAt,
    endedAt,
    timePlayedMs
  };
}

function parseSoloRunPortraitPath(pathname) {
  const prefix = "/api/solo/runs/";
  const suffix = "/portrait";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const mid = pathname.slice(prefix.length, -suffix.length);
  const match = /^([^/]+)\/npcs\/([^/]+)$/.exec(mid);
  if (!match) {
    return null;
  }
  return { runId: decodeURIComponent(match[1]), npcId: decodeURIComponent(match[2]) };
}

function parseSoloRunGmScenePath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/gm-scene")) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -"/gm-scene".length).replace(/\/+$/, "").trim();
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

function assertSoloRunAccess(user, run) {
  if (!run || user.isAdmin || !run.userId || run.userId === user.id) {
    return;
  }
  throw Object.assign(new Error("User does not have access to this solo run."), {
    code: "FORBIDDEN",
    statusCode: 403
  });
}

function buildNpcBasePrompt(run, npcId) {
  const npc = run?.npcs?.[npcId] || {};
  if (String(npc.portraitPrompt || "").trim()) {
    return String(npc.portraitPrompt).trim();
  }
  const parts = [npc.displayName || npcId, npc.role || "", npc.appearance || ""]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return `character portrait of ${parts.join(", ")}`;
}

// Returns a fire-and-forget enqueuer for the scene builder. Each visible NPC
// that still needs art gets one image job. Never blocks the scene response.
function makeSceneImageEnqueuer(run) {
  const style = String(run?.flags?.artStyle || "illustrated");
  return (npcIds) => {
    for (const npcId of npcIds) {
      enqueueImageJob({
        runId: run.runId,
        npcId,
        style,
        basePrompt: buildNpcBasePrompt(run, npcId)
      });
    }
  };
}

// Builds the establishing-shot prompt for a location's background image from
// the location name + world tone (e.g. "Ashenmoor Market Square, dark fantasy,
// atmospheric, wide establishing shot, no people").
function buildLocationBasePrompt(run, locationId) {
  const location = run?.locations?.[locationId] || {};
  const name = String(location.name || locationId).trim();
  const tone = String(run?.world?.tone || run?.world?.setting || "dark fantasy").trim();
  return `${name}, ${tone}, atmospheric, wide establishing shot, no people`;
}

// Returns a fire-and-forget enqueuer for the current location's background
// image. Generated once per location; never blocks the scene response.
function makeSceneLocationImageEnqueuer(run) {
  const style = String(run?.flags?.artStyle || "illustrated");
  return (locationId) => {
    enqueueLocationImageJob({
      runId: run.runId,
      locationId,
      style,
      basePrompt: buildLocationBasePrompt(run, locationId)
    });
  };
}

// Real GM narration for the solo Attempt loop. The solo UI is HTTP-only (no
// WebSocket), so narration is delivered in the action response via a *bounded*
// await: if the free GM model answers within the budget it replaces the canned
// template; on timeout/error/missing campaign it falls back to the template so
// the action is never blocked beyond the budget. The mechanical result is
// already committed (saveSoloRun) before this runs.
const GM_ACTION_TIMEOUT_MS = Number(process.env.NOTDND_GM_ACTION_TIMEOUT_MS || 12000);

function withGmTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return value;
      },
      () => {
        if (timer) clearTimeout(timer);
        return null;
      }
    ),
    timeout
  ]);
}

// Generates real GM narration for any resolved solo action (move/talk/search/
// rest/use_item/attempt). Bounded by GM_ACTION_TIMEOUT_MS; returns null on
// timeout/empty so the caller keeps the mechanical template as a fallback.
async function narrateActionWithGm(run, resolved, user) {
  if (!run?.campaignId || !resolved) {
    return null;
  }
  let message = buildActionGmMessage(run, resolved);
  if (!message) {
    return null;
  }
  // Quest advancement: when this action advanced a quest, fold it into the scene
  // context so the GM dramatizes the progress as a meaningful beat.
  if (resolved.questJustAdvanced) {
    const quest = resolved.questJustAdvanced;
    const title = typeof quest.title === "string" && quest.title ? quest.title : "their quest";
    const objective = typeof quest.objective === "string" && quest.objective ? ` — ${quest.objective}` : "";
    message += ` The player has just advanced "${title}"${objective}. Weave this progress naturally into the narration as a turning point, without declaring further quests.`;
  }
  const result = await withGmTimeout(
    runGmPipeline({
      campaignId: run.campaignId,
      message,
      mode: "companion",
      playerName: run.player?.displayName || "the wanderer",
      actorUserId: user?.id
    }),
    GM_ACTION_TIMEOUT_MS
  );
  const narrative = result && typeof result.narrative === "string" ? result.narrative.trim() : "";
  return narrative || null;
}

// TASK B: one final GM call for the victory moment. Builds a "closing narration"
// scene context (the completed quest + a victory hint) and returns the GM's
// triumphant sign-off, or null on timeout/failure (the victory screen still
// renders without it).
async function narrateVictoryWithGm(run, quest, user) {
  if (!run?.campaignId || !quest) {
    return null;
  }
  const title = typeof quest.title === "string" && quest.title ? quest.title : "their quest";
  const objective = typeof quest.objective === "string" && quest.objective ? `: ${quest.objective}` : "";
  const message =
    `The player has completed their quest "${title}"${objective}. This is the triumphant closing ` +
    `moment of the run — the journey is won. Write a short, evocative victory narration ` +
    `(2-3 sentences) celebrating this hard-won conclusion. Do not introduce new quests, ` +
    `rewards, locations, or unresolved threads — this is a closing beat.`;
  const result = await withGmTimeout(
    runGmPipeline({
      campaignId: run.campaignId,
      message,
      mode: "companion",
      playerName: run.player?.displayName || "the wanderer",
      actorUserId: user?.id
    }),
    GM_ACTION_TIMEOUT_MS
  );
  const narrative = result && typeof result.narrative === "string" ? result.narrative.trim() : "";
  return narrative || null;
}

// Fire-and-forget enqueuer for NPC identity generation. Each visible NPC that
// still lacks a generated name gets one identity job. Never blocks the scene.
function makeSceneIdentityEnqueuer(run) {
  return (npcIds) => {
    for (const npcId of npcIds) {
      enqueueIdentityJob({ runId: run.runId, npcId });
    }
  };
}

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
      enforceAuthRateLimit(req);
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
      enforceAuthRateLimit(req);
      const payload = await readJsonBody(req);
      const result = loginUser(payload);
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/reset-request") {
    try {
      const payload = await readJsonBody(req);
      const result = requestPasswordReset(payload);
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/reset-confirm") {
    try {
      const payload = await readJsonBody(req);
      const result = confirmPasswordReset(payload);
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

  if (req.method === "POST" && url.pathname === "/api/solo/runs") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const run = createSoloRun({
        userId: user.id,
        runId: payload.runId,
        worldSeed: payload.worldSeed
      });
      writeJson(res, 201, { ok: true, run });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/solo/runs") {
    try {
      const user = requireAuth(req);
      const runs = listSoloRunsForUser(user.id);
      writeJson(res, 200, { ok: true, runs });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const soloActionRunId = parseSoloRunActionPath(url.pathname);
  if (soloActionRunId && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloActionRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      assertSoloRunAccess(user, run);
      const payload = await readJsonBody(req);
      const action = payload.action || payload;
      const resolved = resolveSoloAction(run, action);
      if (!resolved.ok) {
        throw Object.assign(new Error("Solo action could not be resolved."), {
          code: resolved.code || "ACTION_INVALID",
          statusCode: 400,
          validationErrors: resolved.errors,
          actionType: resolved.actionType
        });
      }

      const responseRun = resolved.run ? saveSoloRun(resolved.run) : run;

      // Quest win condition: completing the main quest ends the run in victory.
      // The flipped quest status was just persisted via saveSoloRun above.
      if (resolved.runWon) {
        completeSoloRun(responseRun.runId, "victory");
      }

      // Augment EVERY narratable action with real GM narration (bounded; the
      // mechanical template survives as a fallback). The narration is also
      // stored as the run's current scene narrative so /gm-scene reflects play.
      let attemptResult = resolved.attemptResult;
      let talkResult = resolved.talkResult;
      let searchResult = resolved.searchResult;
      let restResult = resolved.restResult;
      let useItemResult = resolved.useItemResult;

      const gmNarration = await narrateActionWithGm(responseRun, resolved, user);
      if (gmNarration) {
        const actionType = resolved.action?.type;
        if (actionType === "attempt" && attemptResult) {
          attemptResult = { ...attemptResult, narration: gmNarration, templateNarration: attemptResult.narration };
        } else if (actionType === "talk" && talkResult) {
          // The AI line becomes the NPC's spoken reply; drop the canned
          // "No new dialogue available" summary when no scripted beat fired.
          talkResult = {
            ...talkResult,
            line: gmNarration,
            templateLine: talkResult.line,
            summary: talkResult.found ? talkResult.summary : ""
          };
        } else if (actionType === "search" && searchResult) {
          searchResult = { ...searchResult, summary: gmNarration, templateSummary: searchResult.summary };
        } else if (actionType === "rest" && restResult) {
          restResult = { ...restResult, summary: gmNarration, templateSummary: restResult.summary };
        } else if (actionType === "use_item" && useItemResult) {
          useItemResult = { ...useItemResult, summary: gmNarration, templateSummary: useItemResult.summary };
        }
        updateSoloRunNarration(responseRun.runId, gmNarration);
        responseRun.narration = gmNarration;
      }

      // Lazy expression variants: a talk beat tells us which expression the NPC
      // needs — generate ONLY that one variant on demand (the worker skips it if
      // already generated), instead of eagerly producing all six on encounter.
      // "neutral" is skipped: the base portrait already is the neutral face and
      // the client falls back to it.
      if (
        resolved.action?.type === "talk" &&
        talkResult?.npcId &&
        talkResult?.expression &&
        talkResult.expression !== "neutral"
      ) {
        enqueueVariantImageJob({
          runId: responseRun.runId,
          npcId: talkResult.npcId,
          expression: talkResult.expression
        });
      }

      // Victory narration: when the main quest was just completed, one final GM
      // call writes the closing beat shown on the victory screen before the
      // summary. Best-effort — null on timeout/failure.
      let victoryNarration = null;
      if (resolved.runWon) {
        victoryNarration = await narrateVictoryWithGm(responseRun, resolved.wonQuest, user);
      }

      writeJson(res, 200, {
        ok: true,
        run: responseRun,
        action: resolved.action,
        event: resolved.event,
        memoryFact: resolved.memoryFact,
        searchResult,
        talkResult,
        restResult,
        useItemResult,
        attemptResult,
        gmNarration,
        entity: resolved.entity,
        details: resolved.details,
        availableMoves: resolved.availableMoves,
        availableActions: resolved.availableActions,
        runWon: Boolean(resolved.runWon),
        victoryNarration
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const soloNpcsRunId = parseSoloRunNpcsPath(url.pathname);
  if (soloNpcsRunId && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloNpcsRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      assertSoloRunAccess(user, run);

      const payload = await readJsonBody(req);
      // Sanitize player-supplied NPC text before it feeds identity generation /
      // GM intro directives (prompt-injection guard; clean prose is unchanged).
      const created = createSoloNpc(soloNpcsRunId, {
        name: sanitizePlayerText(payload.name, { maxLength: 80 }),
        description: sanitizePlayerText(payload.description, { maxLength: 300 }),
        introInstructions: sanitizePlayerText(payload.introInstructions, { maxLength: 300 }),
        origin: payload.origin
      });
      if (!created) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }

      // Fill any missing identity fields and bridge the NPC into the campaign
      // memory graph so the GM can see it. Awaited so the response carries the
      // fully-resolved NPC.
      await runIdentityJob({ runId: created.runId, npcId: created.npcId });
      const finalRun = getSoloRun(created.runId);
      writeJson(res, 201, {
        ok: true,
        npc: finalRun?.npcs?.[created.npcId] || null
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const portraitTarget = parseSoloRunPortraitPath(url.pathname);
  if (portraitTarget && req.method === "POST") {
    try {
      const MAX_PORTRAIT_BYTES = 10 * 1024 * 1024;
      const user = requireAuth(req);
      const run = getSoloRun(portraitTarget.runId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      assertSoloRunAccess(user, run);
      if (!run.npcs?.[portraitTarget.npcId]) {
        throw Object.assign(new Error("NPC not found."), { code: "NOT_FOUND", statusCode: 404 });
      }

      // Read with a 1MB slack over the limit for the multipart envelope, then
      // enforce the real 10MB cap on the decoded file bytes.
      const raw = await readRawBody(req, MAX_PORTRAIT_BYTES + 1024 * 1024);
      const file = parseMultipartFile(raw, req.headers["content-type"]);
      if (!file || !file.data || file.data.length === 0) {
        throw Object.assign(new Error("No image file provided."), { code: "BAD_REQUEST", statusCode: 400 });
      }
      if (file.data.length > MAX_PORTRAIT_BYTES) {
        throw Object.assign(new Error("Image exceeds the 10MB limit."), { code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
      }
      const ext = detectImageExt(file.data);
      if (!ext) {
        throw Object.assign(new Error("Unsupported image type. Use JPG, PNG, or WEBP."), { code: "UNSUPPORTED_MEDIA_TYPE", statusCode: 415 });
      }

      // Write the upload as the base portrait, mark its asset generated, and
      // link it onto the NPC.
      const { uri } = writeUploadedBasePortrait(run.runId, portraitTarget.npcId, ext, file.data);
      const linked = ensureNpcImageAssets(run.runId, portraitTarget.npcId, { style: run.flags?.artStyle });
      if (!linked) {
        throw Object.assign(new Error("NPC not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      const assetId = linked.base;
      updateImageAssetStatus(run.runId, assetId, "generated", uri);

      // Base exists from the upload — generate expression variants anchored on it.
      const freshRun = getSoloRun(run.runId);
      enqueueImageJob({
        runId: run.runId,
        npcId: portraitTarget.npcId,
        style: String(run.flags?.artStyle || "illustrated"),
        basePrompt: buildNpcBasePrompt(freshRun, portraitTarget.npcId)
      });

      writeJson(res, 201, { ok: true, assetId, uri });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const soloGmSceneRunId = parseSoloRunGmScenePath(url.pathname);
  if (soloGmSceneRunId && req.method === "GET") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloGmSceneRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      assertSoloRunAccess(user, run);
      const scene = buildSoloScenePayload(run);
      if (!scene.ok) {
        throw Object.assign(new Error("Solo scene could not be built."), {
          code: "INVALID_SOLO_SCENE",
          statusCode: 400,
          validationErrors: scene.errors
        });
      }
      const gmMode = url.searchParams.get("mode") || undefined;
      // Prefer the run's stored narrative (set by the opening + every action via
      // runGmPipeline). Falls back to the placeholder provider for legacy runs
      // that have no stored narration yet.
      let gmNarration;
      if (typeof run.narration === "string" && run.narration.trim()) {
        gmNarration = {
          ok: true,
          narration: {
            title: scene.location?.name || "Current Scene",
            body: run.narration,
            tone: "neutral",
            sensoryDetails: [],
            focusEntityIds: []
          },
          suggestedActionLabels: [],
          warnings: [],
          stateMutations: []
        };
      } else {
        gmNarration = await resolveGmNarration(scene, { mode: gmMode });
      }
      const gmStatus = buildGmRuntimeStatus(scene, gmNarration, {
        mode: gmMode
      });
      if (typeof run.narration === "string" && run.narration.trim()) gmStatus.mode = "live";
      writeJson(res, 200, {
        ok: true,
        scene,
        gmNarration,
        gmStatus,
        errors: []
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const soloSceneRunId = parseSoloRunScenePath(url.pathname);
  if (soloSceneRunId && req.method === "GET") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloSceneRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      assertSoloRunAccess(user, run);
      const scene = buildSoloScenePayload(run, {
        enqueueImages: makeSceneImageEnqueuer(run),
        enqueueIdentities: makeSceneIdentityEnqueuer(run),
        enqueuePlayerPortrait: () => enqueuePlayerImageJob({ runId: run.runId }),
        enqueueLocationImage: makeSceneLocationImageEnqueuer(run)
      });
      if (!scene.ok) {
        throw Object.assign(new Error("Solo scene could not be built."), {
          code: "INVALID_SOLO_SCENE",
          statusCode: 400,
          validationErrors: scene.errors
        });
      }
      writeJson(res, 200, scene);
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Phase 2 battle map: persist token positions (best-effort, sanitized).
  const soloMapRunId = parseSoloRunMapPath(url.pathname);
  if (soloMapRunId && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloMapRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      assertSoloRunAccess(user, run);
      const payload = await readJsonBody(req);
      const width = Number.isFinite(payload?.width) ? Math.floor(payload.width) : run.battleMap?.width || 12;
      const height = Number.isFinite(payload?.height) ? Math.floor(payload.height) : run.battleMap?.height || 10;
      const rawPositions = payload?.positions && typeof payload.positions === "object" ? payload.positions : {};
      const positions = {};
      for (const [tokenId, pos] of Object.entries(rawPositions)) {
        if (!pos || typeof pos !== "object") {
          continue;
        }
        const x = Math.floor(Number(pos.x));
        const y = Math.floor(Number(pos.y));
        if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height) {
          positions[String(tokenId)] = { x, y };
        }
      }
      // Phase 3 fog: explored cells, sanitized to in-bounds "x,y" keys.
      const rawRevealed = Array.isArray(payload?.revealed) ? payload.revealed : [];
      const revealed = [];
      const seen = new Set();
      for (const cell of rawRevealed) {
        if (typeof cell !== "string" || seen.has(cell)) {
          continue;
        }
        const [rx, ry] = cell.split(",").map((n) => Math.floor(Number(n)));
        if (Number.isFinite(rx) && Number.isFinite(ry) && rx >= 0 && ry >= 0 && rx < width && ry < height) {
          seen.add(cell);
          revealed.push(`${rx},${ry}`);
        }
      }
      const battleMap = { width, height, positions, revealed };
      updateSoloRunBattleMap(soloMapRunId, battleMap);
      writeJson(res, 200, { ok: true, battleMap });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Run conclusion: move a run out of "active" and return a player-facing
  // summary. Outcome (e.g. "died", "abandoned", "completed_quest") is recorded.
  const soloCompleteRunId = parseSoloRunCompletePath(url.pathname);
  if (soloCompleteRunId && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloCompleteRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      assertSoloRunAccess(user, run);
      const payload = await readJsonBody(req);
      const outcome = typeof payload?.outcome === "string" && payload.outcome.trim() ? payload.outcome.trim() : "completed";
      const concluded = completeSoloRun(soloCompleteRunId, outcome);
      if (!concluded) {
        throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      writeJson(res, 200, { ok: true, summary: buildRunSummary(concluded) });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const soloRunId = parseSoloRunIdFromPath(url.pathname);
  if (soloRunId && req.method === "GET") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(soloRunId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      assertSoloRunAccess(user, run);
      writeJson(res, 200, { ok: true, run });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (soloRunId && req.method === "PUT") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const run = payload.run || payload;
      if (run?.runId !== soloRunId) {
        throw Object.assign(new Error("Path runId must match body runId."), {
          code: "RUN_ID_MISMATCH",
          statusCode: 400
        });
      }
      const existing = getSoloRun(soloRunId);
      if (existing) {
        assertSoloRunAccess(user, existing);
      }
      assertSoloRunAccess(user, run);
      const saved = saveSoloRun(run);
      writeJson(res, 200, { ok: true, run: saved });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/start") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const characterName = String(payload.characterName || "").trim();
      const archetype = String(payload.archetype || "").trim();
      const backstorySnippet = String(payload.backstorySnippet || "").trim();

      if (!characterName) {
        throw Object.assign(new Error("characterName is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      const { campaignId, runId } = await createOnboardingCampaign(user.id, {
        characterName,
        archetype,
        backstorySnippet
      });

      const normalizedArchetype = archetype || "weathered wanderer";
      const normalizedBackstory =
        backstorySnippet || "They crossed too many roads to turn back now.";
      let openingPrompt =
        `The player has just arrived at The Shattered Flagon tavern in Ashenmoor. Their character is ${characterName}, a ${normalizedArchetype}. ${normalizedBackstory}. ` +
        "Narrate their arrival. Describe the tavern atmosphere. Introduce the tavern keeper naturally. End with the tavern keeper addressing the player character directly, asking them a question that invites roleplay.";

      // One-time injection of any user NPC intro directives (opening-prompt
      // pattern). Procedural NPCs carry none, so this is a no-op for them.
      const onboardingRun = getSoloRun(runId);
      const introDirective = buildNpcIntroDirective(onboardingRun);
      if (introDirective) {
        openingPrompt += `\n\n${introDirective}`;
      }

      const opening = await runGmPipeline({
        campaignId,
        message: openingPrompt,
        mode: "companion",
        playerName: characterName,
        actorUserId: user.id,
        stream: true
      });

      if (opening?.narrative) {
        pushChatLine(campaignId, "Narrator", opening.narrative, { internal: true });
        // Mark injected NPC intro directives consumed so they fire only once.
        for (const npcId of collectNpcsWithPendingIntro(onboardingRun)) {
          markNpcIntroduced(runId, npcId);
        }
      }

      broadcastAuthoritativeState(campaignId, "onboarding-start", "push_chat_line");

      writeJson(res, 200, {
        ok: true,
        campaignId,
        runId,
        firstMessage: String(opening?.narrative || "").trim()
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // World generator preview — fills blank fields, persists nothing.
  if (req.method === "POST" && url.pathname === "/api/onboarding/world") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      const world = await generateWorld(payload?.world || {});
      writeJson(res, 200, { ok: true, world });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Regenerate a single world field (per-field ⟳).
  if (req.method === "POST" && url.pathname === "/api/onboarding/world/field") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      const value = await regenerateWorldField(payload?.definition || {}, String(payload?.field || ""), {
        salt: String(payload?.salt || "")
      });
      writeJson(res, 200, { ok: true, value });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Create the run from a confirmed world + character (replaces /start flow).
  if (req.method === "POST" && url.pathname === "/api/onboarding/world-run") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const result = await createWorldOnboardingRun(user.id, {
        world: payload?.world || {},
        character: payload?.character || {},
        draftPortraitId: payload?.draftPortraitId || null
      });
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Mid-creation (draft) player portrait: generate before a run exists, keyed by
  // a hash of the character fields. Returns a draftId the client polls.
  if (req.method === "POST" && url.pathname === "/api/onboarding/portrait") {
    try {
      requireAuth(req);
      const payload = await readJsonBody(req);
      const draftId = enqueueDraftPortrait({
        character: payload?.character || {},
        world: payload?.world || {}
      });
      writeJson(res, 200, { ok: true, draftId, status: "generating" });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Poll a draft portrait: { status: "generating"|"generated"|"failed", uri }.
  if (req.method === "GET" && url.pathname.startsWith("/api/onboarding/portrait/")) {
    try {
      requireAuth(req);
      const draftId = decodeURIComponent(url.pathname.slice("/api/onboarding/portrait/".length));
      const status = getDraftPortrait(draftId);
      writeJson(res, 200, { ok: true, ...status });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/waitlist") {
    try {
      const payload = await readJsonBody(req);
      const email = String(payload?.email || "")
        .trim()
        .toLowerCase();
      if (!emailPattern.test(email)) {
        throw Object.assign(new Error("A valid email is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      const interest = normalizeWaitlistInterest(payload?.interest);
      const entries = await readWaitlistEntries();
      entries.push({
        email,
        interest,
        timestamp: new Date().toISOString()
      });
      await writeWaitlistEntries(entries);

      writeJson(res, 200, { ok: true, success: true });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/waitlist") {
    try {
      const user = requireAuth(req);
      if (!user.isAdmin) {
        throw Object.assign(new Error("Admin access required."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }

      const entries = await readWaitlistEntries();
      writeJson(res, 200, {
        ok: true,
        success: true,
        entries
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/campaign/style/presets") {
    try {
      requireAuth(req);
      writeJson(res, 200, {
        ok: true,
        presets: getPresets()
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/campaign/style/presets/apply") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      const presetName = String(payload.presetName || "").trim();
      if (!campaignId || !presetName) {
        throw Object.assign(new Error("campaignId and presetName are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      assertGmOrOwner(user, campaignId);
      const config = await applyPreset(campaignId, presetName);
      writeJson(res, 200, { ok: true, config });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/campaign/style") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      assertGmOrOwner(user, campaignId);
      const config = await getStyleConfig(campaignId);
      writeJson(res, 200, { ok: true, config });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/campaign/style") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      assertGmOrOwner(user, campaignId);

      const partialUpdate = {
        ...payload
      };
      delete partialUpdate.campaignId;
      validateStyleUpdate(partialUpdate);

      const config = await updateStyleConfig(campaignId, partialUpdate);
      writeJson(res, 200, { ok: true, config });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/campaign/style/preview") {
    try {
      const user = requireAuth(req);
      enforcePreviewRateLimit(user.id);

      const payload = await readJsonBody(req);
      const campaignId = String(payload.campaignId || "");
      const testMessage = String(payload.testMessage || "").trim();
      if (!campaignId || !testMessage) {
        throw Object.assign(new Error("campaignId and testMessage are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      assertGmOrOwner(user, campaignId);

      const config = await getStyleConfig(campaignId);
      const styleBlock = buildStylePromptBlock(config);
      const tiers = getModelTiers();
      const resolvedModel = String(config?.model?.preferredNarrativeModel || "").trim() || tiers.narrative;
      const profile = getProfile(resolvedModel);
      const runtime = getCampaignRuntimeState(campaignId, { internal: true });
      const state = getState({ userId: user.id });
      const campaign = (state.campaigns || []).find((entry) => entry.id === campaignId);

      const worldContext = await buildContextWindow(
        campaignId,
        testMessage,
        Number(process.env.NOTDND_CONTEXT_BUDGET || 1500),
        config
      );

      const activePlayersSummary = (state.characters || [])
        .filter((character) => character.campaignId === campaignId)
        .slice(0, 4)
        .map((character) => `${character.name} (${character.className} ${character.level})`)
        .join("\n");
      const currentStateSummary = `Scene: ${campaign?.activeScene || campaign?.status || "Current Scene"}, Initiative: ${
        runtime.initiativeOrder?.length
          ? runtime.initiativeOrder.map((entry) => `${entry.name}:${entry.initiative}`).join(", ")
          : "none"
      }, Active conditions: none`;

      const systemPrompt = buildSessionSystemPrompt({
        campaignName: campaign?.name || campaignId,
        currentScene: campaign?.activeScene || campaign?.status || "Current Scene",
        tone: campaign?.setting || "Cinematic",
        styleBlock,
        worldContext,
        activePlayersSummary,
        sessionHistory: "Preview mode: summarize response style only.",
        currentStateSummary,
        profile
      });

      const options = {
        temperature: profile.temperature,
        maxResponseTokens:
          config?.model?.maxTokensPerResponse !== null && config?.model?.maxTokensPerResponse !== undefined
            ? Number(config.model.maxTokensPerResponse)
            : profile.maxResponseTokens,
        stopSequences: profile.stopSequences || []
      };

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: testMessage }
      ];

      const result = resolvedModel === tiers.narrative
        ? await generateNarrative(messages, campaignId, options)
        : await generateRaw(messages, resolvedModel, campaignId, options);

      writeJson(res, 200, {
        ok: true,
        response: result.content,
        meta: {
          model: result.model,
          tokensUsed: result.tokensUsed,
          cost: result.cost
        }
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/campaigns/")) {
    try {
      const user = requireAuth(req);
      const campaignId = decodeURIComponent(url.pathname.slice("/api/campaigns/".length));
      if (!campaignId) {
        throw Object.assign(new Error("campaignId is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      applyOperation("delete_campaign", { campaignId }, { actorUserId: user.id });

      try {
        const memoryDir = process.env.NOTDND_MEMORY_ROOT
          ? path.resolve(process.env.NOTDND_MEMORY_ROOT, campaignId)
          : path.resolve(process.cwd(), "data/campaigns", campaignId);
        await fs.rm(memoryDir, { recursive: true, force: true });
      } catch {
        // Memory dir cleanup is best-effort; state has already been removed.
      }

      broadcastAuthoritativeState(campaignId, "campaign-delete", "delete_campaign");
      const state = getState({ userId: user.id });
      writeJson(res, 200, { ok: true, campaignId, state });
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
      const tiers = getModelTiers();
      writeJson(res, 200, {
        ok: true,
        providers: [
          {
            key: "openrouter",
            label: "OpenRouter Unified",
            type: "openai-chat-completions",
            status: process.env.OPENROUTER_API_KEY ? "configured" : "missing-api-key",
            models: {
              gm: tiers.narrative,
              utility: tiers.utility,
              fallback: tiers.fallback
            },
            endpoint: "https://openrouter.ai/api/v1/chat/completions",
            supports: ["gm"]
          },
          ...listAiProviders()
        ]
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ai/usage") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      assertCampaignReadAccess(campaignId, { actorUserId: user.id });
      writeJson(res, 200, {
        ok: true,
        campaignId,
        usage: getCampaignUsage(campaignId),
        modelTiers: getModelTiers()
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

  if (req.method === "POST" && url.pathname === "/api/gm/memory/rebuild") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      const role = getCampaignRole(campaignId, { actorUserId: user.id });
      const canRebuild = user.isAdmin || role === "owner" || role === "gm";
      if (!canRebuild) {
        throw Object.assign(new Error("GM or admin access required."), {
          code: "FORBIDDEN",
          statusCode: 403
        });
      }

      const rebuilt = await rebuildCampaignIndex(campaignId);
      writeJson(res, 200, { ok: true, rebuilt });
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
      assertCampaignReadAccess(campaignId, { actorUserId: user.id });
      writeJson(res, 200, {
        ok: true,
        entities: await listEntities(campaignId)
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
      assertCampaignReadAccess(campaignId, { actorUserId: user.id });
      writeJson(res, 200, {
        ok: true,
        results: await search(campaignId, query, {
          type: payload.type,
          limit: payload.limit,
          minConfidence: payload.minConfidence
        })
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
      if (!campaignId) {
        throw Object.assign(new Error("campaignId is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      assertCampaignWriteAccess(campaignId, { actorUserId: user.id });

      const entity = payload.entity
        ? payload.entity
        : {
            name: String(payload.docKey || "Untitled"),
            type: "lore",
            tags: [String(payload.docKey || "legacy")],
            body: String(payload.content || "")
          };

      const saved = await upsertEntity(campaignId, entity);
      writeJson(res, 200, { ok: true, entity: saved });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  const memoryEntityName = parseMemoryEntityFromPath(url.pathname);
  if (memoryEntityName && req.method === "GET") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      assertCampaignReadAccess(campaignId, { actorUserId: user.id });
      const entity = await getEntity(campaignId, memoryEntityName);
      if (!entity) {
        throw Object.assign(new Error("Entity not found."), {
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      writeJson(res, 200, { ok: true, entity });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (memoryEntityName && req.method === "DELETE") {
    try {
      const user = requireAuth(req);
      const campaignId = String(url.searchParams.get("campaignId") || "");
      if (!campaignId) {
        throw Object.assign(new Error("campaignId query param is required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }
      assertCampaignWriteAccess(campaignId, { actorUserId: user.id });
      const result = await archiveEntity(campaignId, memoryEntityName);
      writeJson(res, 200, { ok: true, ...result });
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
      const mode = payload.mode === "companion" ? "companion" : "session";

      if (!campaignId || !message) {
        throw Object.assign(new Error("campaignId and message are required."), {
          code: "BAD_REQUEST",
          statusCode: 400
        });
      }

      if (mode === "session") {
        assertCampaignPlayAccess(campaignId, { actorUserId: user.id });
      } else {
        assertCampaignReadAccess(campaignId, { actorUserId: user.id });
      }

      const response = await runAndPersistGmResponse({
        campaignId,
        message,
        mode,
        actorUserId: user.id,
        playerName: String(payload.playerName || user.displayName || "Player"),
        activePlayers: Array.isArray(payload.activePlayers) ? payload.activePlayers : [],
        stream: Boolean(payload.stream)
      });

      if (mode === "session") {
        wsHub.broadcastCampaign(campaignId, {
          type: "ai_response",
          campaignId,
          narrative: response.narrative,
          memoryUpdates: response.memoryUpdates,
          timestamp: Date.now()
        });
        wsHub.broadcastCampaign(campaignId, {
          type: "ai_mechanical",
          campaignId,
          mechanical: response.mechanical,
          timestamp: Date.now()
        });
      }

      broadcastAuthoritativeState(campaignId, "gm-response", "push_chat_line");

      writeJson(res, 200, {
        ok: true,
        narrative: response.narrative,
        mechanical: response.mechanical,
        memoryUpdates: response.memoryUpdates
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
      const response = await handleQuickstartBuildPayload(payload, {
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
  // Outer safety net: any unguarded throw in a route would otherwise become an
  // unhandled rejection and exit the process, taking down every player. Catch
  // it here, log with request context, and return a 500 instead of crashing.
  try {
    if ((req.url || "").startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (!handled) {
        writeText(res, 404, "Not found");
      }
      return;
    }

    serveStatic(req, res, repoRoot);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[FATAL] request handler error: ${req.method} ${req.url}:`, error);
    if (!res.headersSent) {
      // routeError(res, error) derives the status from error.statusCode; force a
      // generic 500 (no internals leaked) without changing routeError.
      routeError(res, Object.assign(new Error("Internal server error"), { statusCode: 500, code: "INTERNAL_ERROR" }));
    }
  }
});

// Last-resort crash guards: a synchronous throw or a rejected promise that
// escapes every other boundary would otherwise terminate the process and drop
// all connections. Log and keep serving — a single bad request must never take
// the whole instance down.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[FATAL] uncaughtException:", err);
  // do not exit — log and continue
});

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[FATAL] unhandledRejection:", reason);
  // do not exit — log and continue
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
const host = process.env.NOTDND_HOST || process.env.HOST || "0.0.0.0";
server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed to start Notdnd server on ${host}:${port}:`, error.message || error);
  process.exit(1);
});

server.listen(port, host, () => {
  // Startup confirmation: makes a successful bind obvious vs. a server stuck in
  // an EADDRINUSE loop (where only [DB] prints and the port never binds).
  // eslint-disable-next-line no-console
  console.log(`[SERVER] Inkborne listening on port ${port}`);
});
