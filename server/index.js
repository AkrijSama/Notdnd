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
import { appendTurnLog, logTurnEvent } from "./logging/sessionLog.js";
import { generateWithProvider, listAiProviders, pollinationsEditConfigured } from "./ai/providers.js";
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
  addUserHomebrew,
  createSoloRun,
  deleteSoloRun,
  deleteUserHomebrew,
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
  listUserHomebrew,
  confirmPasswordReset,
  loginUser,
  logoutSessionToken,
  markLocationImageRegenerating,
  markNpcIntroduced,
  registerUser,
  renameSoloRun,
  requestPasswordReset,
  resolveStorePath,
  saveSoloRun,
  setCampaignRuntimeState,
  setLocationImageLocked,
  setSoloRunSuggestions,
  setUserTier,
  updateImageAssetStatus,
  updateSoloRunBattleMap,
  updateSoloRunNarration
} from "./db/repository.js";
import {
  canGenerateImage,
  canStartSession,
  entitlementSummary,
  incrementSessionCount,
  requestHasByokKey
} from "./auth/entitlements.js";
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
import { MAX_PDF_BYTES, emptyCandidates, extractPdfText, parseSourcebookText } from "./homebrew/pdfImport.js";
import { fetchHomebrewUrl } from "./homebrew/urlImport.js";
import { validateCustomItem, normalizeContentForBuild, CUSTOM_CONTENT_TYPES } from "./homebrew/customContent.js";
import { createWsHub } from "./realtime/wsHub.js";
import { resolveSoloAction, testHooksEnabled } from "./solo/actions.js";
import { buildAttemptContext, buildAttemptProviderInput, classifyIntentAuthority } from "./solo/attempt.js";
import { interpretAttemptWithGm } from "./gm/attemptInterpreter.js";
import { classifyNarrationVn, resolveGmNarration } from "./solo/gmProvider.js";
import { buildGmRuntimeStatus } from "./solo/gmSmoke.js";
import { enqueueDraftPortrait, enqueueImageJob, enqueueLocationImageJob, enqueuePlayerImageJob, enqueueVnBodyImageJob, getDraftPortrait, writeUploadedBasePortrait } from "./solo/imageWorker.js";
import { enqueueIdentityJob, runIdentityJob } from "./solo/npcIdentity.js";
import { buildNpcIntroDirective, buildSoloScenePayload, collectNpcsWithPendingIntro } from "./solo/scene.js";
import { refreshSceneSuggestions } from "./solo/suggestions.js";

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

// Soft daily session cap. Throws a 429 (with a clear upgrade message) when a
// free user has started their allotted runs for the day and isn't supplying a
// BYOK key. Paid tiers and BYOK pass straight through. The cap keeps a heavy
// free user under the upstream LLM provider's daily request ceiling.
function enforceSessionEntitlement(req, user) {
  const gate = canStartSession(user, { byok: requestHasByokKey(req) });
  if (!gate.allowed) {
    throw Object.assign(
      new Error("You've reached your free daily session limit — upgrade to Adventurer for unlimited play."),
      { code: "SESSION_LIMIT_REACHED", statusCode: 429 }
    );
  }
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

// POST /api/solo/runs/:runId/location-image/(redo|save)
function parseSoloRunLocationImagePath(pathname) {
  const prefix = "/api/solo/runs/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const match = /^([^/]+)\/location-image\/(redo|save)$/.exec(pathname.slice(prefix.length));
  if (!match) {
    return null;
  }
  return { runId: decodeURIComponent(match[1]), op: match[2] };
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
// The LOCAL 8b's legitimate generation window (mirrors openrouter's per-attempt
// local timeout). The ROUTE-level backstop must never be SMALLER than this, or it
// would kill a slow-but-working local generation before it finishes (the literal
// "GM goes quiet" bug). So the effective action timeout is raised to sit just
// above the local window — the route stops being a pre-emptor and becomes a true
// final backstop, while openrouter's per-provider timeouts (cloud-tight,
// local-generous) do the real cloud-vs-local distinction.
const GM_LOCAL_TIMEOUT_MS = Number(process.env.NOTDND_GM_LOCAL_TIMEOUT_MS || 60000);
function effectiveActionTimeoutMs() {
  return Math.max(GM_ACTION_TIMEOUT_MS, GM_LOCAL_TIMEOUT_MS + 5000);
}

// Bounds a GM call and reports HOW it ended: { timedOut, value, error }. Unlike a
// bare value|null, this lets the caller log the previously-SILENT timeout path
// loudly (which provider, how long, that the timeout fired) instead of a silent
// "GM goes quiet".
function withGmTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ timedOut: true, value: null, error: null }), ms);
    Promise.resolve(promise).then(
      (value) => finish({ timedOut: false, value, error: null }),
      (error) => finish({ timedOut: false, value: null, error })
    );
  });
}

// NPCs at the run's current location — the candidate speakers the automatic VN
// classifier may attribute direct dialogue to (and the set it grounds against,
// so an absent NPC can never become the speaker).
function presentNpcsForVn(run) {
  const npcs = run && run.npcs && typeof run.npcs === "object" ? Object.values(run.npcs) : [];
  return npcs.filter((npc) => npc && npc.currentLocationId === run.currentLocationId && npc.status !== "gone");
}

// Generates real GM narration for any resolved solo action (move/talk/search/
// rest/use_item/attempt). Bounded by GM_ACTION_TIMEOUT_MS; returns null on
// timeout/empty so the caller keeps the mechanical template as a fallback.
// Builds the consequence/death enforcement clause appended to the action GM
// prompt. A real 5e DM lets damage, dying, and death LAND — this counters a
// helpful model's reflex to soften or rescue. Returns "" when nothing of
// consequence happened this turn.
function buildConsequenceDirective(resolved) {
  const damage = resolved?.attemptResult?.damage || resolved?.damageResult || null;
  const deathSave = resolved?.deathSave || resolved?.deathSaveResult || null;
  const died = resolved?.runDied === true || resolved?.run?.player?.status === "dead";
  const parts = [];
  // IMPOSSIBILITY / AUTHORITY GATE: the server refused this intent pre-roll. The
  // action did not and cannot succeed — reinforce that the GM narrates ONLY the
  // world refusing (the prompt builder already steers this; this is the anti-
  // softening backstop, mirroring the lethality directive).
  if (resolved?.attemptResult?.gated === true) {
    return (
      " The player tried something the world refuses to allow (impossible or not theirs to declare). " +
      "It did NOT succeed and CANNOT — reality does not bend, no item or power appears, no one is compelled. " +
      "Narrate ONLY the world quietly not complying, grounded in the fiction. Do NOT let it work even partially, " +
      "do NOT invent the thing into existence, do NOT scold or break character."
    );
  }
  if (resolved?.attemptResult?.unpossessed === true) {
    const item = typeof resolved.attemptResult.claimedItem === "string" && resolved.attemptResult.claimedItem
      ? resolved.attemptResult.claimedItem
      : "the item they claimed";
    return (
      ` The action relied on ${item}, which the player does NOT actually carry. It is not in their possession and does ` +
      "NOT appear — narrate the absence in-fiction (they reach for it and it simply is not there). Do NOT let the item " +
      "materialize, do NOT let the action succeed on its strength, do NOT scold or break character."
    );
  }
  if (died) {
    return (
      " The player has DIED — this is a real, permanent 5e death, not a faint or a near-miss. " +
      "Narrate the death honestly and with weight as a final beat. Do NOT walk it back, revive them, " +
      "or hint at a miraculous escape. The character is gone."
    );
  }
  if (deathSave && deathSave.ok) {
    if (deathSave.outcome === "nat20_revive") {
      parts.push(" Against the odds the player claws back to consciousness (a natural 20 on a death save) — narrate the gasp of return, still gravely wounded.");
    } else if (deathSave.stabilized) {
      parts.push(" The player stabilizes at death's door — unconscious but no longer slipping. Narrate the fragile reprieve, not a recovery.");
    } else {
      parts.push(` The player is dying and just made a death saving throw (${deathSave.outcome}). Narrate the bleeding-out tension; do NOT rescue them.`);
    }
  }
  if (damage && (damage.dying || damage.downed) && !died) {
    parts.push(" The blow drops the player to 0 HP — they collapse, dying. Narrate the fall with real danger; no convenient rescue.");
  } else if (damage && damage.amount > 0) {
    parts.push(` The player takes ${damage.amount} damage. Let it hurt and cost them — narrate the wound honestly.`);
  }
  // Ground the prose in the STRUCTURED consequence the server just enforced, so
  // narration and real state never diverge (the screenshot's disconnect). The GM
  // is told exactly what became true (the map IS torn, the condition IS applied).
  const consequence = resolved?.attemptResult?.consequence || null;
  if (consequence) {
    if (consequence.type === "objectState" && consequence.applied) {
      const label = typeof consequence.label === "string" && consequence.label ? consequence.label : "the object";
      parts.push(` As a result of the failure, ${label} is now ${consequence.objectState}${consequence.reason ? ` — ${consequence.reason}` : ""}. Narrate this exact damage to it; it is now in that state for good.`);
      if (consequence.retryEffect === "blocked") {
        parts.push(` It is too ${consequence.objectState} to attempt that approach again — make clear retrying it is pointless.`);
      } else if (consequence.retryEffect === "harder") {
        parts.push(` Any further attempt on it is now harder — convey that difficulty.`);
      }
    } else if (consequence.type === "condition" && consequence.applied) {
      parts.push(` The failure leaves the player ${consequence.condition}. Narrate the onset of that condition; it now afflicts them.`);
    } else if (consequence.type === "resource" && consequence.applied && consequence.resource !== "hp") {
      parts.push(` The failure costs them ${consequence.amount} ${consequence.resource}. Reflect that cost in the fiction.`);
    } else if (consequence.type === "retry_foreclosed") {
      const label = typeof consequence.label === "string" && consequence.label ? consequence.label : "it";
      parts.push(` The player is re-attempting ${label}, which is already ${consequence.objectState || "ruined"} and cannot be done this way again. Narrate the closed door — no new progress, no fresh harm.`);
    }
  }
  if (resolved?.attemptResult && resolved.attemptResult.success === false && !damage && !consequence) {
    parts.push(" The attempt FAILED. Narrate the failure and its consequence honestly — do not quietly let it succeed anyway.");
  }
  if (resolved?.questFailed) {
    parts.push(" A quest has been LOST through a failed check. Narrate that door closing; it does not reopen.");
  }
  return parts.join("");
}

// Best-effort closing beat when the player has just died — mirrors the victory
// narration, but for a permanent 5e death. Null on timeout/failure (the death
// screen still renders).
async function narrateDeathWithGm(run, resolved, user) {
  if (!run?.campaignId) {
    return null;
  }
  const cause = resolved?.deathSave?.outcome === "nat1_double_fail"
    ? "their final death save failed catastrophically"
    : (resolved?.damageResult?.instantDeath || resolved?.attemptResult?.damage?.instantDeath)
      ? "a massive, overwhelming blow"
      : "their wounds, bleeding out at 0 HP";
  const message =
    `The player has just DIED — permanently — from ${cause}. This is the final, irreversible end of the run. ` +
    `Write a short, unflinching death narration (2-3 sentences) that gives the death weight and dignity. ` +
    `Do NOT revive them, soften it, or hint at escape. The character is gone for good.`;
  const { value } = await withGmTimeout(
    runGmPipeline({
      campaignId: run.campaignId,
      message,
      mode: "companion",
      playerName: run.player?.displayName || "the wanderer",
      actorUserId: user?.id,
      edition: run.edition
    }),
    effectiveActionTimeoutMs()
  );
  const narrative = value && typeof value.narrative === "string" ? value.narrative.trim() : "";
  return narrative || null;
}

// Returns a RICH result so the per-turn transcript can record the narration
// source + provider + latency (no more silent "GM goes quiet"):
//   { narration: string|null, source, provider, model, latencyMs, timedOut }
// source ∈ no-campaign | gated-refusal | no-message | provider | template-timeout
//        | template-error | template-empty.
async function narrateActionWithGm(run, resolved, user) {
  if (!run?.campaignId || !resolved) {
    return { narration: null, source: "no-campaign" };
  }
  // GATED short-circuit: an authority-gated attempt already carries a grounded,
  // per-category, in-fiction refusal line (attemptResult.narration, set by
  // buildGatedAttempt). It cannot succeed and nothing mutated, so a live GM call
  // would only re-skin a fixed refusal at ~5-8s of model latency (worse on the
  // local model). Return null so the caller keeps the deterministic refusal —
  // gated refusals are near-instant on any provider.
  if (resolved.attemptResult?.gated === true) {
    return { narration: null, source: "gated-refusal" };
  }
  let message = buildActionGmMessage(run, resolved);
  if (!message) {
    return { narration: null, source: "no-message" };
  }
  // Quest advancement: when this action advanced a quest, fold it into the scene
  // context so the GM dramatizes the progress as a meaningful beat.
  if (resolved.questJustAdvanced) {
    const quest = resolved.questJustAdvanced;
    const title = typeof quest.title === "string" && quest.title ? quest.title : "their quest";
    const objective = typeof quest.objective === "string" && quest.objective ? ` — ${quest.objective}` : "";
    message += ` The player has just advanced "${title}"${objective}. Weave this progress naturally into the narration as a turning point, without declaring further quests.`;
  }
  // MOMENTUM (same fold-in pattern as questJustAdvanced): when the world's own
  // engine fired this turn, the event is ALREADY COMMITTED to state (an NPC in
  // the cast / an objectState / a real quest). The GM narrates its arrival and
  // poses the decision — and invents nothing beyond it.
  if (resolved.momentumEvent) {
    const ev = resolved.momentumEvent;
    message +=
      ` MEANWHILE the world moves on its own — a REAL development has just been committed to the game state: ` +
      `${ev.title}. ${ev.brief} Narrate this development arriving in the scene alongside the action's outcome — ` +
      `it is really happening — and end by putting its choice in front of the player: ${ev.decision} ` +
      `Do NOT invent any other new arrivals, changes, or events beyond this one.`;
  }
  // LETHALITY ENFORCEMENT (#12): a helpful-tuned model defaults to mercy. Counter
  // it explicitly — the GM is a real 5e DM who narrates EARNED consequences and
  // never rescues the player from them.
  message += buildConsequenceDirective(resolved);
  const ceiling = effectiveActionTimeoutMs();
  const t0 = Date.now();
  const { timedOut, value, error } = await withGmTimeout(
    runGmPipeline({
      campaignId: run.campaignId,
      message,
      mode: "companion",
      playerName: run.player?.displayName || "the wanderer",
      actorUserId: user?.id,
      edition: run.edition
    }),
    ceiling
  );
  const latencyMs = Date.now() - t0;
  // FORMERLY SILENT (#5/#6): the route-level backstop fired before the model
  // returned. Now LOUD — which run, how long, that the deterministic template is
  // standing in. (openrouter already logged the per-provider abort; this is the
  // turn-layer record.)
  if (timedOut) {
    logTurnEvent(run.runId, `GM narration BACKSTOP-TIMED-OUT after ${latencyMs}ms (ceiling ${ceiling}ms) — using deterministic template. A working LOCAL gen should fit under ${GM_LOCAL_TIMEOUT_MS}ms; exceeding the backstop means a genuinely stuck call.`);
    return { narration: null, source: "template-timeout", latencyMs, timedOut: true };
  }
  if (error) {
    logTurnEvent(run.runId, `GM narration FAILED after ${latencyMs}ms (${String(error?.message || error).slice(0, 140)}) — using deterministic template.`);
    return { narration: null, source: "template-error", latencyMs };
  }
  const narrative = value && typeof value.narrative === "string" ? value.narrative.trim() : "";
  const model = value?.meta?.model || "unknown";
  const provider = gmProviderForModel(model);
  if (!narrative) {
    logTurnEvent(run.runId, `GM returned EMPTY narration (${provider} ${model}, ${latencyMs}ms) — using deterministic template.`);
    return { narration: null, source: "template-empty", provider, model, latencyMs };
  }
  return { narration: narrative, source: "provider", provider, model, latencyMs };
}

// Classifies the answering model as cloud vs the local 8b fallback for the
// transcript. The local model is the configured forbidden/fallback model.
function gmProviderForModel(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m || m === "unknown") {
    return "unknown";
  }
  const local = String(
    (process.env.INKBORNE_FORBIDDEN_LLM_MODEL ?? process.env.NOTDND_FORBIDDEN_LLM_MODEL) || "inkborne-gm:8b"
  ).trim().toLowerCase();
  return m === local ? "local" : "cloud";
}

// Builds the human-readable per-turn transcript block: the full causal chain of a
// solo turn, with every formerly-silent fallback made explicit. Pure + defensive
// (every field optional). See server/logging/sessionLog.js.
function buildTurnTranscript(resolved, gmResult = {}, suggestionsResult) {
  const action = resolved?.action || {};
  const type = action.type || "unknown";
  const ar = resolved?.attemptResult || null;
  const lines = [];
  lines.push(`action: ${type}${type === "attempt" && ar?.intent ? ` — "${String(ar.intent).slice(0, 120)}"` : ""}${action.targetEntityId ? ` (target ${action.targetEntityId})` : ""}`);

  if (type === "attempt" && ar) {
    // Authority gate verdict.
    if (ar.gated === true) {
      lines.push(`gate: REFUSED pre-roll (category ${ar.gateCategory || "?"}) — no roll, no success, no state change`);
    } else {
      lines.push("gate: legitimate (allowed to proceed)");
    }
    // Possession check.
    if (ar.unpossessed === true) {
      lines.push("possession: REFUSED — claimed a specific item the player does not hold");
    }
    // Interpreter result vs fallback (formerly silent #11/#12).
    const warnings = Array.isArray(ar.warnings) ? ar.warnings : [];
    if (warnings.includes("ATTEMPT_PROVIDER_FALLBACK")) {
      lines.push("interpreter: FELL BACK to defaultProviderOutput (model output invalid/empty) — legacy mechanics used");
    } else if (!ar.gated && !ar.unpossessed) {
      lines.push("interpreter: model proposal used (structured)");
    }
    // Roll / DC.
    if (ar.checkResult && ar.checkResult.total != null) {
      lines.push(`roll: ${ar.checkResult.total} vs DC ${ar.checkResult.dc} -> ${ar.success ? "SUCCESS" : "FAIL"}${ar.foreclosed ? " (retry foreclosed/penalized)" : ""}`);
    } else if (ar.needsCheck === false) {
      lines.push("roll: none (no-stakes action, resolved narratively)");
    }
    // Consequence applied + state delta.
    const c = ar.consequence || null;
    if (c) {
      const detail =
        c.type === "damage" ? `${ar.damage?.amount ?? c.amount ?? "?"} HP` :
        c.type === "condition" ? c.condition :
        c.type === "objectState" ? `${c.label || c.objectState}/${c.retryEffect}` :
        c.type === "resource" ? `${c.amount} ${c.resource}` : "";
      lines.push(`consequence: ${c.type}${detail ? `(${detail})` : ""}${c.applied === false ? " [not applied]" : ""}`);
    }
    if (ar.damage && (ar.damage.dying || ar.damage.dead || ar.damage.instantDeath)) {
      lines.push(`lethality: ${ar.damage.dead || ar.damage.instantDeath ? "DEAD" : "DYING (0 HP)"}`);
    }
  } else if (type === "talk" && resolved?.talkResult) {
    lines.push(`talk: ${resolved.talkResult.found ? "scripted beat" : "freeform"} with ${resolved.talkResult.speakerName || resolved.talkResult.npcId || "NPC"}`);
  }

  if (resolved?.questFailed) {
    // Check-gated failable stage missed -> quest LOST in tracked state. Logged
    // loudly so the fail->lose consequence is provable in the transcript, not just
    // narrated (closes the last "doctrine not provable in content" gap).
    lines.push(`quest: FAILED — "${resolved.questFailed.title || resolved.questFailed.questId}" lost on a missed check (status -> failed, irrecoverable)`);
  }
  if (resolved?.questJustAdvanced) {
    lines.push(`quest: advanced "${resolved.questJustAdvanced.title || "main"}"`);
  }
  if (resolved?.momentumEvent) {
    const ev = resolved.momentumEvent;
    const committed = [
      ev.committed?.npcId ? `npc:${ev.committed.npcId}` : null,
      ev.committed?.questId ? `quest:${ev.committed.questId}` : null,
      ev.committed?.objectStateKey ? `objectState:${ev.committed.objectStateKey}` : null
    ].filter(Boolean).join(" + ");
    lines.push(`momentum: EVENT "${ev.title}" (${ev.kind}) fired — committed ${committed || "nothing?!"}`);
  }
  if (resolved?.runWon) {
    lines.push("run: WON (main quest complete)");
  }

  // Provider + latency + narration source (formerly silent #5/#6).
  const g = gmResult || {};
  if (g.source === "provider") {
    lines.push(`narration: ${g.provider || "?"} (${g.model || "?"}) in ${g.latencyMs ?? "?"}ms — provider prose`);
  } else if (g.source === "template-timeout") {
    lines.push(`narration: TIMEOUT after ${g.latencyMs ?? "?"}ms — deterministic template (GM went quiet; see backstop log above)`);
  } else if (g.source === "template-error") {
    lines.push(`narration: ERROR after ${g.latencyMs ?? "?"}ms — deterministic template`);
  } else if (g.source === "template-empty") {
    lines.push(`narration: EMPTY from ${g.provider || "?"} (${g.model || "?"}, ${g.latencyMs ?? "?"}ms) — deterministic template`);
  } else if (g.source === "gated-refusal") {
    lines.push("narration: skipped (gated refusal keeps its deterministic in-fiction line) — near-instant");
  } else {
    lines.push(`narration: template (${g.source || "no GM call"})`);
  }

  const sugCount = Array.isArray(suggestionsResult)
    ? suggestionsResult.length
    : Array.isArray(suggestionsResult?.suggestions) ? suggestionsResult.suggestions.length : null;
  lines.push(`suggestions: ${sugCount != null ? `${sugCount} generated` : "refreshed"}`);
  return lines;
}

// LIVE attempt interpreter wiring. On a real freeform attempt we ask the GM to
// adjudicate the mechanics — recommended ability, DC, needsCheck, and the
// structured failureConsequence — BEFORE resolveSoloAction rolls the check, then
// hand the result to the engine as a (synchronous) attemptProviderFn. This is
// what lights up the structured failure-consequence engine in live play: without
// it the engine uses defaultProviderOutput, which proposes no consequence, so
// every real failure decays to the legacy flat HP cost.
//
// Returns options to spread into resolveSoloAction:
//   - { attemptProviderFn } when the live interpreter produced a usable proposal
//   - {} otherwise — the engine then uses its own sane default (so an interpreter
//     miss never blocks or crashes the turn). The engine ALSO re-validates and
//     sanitizes whatever we pass (validateAttemptProviderOutput →
//     defaultProviderOutput fallback on junk), so this is graceful end-to-end.
//
// Skipped for non-attempt actions and for the gated test-hook path (the self-play
// harness supplies its own deterministic providerOutput via action.testHook).
//
// SEAM (Opus 2, pre-roll impossibility gate "G"): an impossibility classification
// belongs immediately before this — if an action is impossible, short-circuit and
// return the refusal before we interpret or roll. The two compose cleanly.
async function buildLiveAttemptOptions(run, action, user) {
  if (!action || action.type !== "attempt") {
    return {};
  }
  // The test-hook providerOutput (selfplay) overrides any live provider anyway;
  // skip the model call entirely when it's present so the harness stays hermetic.
  if (testHooksEnabled() && action.testHook && typeof action.testHook === "object" && action.testHook.providerOutput) {
    return {};
  }
  if (!run?.campaignId) {
    return {};
  }
  // GATE BEFORE INTERPRET (the seam, now realized). The authority gate is a pure,
  // deterministic, server-owned classifier — run it FIRST. An impossible intent
  // ("I declare myself god-king", "I draw my legendary sword I've always owned")
  // is refused pre-roll inside resolveSoloAction regardless; calling the
  // interpreter for it only burns full model latency (≈15s on the local fallback)
  // before the inevitable refusal, which under sustained load blew past the
  // harness fetch timeout → flaky G1/G2. Skipping the interpreter here makes the
  // refusal FAST and pays no model cost. The verdict is recomputed identically
  // inside resolveAttemptAction (single source of truth), so the refusal itself
  // is never skipped — only the wasted interpretation is. Legitimate intents fall
  // through to interpret → possession-check → roll → failure-consequence as before.
  if (typeof action.intent === "string" && action.intent.trim() && classifyIntentAuthority(action.intent).verdict === "impossible") {
    return {};
  }
  try {
    const context = buildAttemptContext(run, action);
    if (!context || context.ok !== true) {
      return {};
    }
    const providerInput = buildAttemptProviderInput(context);
    if (!providerInput || providerInput.ok !== true) {
      return {};
    }
    const structured = await interpretAttemptWithGm({
      providerInput,
      campaignId: run.campaignId,
      edition: run.edition,
      actorUserId: user?.id
    });
    if (!structured || typeof structured !== "object") {
      return {};
    }
    // Synchronous closure: the engine calls providerFn() inline (it does not
    // await), so the model output must already be resolved here. The engine
    // validates/sanitizes `structured` and falls back to defaultProviderOutput if
    // it's invalid — so we can hand it the raw parsed object safely.
    return { attemptProviderFn: () => structured };
  } catch {
    // Never let interpreter wiring break a turn — fall back to the engine default.
    return {};
  }
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
  const { value } = await withGmTimeout(
    runGmPipeline({
      campaignId: run.campaignId,
      message,
      mode: "companion",
      playerName: run.player?.displayName || "the wanderer",
      actorUserId: user?.id,
      edition: run.edition
    }),
    effectiveActionTimeoutMs()
  );
  const narrative = value && typeof value.narrative === "string" ? value.narrative.trim() : "";
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

  // Admin: manually set a user's subscription tier. Beta-only stopgap until a
  // payment processor is wired — gated by a server-side shared secret
  // (INKBORNE_ADMIN_KEY) sent in the x-inkborne-admin-key header, NOT user auth,
  // so it can be driven by an operator script without an admin login. Returns 404
  // when the key is unset (route effectively disabled) to avoid advertising it.
  if (req.method === "POST" && url.pathname === "/api/admin/set-tier") {
    try {
      const adminKey = String(process.env.INKBORNE_ADMIN_KEY || "").trim();
      if (!adminKey) {
        throw Object.assign(new Error("Not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      const provided = String(req.headers["x-inkborne-admin-key"] || "").trim();
      if (!provided || provided !== adminKey) {
        throw Object.assign(new Error("Admin key required."), { code: "FORBIDDEN", statusCode: 403 });
      }
      const payload = await readJsonBody(req);
      const userId = String(payload?.userId || "").trim();
      const tier = String(payload?.tier || "").trim();
      if (!userId) {
        throw Object.assign(new Error("userId is required."), { code: "BAD_REQUEST", statusCode: 400 });
      }
      const updated = setUserTier(userId, tier);
      writeJson(res, 200, { ok: true, user: updated });
    } catch (error) {
      routeError(res, error);
    }
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
      enforceSessionEntitlement(req, user);
      const payload = await readJsonBody(req);
      const run = createSoloRun({
        userId: user.id,
        runId: payload.runId,
        worldSeed: payload.worldSeed
      });
      incrementSessionCount(user.id);
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

  // Delete a solo run (DELETE /api/solo/runs/:runId). Lets players prune
  // abandoned/finished adventures from the home screen. Auth + ownership gated;
  // matches only the bare run path (sub-resources like /:runId/npcs have their
  // own handlers). DB record only — disk image assets are left as harmless
  // orphans rather than risking a path-based recursive delete.
  if (req.method === "DELETE" && url.pathname.startsWith("/api/solo/runs/")) {
    const raw = url.pathname.slice("/api/solo/runs/".length).replace(/\/+$/, "").trim();
    if (raw && !raw.includes("/")) {
      try {
        const user = requireAuth(req);
        const run = getSoloRun(decodeURIComponent(raw));
        if (!run) {
          throw Object.assign(new Error("Solo run not found."), {
            code: "NOT_FOUND",
            statusCode: 404
          });
        }
        assertSoloRunAccess(user, run);
        deleteSoloRun(run.runId);
        writeJson(res, 200, { ok: true, deleted: true });
      } catch (error) {
        routeError(res, error);
      }
      return true;
    }
  }

  // Rename a solo run (POST /api/solo/runs/:runId/rename {title}). Persists a
  // player-chosen display title on the run blob for the saved-campaigns list. A
  // blank title clears it (reverts to the computed default). Auth + ownership
  // gated; sits before the generic action handler (which matches /actions only).
  if (req.method === "POST" && url.pathname.startsWith("/api/solo/runs/") && url.pathname.endsWith("/rename")) {
    const raw = url.pathname.slice("/api/solo/runs/".length, -"/rename".length).replace(/\/+$/, "").trim();
    if (raw && !raw.includes("/")) {
      try {
        const user = requireAuth(req);
        const run = getSoloRun(decodeURIComponent(raw));
        if (!run) {
          throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
        }
        assertSoloRunAccess(user, run);
        const payload = await readJsonBody(req);
        const updated = renameSoloRun(run.runId, payload?.title);
        writeJson(res, 200, { ok: true, run: updated });
      } catch (error) {
        routeError(res, error);
      }
      return true;
    }
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
      // LIVE attempt interpreter: for a real freeform attempt, adjudicate the
      // mechanics (incl. structured failureConsequence) via the GM first, then
      // pass it into the engine so per-case consequences + retry-foreclosure
      // actually fire in live play. No-op for non-attempt / test-hook actions.
      const attemptOptions = await buildLiveAttemptOptions(run, action, user);
      const resolved = resolveSoloAction(run, action, attemptOptions);
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

      // Generate the next scene's suggested actions in parallel with the GM
      // narration (overlapping its latency), so they're cached and ready by the
      // time the client reloads the scene — no extra wait, no blank suggestions.
      const [gmResult, suggestionsResult] = await Promise.all([
        narrateActionWithGm(responseRun, resolved, user),
        refreshSceneSuggestions(responseRun, setSoloRunSuggestions)
      ]);
      const gmNarration = gmResult?.narration || null;
      // PER-TURN SESSION TRANSCRIPT (data/logs/runs/<runId>.log) — the full causal
      // chain of this turn, including every formerly-silent fallback, so the owner
      // can tail it during a detached playtest and see exactly what happened.
      try {
        appendTurnLog(responseRun.runId, buildTurnTranscript(resolved, gmResult, suggestionsResult));
      } catch {
        // transcript must never break a turn
      }
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

        // Automatic ambient->direct VN trigger. The manual talk path already set
        // run.vn for talk actions (at resolveSoloAction time), so only classify
        // when vn is not already active: when a non-talk action's narration has
        // shifted into direct, sustained dialogue with a single present NPC,
        // promote the scene to VN mode. Conservative + grounded against present
        // NPCs (see classifyNarrationVn), so the manual signal is never falsely
        // overridden and an absent speaker never triggers VN. Persisted with a
        // synchronous read-modify-write (no await between getSoloRun and
        // saveSoloRun), so no async image-worker write can interleave with a
        // stale full-run snapshot. Graceful: no narration / no signal -> ambient.
        if (!(responseRun.vn && responseRun.vn.active)) {
          const autoVn = classifyNarrationVn(gmNarration, presentNpcsForVn(responseRun));
          if (autoVn.active) {
            const fresh = getSoloRun(responseRun.runId);
            if (fresh) {
              fresh.vn = autoVn;
              saveSoloRun(fresh);
              responseRun.vn = autoVn;
            }
          }
        }
      }

      // Expression-variant generation removed: every NPC now reuses its single
      // cached BASE portrait for all expressions (one image per character, stable
      // recognizable face within a run). The client falls back to the base when no
      // variant URI exists, so no per-expression generation is requested here.

      // Victory narration: when the main quest was just completed, one final GM
      // call writes the closing beat shown on the victory screen before the
      // summary. Best-effort — null on timeout/failure.
      let victoryNarration = null;
      if (resolved.runWon) {
        victoryNarration = await narrateVictoryWithGm(responseRun, resolved.wonQuest, user);
      }

      // Permanent death: the run is already persisted with run.status='dead' (set
      // by the lethality core), so the resume UI marks it non-resumable (#14). Add
      // a best-effort closing death beat, mirroring the victory narration.
      let deathNarration = null;
      if (resolved.runDied || responseRun?.player?.status === "dead") {
        deathNarration = await narrateDeathWithGm(responseRun, resolved, user);
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
        // Committed-mechanic surfaces (delivery loop + momentum). These existed on
        // the resolver result but were dropped by this whitelist — so the client
        // (and the anti-void harness) could not see a committed take/accept/reward/
        // event on the wire even though state had moved. Every one of these is
        // backed by committed state, never prose.
        takeResult: resolved.takeResult || null,
        questAccepted: resolved.questAccepted || null,
        questReward: resolved.questReward || null,
        questJustAdvanced: resolved.questJustAdvanced || null,
        questFailed: resolved.questFailed || null,
        momentumEvent: resolved.momentumEvent || null,
        runWon: Boolean(resolved.runWon),
        victoryNarration,
        // Lethality surfaces for the client's HP/death-save/death-screen flow.
        deathSave: resolved.deathSave || resolved.deathSaveResult || null,
        damage: attemptResult?.damage || resolved.damageResult || null,
        reviveResult: resolved.reviveResult || (useItemResult?.revived ? { ok: true } : null),
        runDied: Boolean(resolved.runDied || responseRun?.player?.status === "dead"),
        deathNarration
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
      // Entitlement gate: a free user past their daily image quota (and without a
      // BYOK key) stops triggering new image generation — the scene still renders
      // fully, just with placeholder art until the cap resets. Degrades softly; it
      // never blocks the scene. Identity/suggestions are text, so they stay open.
      const byok = requestHasByokKey(req);
      const allowImages = canGenerateImage(user, { byok }).allowed;
      const scene = buildSoloScenePayload(run, {
        enqueueImages: allowImages ? makeSceneImageEnqueuer(run) : undefined,
        enqueueIdentities: makeSceneIdentityEnqueuer(run),
        enqueuePlayerPortrait: allowImages ? () => enqueuePlayerImageJob({ runId: run.runId }) : undefined,
        enqueueLocationImage: allowImages ? makeSceneLocationImageEnqueuer(run) : undefined,
        // Lazily (re)generate this scene's suggested actions when stale — covers
        // the opening scene and any scene whose cache hasn't been filled yet.
        // Guarded + fire-and-forget; never blocks scene delivery.
        enqueueSuggestions: () => {
          void refreshSceneSuggestions(run, setSoloRunSuggestions);
        }
      });
      if (!scene.ok) {
        throw Object.assign(new Error("Solo scene could not be built."), {
          code: "INVALID_SOLO_SCENE",
          statusCode: 400,
          validationErrors: scene.errors
        });
      }
      // Lazy full-body VN sprite: only when an NPC is in VN (direct) mode. The
      // worker skips an already-generated vnBody, so this is cheap to re-enqueue
      // on every scene load and never fires for NPCs who never enter VN.
      if (allowImages && scene.vnMode && typeof scene.speakerId === "string" && scene.speakerId) {
        const vnNpcId = scene.speakerId.includes(":")
          ? scene.speakerId.split(":").slice(1).join(":")
          : scene.speakerId;
        enqueueVnBodyImageJob({ runId: run.runId, npcId: vnNpcId, style: run?.flags?.artStyle });
      }
      // Surface tier + remaining image quota so the client can show a soft,
      // non-blocking upgrade prompt as a free user approaches their limit.
      scene.entitlement = entitlementSummary(user, { byok });
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

  // Location background image controls: Redo (regenerate with a fresh seed,
  // refused if locked) and Save (lock the current image to this location).
  const locationImageTarget = parseSoloRunLocationImagePath(url.pathname);
  if (locationImageTarget && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const run = getSoloRun(locationImageTarget.runId);
      if (!run) {
        throw Object.assign(new Error("Solo run not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      assertSoloRunAccess(user, run);
      const locationId = run.currentLocationId;
      if (!locationId || !run.locations?.[locationId]) {
        throw Object.assign(new Error("No current location for this run."), { code: "BAD_REQUEST", statusCode: 400 });
      }

      if (locationImageTarget.op === "save") {
        const saved = setLocationImageLocked(run.runId, locationId, true);
        if (!saved) {
          throw Object.assign(new Error("No location image to save yet."), { code: "NOT_FOUND", statusCode: 404 });
        }
        writeJson(res, 200, { ok: true, locked: true });
        return true;
      }

      // redo
      const marked = markLocationImageRegenerating(run.runId, locationId);
      if (marked && marked.locked) {
        throw Object.assign(new Error("This location image is locked and cannot be redone."), {
          code: "CONFLICT",
          statusCode: 409
        });
      }
      const style = String(run?.flags?.artStyle || "illustrated");
      // Fresh seed -> a genuinely different image, and doubles as the cache-buster.
      const seed = Math.floor(Math.random() * 1_000_000_000) + 1;
      enqueueLocationImageJob({
        runId: run.runId,
        locationId,
        style,
        basePrompt: buildLocationBasePrompt(run, locationId),
        seed
      });
      writeJson(res, 200, { ok: true, status: "generating" });
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
      enforceSessionEntitlement(req, user);
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
      incrementSessionCount(user.id);

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
      enforceSessionEntitlement(req, user);
      const payload = await readJsonBody(req);
      const result = await createWorldOnboardingRun(user.id, {
        world: payload?.world || {},
        character: payload?.character || {},
        draftPortraitId: payload?.draftPortraitId || null,
        // C.13: the solo "new adventure" IS the sandbox flow (see onboardingFlow.js
        // — the loctype picker was removed because sandbox defaults to forest-ruins;
        // modules/campaigns carry their own start). Default to sandbox so a pure
        // open world with ZERO authored objective is what real play creates (owner
        // decision a), and the sandbox-gated behavior (C.5 quarry suppression,
        // player-authored goals) is actually REACHABLE live instead of inert. A
        // module/campaign start passes an explicit mode to opt back into the spine.
        mode: payload?.mode || "sandbox"
      });
      incrementSessionCount(user.id);
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
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const byok = requestHasByokKey(req);
      // Draft portraits cost a generation; gate the same as in-run art. A
      // quota-exhausted free user (no BYOK) gets a soft "quota_reached" status
      // instead of art — character creation still proceeds without a portrait.
      // entitlement rides every response so the creator can show "N edits left".
      if (!canGenerateImage(user, { byok }).allowed) {
        writeJson(res, 200, { ok: true, draftId: null, status: "quota_reached", entitlement: entitlementSummary(user, { byok }) });
        return true;
      }
      const draftId = enqueueDraftPortrait({
        character: payload?.character || {},
        world: payload?.world || {},
        nonce: payload?.nonce
      });
      writeJson(res, 200, { ok: true, draftId, status: "generating", entitlement: entitlementSummary(user, { byok }) });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Conversational portrait editor: apply ONE tweak ("scar over left eye", "make
  // the coat oxblood red") to the CURRENT portrait, keeping the same character.
  // Same entitlement gate as generation (each edit is a paid image). Returns a new
  // draftId the client polls — kontext-first edit when a funded key exists, else a
  // regenerate with the tweak folded into the prompt (graceful degradation).
  if (req.method === "POST" && url.pathname === "/api/onboarding/portrait/edit") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const byok = requestHasByokKey(req);
      if (!canGenerateImage(user, { byok }).allowed) {
        writeJson(res, 200, { ok: true, draftId: null, status: "quota_reached", entitlement: entitlementSummary(user, { byok }) });
        return true;
      }
      const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
      if (!instruction) {
        writeJson(res, 400, { ok: false, error: "An edit instruction is required." });
        return true;
      }
      const draftId = enqueueDraftPortrait({
        character: payload?.character || {},
        world: payload?.world || {},
        nonce: payload?.nonce,
        editInstruction: instruction,
        sourceImageUrl: typeof payload?.sourceImageUrl === "string" ? payload.sourceImageUrl : ""
      });
      writeJson(res, 200, {
        ok: true,
        draftId,
        status: "generating",
        consistentEdit: pollinationsEditConfigured(),
        entitlement: entitlementSummary(user, { byok })
      });
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

  // Custom homebrew content (manually authored): list / create / delete, per user.
  if (url.pathname === "/api/homebrew/custom" && req.method === "GET") {
    try {
      const user = requireAuth(req);
      const items = listUserHomebrew(user.id);
      // buildContent = the SRD-shaped catalogs the character creator + build use.
      writeJson(res, 200, { ok: true, items, buildContent: normalizeContentForBuild(items), types: CUSTOM_CONTENT_TYPES });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname === "/api/homebrew/custom" && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const { ok, errors, item } = validateCustomItem(payload?.item || payload || {});
      if (!ok) {
        throw Object.assign(new Error(`Invalid custom content: ${errors.join(" ")}`), {
          code: "INVALID_HOMEBREW",
          statusCode: 400,
          validationErrors: errors
        });
      }
      const stored = addUserHomebrew(user.id, item);
      writeJson(res, 200, { ok: true, item: stored });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname.startsWith("/api/homebrew/custom/") && req.method === "DELETE") {
    try {
      const user = requireAuth(req);
      const id = decodeURIComponent(url.pathname.slice("/api/homebrew/custom/".length)).replace(/\/+$/, "");
      const removed = deleteUserHomebrew(user.id, id);
      if (!removed) {
        throw Object.assign(new Error("Custom content item not found."), { code: "NOT_FOUND", statusCode: 404 });
      }
      writeJson(res, 200, { ok: true, removed: true });
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

  // PDF sourcebook import: extract text from an uploaded PDF (or accept pasted
  // text), then use the utility LLM to STRUCTURE named character options into
  // review candidates. Never auto-saves — parsing is imperfect, so the client
  // shows candidates for the user to edit/confirm before saving as custom
  // content. Returns ok:false + a friendly reason (not an error) when a book
  // can't be extracted/parsed, so the UI can fall back to paste / manual entry.
  if (req.method === "POST" && url.pathname === "/api/homebrew/import-pdf") {
    try {
      requireAuth(req);
      const contentType = String(req.headers["content-type"] || "");
      let text = "";
      let source = "pasted text";

      if (contentType.toLowerCase().includes("multipart/form-data")) {
        const raw = await readRawBody(req, MAX_PDF_BYTES + 1024 * 1024);
        const file = parseMultipartFile(raw, contentType);
        if (!file || !file.data || file.data.length === 0) {
          throw Object.assign(new Error("No PDF file provided."), { code: "BAD_REQUEST", statusCode: 400 });
        }
        if (file.data.length > MAX_PDF_BYTES) {
          throw Object.assign(new Error("PDF exceeds the size limit."), { code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
        }
        const extracted = await extractPdfText(file.data);
        if (!extracted.ok) {
          // Graceful: a scanned/encrypted/unreadable PDF is not a server error.
          writeJson(res, 200, { ok: false, reason: extracted.reason, candidates: emptyCandidates(), count: 0 });
          return true;
        }
        text = extracted.text;
        source = file.filename || "uploaded.pdf";
      } else {
        const payload = await readJsonBody(req);
        text = String(payload?.text || "");
        if (Buffer.byteLength(text, "utf8") > MAX_PDF_BYTES) {
          throw Object.assign(new Error("Pasted text exceeds the size limit."), { code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
        }
      }

      const result = await parseSourcebookText(text, { campaignId: "homebrew" });
      writeJson(res, 200, {
        ok: result.ok,
        source,
        candidates: result.candidates,
        count: result.count || 0,
        reason: result.reason || null
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
