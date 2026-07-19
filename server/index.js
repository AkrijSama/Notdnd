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
import { generateNarrative, generateRaw, getCampaignUsage, getModelTiers, gmKeyState, localFallbackEnabled, resolveCloudChain, resolveGmModel, runWithBatteryContext, verifyGmKey } from "./ai/openrouter.js";

// GM key preflight (audit 5d548ac #1): the boot check caches the last verification so
// /api/debug/status can surface a red row and the client can raise a banner. Initialized
// synchronously from env, refined by the one models-list ping in the listen callback.
let gmKeyPreflight = gmKeyState();
import { getBuildInfo, initBuildInfo, getGmServe, getImageServe, debugPanelDefault } from "./runtimeStatus.js";
import { appendTurnLog, logTurnEvent } from "./logging/sessionLog.js";
import { startTurnTiming, getLastTurnTiming, getRecentTurnTimings } from "./logging/turnTiming.js";
import { generateWithProvider, listAiProviders, pollinationsEditConfigured, resolveImageProvider } from "./ai/providers.js";
import { detectImageExt, parseMultipartFile, readJsonBody, readRawBody, serveStatic, writeJson, writeText } from "./api/http.js";
import { handleQuickstartBuildPayload, handleQuickstartParsePayload } from "./api/quickstartRoutes.js";
import { createLemonSqueezyWebhookHandler } from "./api/lemonsqueezy.js";
import { tokenFromRequest } from "./auth/httpAuth.js";
import { createOnboardingCampaign, createWorldOnboardingRun } from "./campaign/onboarding.js";
import { serviceDraft, serviceTwist, serviceSaveWorld, listWorldsForSelect, serviceDeleteWorld } from "./campaign/worldCreationService.js";
import { generateWorld, regenerateWorldField } from "./solo/worldGen.js";
import { engineStyleForRun } from "./solo/artStyle.js";
import { resolveLibraryArt } from "./solo/artLibrary.js";
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
  createGuestUser,
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
  upgradeGuestUser,
  findUserByEmail,
  updateImageAssetStatus,
  updateSoloRunBattleMap,
  updateSoloRunNarration
} from "./db/repository.js";
import {
  canGenerateImage,
  canStartSession,
  canTakeGmTurn,
  entitlementSummary,
  incrementSessionCount,
  incrementTurnCount,
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
import { stripAiTells } from "./gm/voice.js";
import { getProfile } from "./gm/promptProfiles.js";
import { applyPreset, getPresets } from "./gm/stylePresets.js";
import { buildStylePromptBlock, getStyleConfig, updateStyleConfig, validateStyleUpdate } from "./gm/styleConfig.js";
import { parseHomebrewDocuments } from "./homebrew/parser.js";
import { MAX_PDF_BYTES, emptyCandidates, extractPdfText, parseSourcebookText } from "./homebrew/pdfImport.js";
import { fetchHomebrewUrl } from "./homebrew/urlImport.js";
import { validateCustomItem, normalizeContentForBuild, CUSTOM_CONTENT_TYPES } from "./homebrew/customContent.js";
import { createWsHub } from "./realtime/wsHub.js";
import { resolveSoloAction, testHooksEnabled } from "./solo/actions.js";
import { limiterFromEnv, rateKeyFor, emitRateLimited } from "./security/rateLimit.js";
import { buildAttemptContext, buildAttemptProviderInput, classifyIntentAuthority, isObservationQuery, isSafeConversation, isCompoundIntent } from "./solo/attempt.js";
import { interpretAttemptWithGm } from "./gm/attemptInterpreter.js";
import { attributeSceneDialogue, resolveGmNarration } from "./solo/gmProvider.js";
import { buildGmRuntimeStatus } from "./solo/gmSmoke.js";
import { enqueueDraftPortrait, enqueueImageJob, enqueueLocationImageJob, enqueuePlayerImageJob, enqueueVnBodyImageJob, enqueueEnemyBodyImageJob, getDraftPortrait, imageWorkerStatus, locationCanonFragment, parseIdentityEdit, pronounsToGender, writeUploadedBasePortrait } from "./solo/imageWorker.js";
import { recordRequest, shouldLogRequest, lastAuthEvents } from "./logging/requestLog.js";
import { enqueueIdentityJob, runIdentityJob, backfillNpcMannerisms, buildVoiceDirective } from "./solo/npcIdentity.js";
import { buildDisagreementDirective, detectComplianceViolations } from "./gm/disagreementAudit.js";
import { captureDeclaredGoal, honorGoalsOnAttempt, buildGoalsDirective, detectGoalIgnored } from "./solo/goals.js";
import { registerGoalThread, detectDemonstratedGoal, armDemonstratedAsk, detectDemonstratedAnswer, captureDemonstratedGoal, clearDemonstratedPrompt, detectGoalAcceptIntent, captureOfferedGoal, buildDemonstratedAskDirective } from "./solo/goalDoors.js";
import { detectStarterZoneLostMotif } from "./solo/starterZone.js";
import { detectFabricatedCombatNumbers, scrubFabricatedCombatNumbers } from "./solo/combatAudit.js";
import { detectGeometryContradiction } from "./solo/geometryAudit.js";
import { buildLayoutDirective, ensureLocationLayout } from "./solo/layout.js";
import { enforceRomanceRegister, stripRomanceRegister, ROMANCE_CORRECTIVE_CLAUSE } from "./gm/romanceEnforcement.js";
import { buildNpcIntroDirective, buildSoloScenePayload, collectNpcsWithPendingIntro } from "./solo/scene.js";
import { buildSystemLoreClause, detectSystemLoreViolations } from "./gm/systemLore.js";
import { buildEssenceTraceDirective, auditNarratedEssenceTraces } from "./solo/essence.js";
import { detectDeadlineViolations } from "./gm/deadlineAudit.js";
import { individualReputation, factionReputation, detectRomanceRegisterViolations } from "./solo/reputation.js";
import { detectSpitViolations, stripSpitGestures, detectRepeatedGestures } from "./gm/mannerismAudit.js";
import { buildOocSystemPrompt } from "./gm/oocGrounding.js";
import { recordGmGeneration } from "./logging/gmTranscript.js";
import { enforceHandles, HANDLES_CORRECTIVE_CLAUSE } from "./gm/handlesEnforcement.js";
import { auditAndCommitNarratedNpcs, auditAndCommitNarratedLore, auditAndCommitInventedAgents, auditAndCommitFoundObjects, backfillNpcGenderFromNarration, repairNarrationPronouns } from "./solo/npcCommit.js";
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

// Harness-origin stamp at account creation (user-data hygiene 2026-07-18): a
// request tagged as battery/harness traffic — the x-notdnd-battery header
// (selfplay driving a live server) OR the NOTDND_BATTERY env (harness-spawned
// server) — mints accounts stamped origin:"harness" so counts/queries can exclude
// debris from day one. A real player request → null.
function originForRequest(req) {
  if (req && req.headers && req.headers["x-notdnd-battery"]) {
    return "harness";
  }
  const v = String((process.env.NOTDND_BATTERY ?? process.env.INKBORNE_BATTERY) || "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" ? "harness" : null;
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
  const style = engineStyleForRun(run);
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
  // CANON: the committed location description carries the real setting/era; without
  // it a poetic name alone lets the model invent off-canon content (the biplane).
  const canon = locationCanonFragment(location);
  const subject = canon ? `${name}, ${canon}` : name;
  return `${subject}, ${tone}, atmospheric, wide establishing shot, no people`;
}

// Returns a fire-and-forget enqueuer for the current location's background
// image. Generated once per location; never blocks the scene response.
function makeSceneLocationImageEnqueuer(run) {
  const style = engineStyleForRun(run);
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

// WORLD CLOCK ENFORCEMENT (#14). The server owns a real minutes clock; every
// action commits a duration and re-derives the time-of-day phase (worldClock.js).
// The narration model, left unprompted, drifts — narrating "dusk"/"nightfall"/
// moonlight while the committed clock still reads 07:xx (3/5 grading sessions).
// This hands the GM the COMMITTED time-of-day as a hard constraint so the fiction
// follows the clock instead of inventing its own. Reads the stamped clock/phase
// off the updated run (present after ensureClock/advanceClock, and on every
// reroute turn too), falling back to the attempt's committed timeAdvance. Empty
// string when no clock is available (legacy run) so the message is unchanged.
const CLOCK_PHASE_DESC = {
  dawn: "early dawn — thin grey first light, the sun not yet risen",
  day: "broad daylight — the sun is up",
  dusk: "dusk — failing light, the sun low or just set",
  night: "night — full dark"
};
function buildClockDirective(resolved) {
  const time = resolved?.run?.world?.time || null;
  const after = resolved?.attemptResult?.timeAdvance?.after || null;
  const clock = (time && typeof time.clock === "string" && time.clock) || (after && typeof after.clock === "string" && after.clock) || null;
  const phase = (time && typeof time.phase === "string" && time.phase) || (after && typeof after.phase === "string" && after.phase) || null;
  if (!clock || !phase) {
    return "";
  }
  const desc = CLOCK_PHASE_DESC[phase] || phase;
  return (
    ` COMMITTED TIME: it is ${clock} — ${desc}. This is the server-owned truth. Your narration MUST be consistent ` +
    `with this time of day — describe light, sky, shadow, and lamps to match ${phase}. Do NOT narrate a different ` +
    `time than the clock: no moonlight, stars, nightfall, torches-for-darkness, or "the hour grew late" while it is ` +
    `dawn or day; no daylight, noon sun, or morning light while it is dusk or night. The fiction follows the clock.`
  );
}

// D.5 item 4 — the STANDING THREADS directive. The server owns thread state; the
// narrator may DESCRIBE and FORESHADOW an active thread but never invent, advance,
// or resolve one (that is the tick's job). Reveal-gated so the prompt can only
// carry what the player has earned: a REVEALED thread rides with its agenda in
// full; a RUMORED (suspected) thread rides as title-only tension; HIDDEN threads
// NEVER leave the server — they collapse to a single pressure-only hint that leaks
// no title, count, or specifics. This is a standing awareness directive, distinct
// from the fired-beat narrativeDriver (which narrates a thread that MOVED this turn).
function buildThreadsDirective(run) {
  const threads = run && typeof run.threads === "object" && run.threads ? Object.values(run.threads) : [];
  const active = threads.filter((t) => t && typeof t === "object" && t.status === "active");
  if (!active.length) return "";
  const agendaOf = (t) => (typeof t.agenda === "string" ? t.agenda.trim() : "");
  const titleOf = (t) => (typeof t.title === "string" ? t.title.trim() : "");
  const revealed = active.filter((t) => t.revealState === "revealed" && agendaOf(t));
  const rumored = active.filter((t) => t.revealState === "rumored" && titleOf(t));
  const hidden = active.filter((t) => (t.revealState || "hidden") === "hidden");
  const parts = [];
  if (revealed.length) {
    parts.push(`Ongoing situations the player understands (you may name and reference these): ${revealed.map(agendaOf).join(" | ")}.`);
  }
  if (rumored.length) {
    parts.push(`The player suspects, but has not confirmed (foreshadow the tension; do NOT confirm specifics they have not earned): ${rumored.map(titleOf).join("; ")}.`);
  }
  if (hidden.length) {
    parts.push("Something here is unresolved beneath the surface; you may let a quiet unease color the scene, but reveal NOTHING specific about it.");
  }
  if (!parts.length) return "";
  return (
    " ONGOING THREADS (server-owned narrative agenda — you may weave and foreshadow these, but NEVER invent a new one" +
    ` and NEVER advance or resolve an existing one; the server decides when a thread moves): ${parts.join(" ")}`
  );
}

// PRONOUN GROUNDING (item 6). Lists every present NPC's committed pronouns so the
// narration model reads them as truth instead of guessing off the name — half of
// the enforcement pair (repairNarrationPronouns is the post-narration back-stop).
function buildPronounDirective(run) {
  const clauses = [];
  // The PLAYER's declared pronouns ride first (identity-as-state, 2026-07-18): the
  // champion's committed pronouns are truth, never inferred. A legacy character
  // with none set stays neutral (no clause) until they declare it.
  const player = run?.player;
  const playerPron = typeof player?.pronouns === "string" && player.pronouns.trim()
    ? player.pronouns.trim()
    : (typeof player?.gender === "string" && player.gender.trim() ? player.gender.trim() : "");
  if (playerPron) {
    clauses.push(`${player.displayName || player.name || "the player character"} (${playerPron})`);
  }
  const present = Object.values(run?.npcs || {}).filter(
    (npc) =>
      npc &&
      npc.currentLocationId === run?.currentLocationId &&
      npc.status !== "gone" &&
      (typeof npc.pronouns === "string" && npc.pronouns.trim() || typeof npc.gender === "string" && npc.gender.trim())
  );
  for (const npc of present) {
    clauses.push(`${npc.generatedName || npc.displayName || npc.role} (${npc.pronouns || npc.gender})`);
  }
  if (clauses.length === 0) {
    return "";
  }
  return ` COMMITTED PRONOUNS: ${clauses.join(", ")}. Refer to each of these characters with EXACTLY these pronouns — never swap, drift, or infer different ones.`;
}

// COMMITTED MANNERISMS (spit-ban vacuum fill): present NPCs' committed physical
// tells ride the context so the model voices THOSE instead of reaching for a stock
// tic (the banned spit). Backfills a mannerism onto any present NPC that predates
// the field (lazy, on appearance) so the grounding is never empty for legacy cast.
// Returns the directive text; mutates run.npcs for backfill (persisted with the turn).
// reputation-engine-v1 — the SFW romance boundary, stated PLAINLY per tier (the
// enjoy-AI law: the GM must know the current register and its wall). Table-adjacent
// but prose, so the model reads a rule not a number.
function buildRomanceBoundaryClause(name, tier) {
  const permits = {
    stranger: "polite, guarded warmth only — no romantic register",
    friendly: "genuine warmth and rapport, but no physical romance",
    close: "emotional closeness — longing, a charged glance — but still no physical romance",
    courting: "mutual romantic feeling and light physical affection (a held hand, a first kiss), warm and emotional",
    partner: "an established, tender romance"
  };
  const t = permits[tier] ? tier : "stranger";
  return (
    ` ROMANCE BOUNDARY (${name}, current tier: ${t}): ${permits[t]}.` +
    " SFW HARD RULE — romantic content is warm, emotional, and fades to black at most; EXPLICIT sexual content is BANNED at EVERY tier." +
    " Do not narrate past this tier's register; the SERVER advances romance as affection is earned, the narration never does."
  );
}

// reputation-engine-v1 — present NPCs' committed disposition tier + top preferences
// (so the GM reacts to standing and knows what each person values), plus faction
// standing for present members, plus the romance boundary for a present romanceable
// NPC. Server-owned: the GM reads standing, it never invents or moves it.
function buildReputationDirective(run) {
  const here = run?.currentLocationId;
  const npcs = run && typeof run.npcs === "object" && run.npcs ? Object.values(run.npcs) : [];
  const present = npcs.filter((n) => n && typeof n === "object" && n.currentLocationId === here && n.status !== "gone");
  if (!present.length) return "";
  const lines = [];
  const factionIds = new Set();
  let romanceClause = "";
  for (const npc of present) {
    const view = individualReputation(run, npc.npcId);
    if (!view) continue;
    const prefs = (Array.isArray(view.preferences) ? view.preferences : [])
      .slice(0, 3)
      .map((p) => `${(Number(p.weight) || 0) >= 0 ? "values" : "dislikes"} ${p.tag}`)
      .join(", ");
    lines.push(`${view.name}: standing ${view.tier}${prefs ? ` (${prefs})` : ""}`);
    if (view.factionId) factionIds.add(view.factionId);
    if (view.romanceable && !romanceClause) romanceClause = buildRomanceBoundaryClause(view.name, view.romanceTier);
  }
  if (!lines.length) return "";
  const factionLines = [];
  for (const fid of factionIds) {
    const f = factionReputation(run, fid);
    if (f) factionLines.push(`${f.name}: ${f.tier} (${f.standing >= 0 ? "+" : ""}${f.standing})`);
  }
  let out = ` REPUTATION (server-owned committed standing — let it color how these characters treat the player; NEVER invent or change a standing): ${lines.join("; ")}.`;
  if (factionLines.length) out += ` FACTION STANDING (of present members): ${factionLines.join("; ")}.`;
  if (romanceClause) out += romanceClause;
  return out;
}

function buildMannerismDirective(run) {
  const present = Object.values(run?.npcs || {}).filter(
    (npc) => npc && npc.currentLocationId === run?.currentLocationId && npc.status !== "gone"
  );
  if (present.length === 0) {
    return "";
  }
  backfillNpcMannerisms(run, present.map((npc) => npc.npcId));
  const list = present
    .filter((npc) => typeof npc.mannerism === "string" && npc.mannerism.trim())
    .map((npc) => `${npc.generatedName || npc.displayName || npc.role} ${npc.mannerism}`)
    .join("; ");
  if (!list) {
    return "";
  }
  return ` COMMITTED MANNERISMS (present characters): ${list}. Use a character's OWN committed mannerism sparingly, at most once, and NEVER invent a new physical tic or gesture for anyone — especially never a spit.`;
}

// COMPOUND ACTION (#6, resolver blindspot Class A). A multi-part intent ("pick the
// lock AND slip past the guard") is resolved on ONE roll, so the prose is free to
// narrate BOTH parts landing even on a failure/at-cost. We do not decompose (one
// roll stands); instead we CONSTRAIN the narration to the single committed band, so
// every part is bound to that one outcome. Only added when the intent is compound
// AND a roll actually resolved it (skipped for gated/no-roll turns).
function buildCompoundDirective(resolved) {
  const ar = resolved?.attemptResult;
  if (!ar || ar.gated === true || !isCompoundIntent(ar.intent)) {
    return "";
  }
  const band = String(ar.band || (ar.success ? "success" : "failure")).toLowerCase();
  if (band.includes("cost")) {
    return (
      " MULTI-PART ACTION: the player attempted several things in one action; it resolved as ONE outcome — success at a cost. " +
      "The primary aim lands, but do NOT narrate every part cleanly succeeding — the committed cost falls on one of the parts " +
      "(a later step is only half-done, noticed, or complicated). Bind all parts to this single result; resolve none of them independently."
    );
  }
  if (band.includes("fail")) {
    return (
      " MULTI-PART ACTION: the player attempted several things in one action; it resolved as ONE outcome — a FAILURE. " +
      "Do NOT narrate the later parts succeeding — the action did not get that far. Narrate the attempt breaking down at the first part; " +
      "the subsequent parts never happen. Bind all parts to this single failed result."
    );
  }
  return (
    " MULTI-PART ACTION: the player attempted several things in one action; it resolved as ONE clean success — narrate every part " +
    "landing together as the single committed outcome, and resolve none of them as a separate, differently-graded result."
  );
}

// TURN ENVELOPE for reroute actions (#45 engine-half). A free-text intent typed
// into the attempt box may reroute server-side to search / observe / take / move /
// rest — those return their own result shape (searchResult/takeResult/…) and NO
// attemptResult. The client's turn log keys on attemptResult, so a rerouted turn
// ("look around" → search) rendered NOTHING — the player's action vanished. This
// synthesizes a uniform attempt-shaped turn record (player intent + the live
// narration + a no-roll outcome + a resolvedVia tag) so EVERY committed player
// action produces one renderable turn. Returns null when there's nothing to log.
function synthesizeRerouteTurn(resolved, gmNarration) {
  const action = resolved?.action || {};
  const intent = typeof action.intent === "string" && action.intent.trim() ? action.intent.trim() : "";
  if (!intent) {
    return null;
  }
  let success = true;
  let resolvedVia = action.type || "action";
  if (resolved.searchResult) {
    success = resolved.searchResult.found === true;
    resolvedVia = action.observedViaIntent ? "observe" : "search";
  } else if (resolved.takeResult) {
    success = resolved.takeResult.taken === true;
    resolvedVia = "take";
  } else if (resolved.moved) {
    resolvedVia = "move";
  } else if (resolved.restResult) {
    resolvedVia = "rest";
  } else {
    return null; // not a recognized reroute → nothing to synthesize
  }
  return {
    intent,
    success,
    band: "automatic",
    outcomeLabel: null,
    needsCheck: false,
    checkResult: null,
    narration: typeof gmNarration === "string" ? gmNarration : "",
    // Marks a turn the server resolved WITHOUT a d20 (a committed reroute), so the
    // client can render it as a plain turn (no "vs DC" tag) — a real, logged beat.
    resolvedVia,
    synthesized: true
  };
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
      edition: run.edition,
      transcript: { runId: run.runId, turnRef: Array.isArray(run.timeline) ? run.timeline.length : null, callType: "narration" }
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
  // D.5 NARRATIVE SUBSTRATE — a thread beat fired this turn. Its payload is ALREADY
  // COMMITTED to state (a fact / an objectState / a placed NPC). The fold-in hands
  // the GM the committed beat and its server-selected VERBATIM callbacks — and, for
  // a HIDDEN thread, NEVER the agenda (the driver carries none): the narrator
  // voices the EVENT, never the unnamed plot behind it. This is the coherence
  // invariant that keeps a hidden escalation out of the prompt.
  if (resolved.narrativeDriver && resolved.narrativeDriver.source === "thread") {
    const d = resolved.narrativeDriver;
    const callbacks = Array.isArray(d.callbacks) && d.callbacks.length
      ? ` Ground it in what the player already did — reference this committed history without restating it as a list: ${d.callbacks.map((c) => `"${c}"`).join("; ")}.`
      : "";
    const pattern = d.threadKnown && d.agenda
      ? ` The player understands the pattern behind this — you may name it: ${d.agenda}`
      : ` Narrate ONLY this committed development as it appears in the scene — do NOT name, hint at, or foreshadow any larger scheme, pattern, or hidden agenda behind it; the player sees the event, not the plot.`;
    message +=
      ` MEANWHILE a REAL development has just been committed to the game state: ${d.beat.brief}` +
      `${callbacks} Narrate it arriving alongside the action's outcome — it is really happening — and end by putting its choice in front of the player: ${d.beat.decision}` +
      `${pattern} Do NOT invent any other new arrivals, changes, or events beyond this one.`;
  }
  // LETHALITY ENFORCEMENT (#12): a helpful-tuned model defaults to mercy. Counter
  // it explicitly — the GM is a real 5e DM who narrates EARNED consequences and
  // never rescues the player from them.
  message += buildConsequenceDirective(resolved);
  // WORLD CLOCK (#14): pin the narration to the committed time-of-day so prose
  // can't drift to night while the clock reads morning.
  message += buildClockDirective(resolved);
  // INTRODUCTION BEAT: any committed-but-never-introduced NPC present in the
  // scene gets a server-guaranteed first-appearance directive (the momentum-
  // arrival pattern) — no more cold-surfacing mid-turn. Marked introduced by the
  // action handler once the narration lands.
  const introDirective = buildNpcIntroDirective(run);
  if (introDirective) {
    message += ` ${introDirective}`;
  }
  // PRONOUN GROUNDING: committed gender/pronouns for every present NPC ride the
  // context, so the model never has to guess (the he/him-Mara narrated-she bug).
  message += buildPronounDirective(run);
  // COMMITTED MANNERISMS (spit-ban vacuum fill): present NPCs' committed physical
  // tells ride the context so the model voices those instead of a stock spit.
  message += buildMannerismDirective(run);
  // VOICE CONTRACT (vn-dialogue-hardening law 2): each present NPC's committed
  // voice spec (register / sentence length / talkativeness) is law for every
  // spoken line — the spoken twin of the mannerism directive above.
  const voiceDirective = buildVoiceDirective(run);
  message += voiceDirective;
  // REPUTATION (reputation-engine-v1): present NPCs' committed disposition tier + top
  // preferences + faction standing + the SFW romance boundary — beside pronouns/mannerisms.
  message += buildReputationDirective(run);
  // DISAGREEMENT LAW (vn-dialogue-hardening law 1): present low-standing NPCs
  // (hostile tier / fearful / distrustful / wary) may not simply agree with
  // player requests — refusal, deflection, a lie, or hard terms only. Derived
  // from committed reputation values; paired with the compliance auditor below.
  const disagreementDirective = buildDisagreementDirective(run);
  message += disagreementDirective;
  // Transcript observability: the run log records which dialogue laws rode this
  // turn's prompt (the transcript is the causal chain; a hard law silently in
  // force is exactly the class of thing it exists to make auditable).
  if (voiceDirective || disagreementDirective) {
    logTurnEvent(
      run.runId,
      `dialogue-laws ACTIVE:${disagreementDirective ? ` disagreement[${disagreementDirective.slice(0, 120).replace(/^.*?: /, "").trim()}…]` : ""}${voiceDirective ? " voice" : ""}`
    );
  }
  // PLAYER GOALS (player-goals-law): active goals ride every prompt as committed
  // directives (acknowledge / advance / lawfully obstruct — never ignore or
  // redirect away), and committed achievements ride so the world references what
  // the player has built. Paired with the goal-ignored auditor below.
  message += buildGoalsDirective(run);
  message += buildDemonstratedAskDirective(run);
  // MAP-LAYOUT LAW: the committed scene geometry rides every prompt — the
  // narrator describes the clearing where the clearing IS, and never invents
  // placement the map would contradict.
  message += buildLayoutDirective(run);
  // SYSTEM LORE (item 1): the WINDOW/VOICE world-law facts ground every turn, so
  // the model never invents system capabilities ("the window will remember…").
  message += buildSystemLoreClause();
  // ESSENCE-SIGHT (verdance-region-v1 §law-5): the committed demon-essence traces
  // at the scene ride as SIGHT-FACTS with a perception register (only the MC
  // perceives them; NPCs cannot see/discuss them) + a hard ban on inventing a
  // trace the WINDOW does not show. Server-owned truth, exactly like SYSTEM LORE.
  message += buildEssenceTraceDirective(run);
  // ONGOING THREADS (D.5 item 4): the server-owned narrative agenda, reveal-gated —
  // the narrator foreshadows active threads but never invents/advances/resolves one.
  message += buildThreadsDirective(run);
  // COMPOUND ACTION (#6): a multi-part intent resolved on ONE roll — constrain the
  // prose to that single committed outcome so it can't narrate every part landing.
  message += buildCompoundDirective(resolved);
  // INPUT MODE (#37/#38): a SPEECH turn is the character speaking aloud in-fiction.
  // Frame the beat as dialogue — the world and present NPCs respond to the SPOKEN
  // WORDS — not as a physical action the character performed.
  if (resolved.attemptResult?.inputMode === "speech") {
    message += " The player's input was IN-CHARACTER SPEECH: their character SAID this aloud. Narrate how the scene and any present characters respond to the spoken words — treat it as dialogue, not a physical action, and let a present NPC answer in their own voice if it fits.";
  }
  const ceiling = effectiveActionTimeoutMs();
  const t0 = Date.now();
  const generateOnce = (msg) =>
    withGmTimeout(
      runGmPipeline({
        campaignId: run.campaignId,
        message: msg,
        mode: "companion",
        playerName: run.player?.displayName || "the wanderer",
        actorUserId: user?.id,
        edition: run.edition,
        // Fire-after-response: the knowledge-graph write must not block the turn.
        deferMemory: true,
        // Item 3: true transcript labels — a talk turn records "talk", everything
        // else on this path is turn narration. runId/turnRef replace the
        // campaignId-keyed default. (The handles-retry re-entry is tagged by the
        // pipeline itself and overrides this label.)
        transcript: {
          runId: run.runId,
          turnRef: Array.isArray(run.timeline) ? run.timeline.length : null,
          callType: resolved?.action?.type === "talk" ? "talk" : "narration"
        }
      }),
      ceiling
    );
  const { timedOut, value, error } = await generateOnce(message);
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
  // Belt-and-suspenders AI-tell strip: the prompt bans em/en-dashes, but a model
  // still slips one occasionally (leaked on 4/15 turns of run_b06da13d). Strip the
  // finished LIVE prose too so the player never sees a dash-tell on screen — the
  // same sanitizer the fallback templates use.
  let narrative = value && typeof value.narrative === "string" ? stripAiTells(value.narrative.trim()) : "";
  const model = value?.meta?.model || "unknown";
  const provider = gmProviderForModel(model);
  if (!narrative) {
    logTurnEvent(run.runId, `GM returned EMPTY narration (${provider} ${model}, ${latencyMs}ms) — using deterministic template.`);
    return { narration: null, source: "template-empty", provider, model, latencyMs };
  }
  // HANDLES ENFORCEMENT (item 5): one corrective regeneration when the draft has
  // no closing handles; never blocks a turn (see server/gm/handlesEnforcement.js).
  let handlesRetry = 0;
  try {
    const handleScene = {
      cast: presentNpcsForVn(run).map((npc) => ({ displayName: npc.generatedName || npc.displayName || "", present: true }))
    };
    const enforced = await enforceHandles(narrative, {
      scene: handleScene,
      regenerate: async () => {
        const retry = await generateOnce(`${message}${HANDLES_CORRECTIVE_CLAUSE}`);
        return !retry.timedOut && !retry.error && retry.value && typeof retry.value.narrative === "string"
          ? stripAiTells(retry.value.narrative.trim())
          : "";
      }
    });
    if (enforced.handlesRetry) {
      logTurnEvent(run.runId, `handles-retry fired (draft had no closing directions); retry ${enforced.retryReplaced ? "replaced the draft" : "failed — keeping the first draft"}`);
    }
    narrative = enforced.narrative;
    handlesRetry = enforced.handlesRetry;
  } catch {
    // enforcement must never break a turn
  }
  // LAW R10 (romance-legacy-law.md): Mainline romance-register violations are
  // BLOCKED, not log-only. Runs on the FINAL draft (after the handles pass, so
  // a handles-retry rewrite is audited too). One corrective regeneration through
  // the same generateOnce plumbing; if that draft still violates (or fails),
  // narration:null sends the caller to the deterministic committed-fact template
  // — the player never sees the violating prose. Personal-Forbidden runs stay
  // log-only per law. Non-fatal: an enforcement crash keeps the current draft
  // (the downstream log-only auditor still flags it).
  try {
    const r10 = await enforceRomanceRegister(narrative, {
      run,
      regenerate: async () => {
        const retry = await generateOnce(`${message}${ROMANCE_CORRECTIVE_CLAUSE}`);
        return !retry.timedOut && !retry.error && retry.value && typeof retry.value.narrative === "string"
          ? stripAiTells(retry.value.narrative.trim())
          : "";
      }
    });
    if (r10.action === "regenerated") {
      logTurnEvent(
        run.runId,
        `romance-register R10: draft BLOCKED (${r10.violations.map((v) => v.kind).join(",")}); corrective regeneration passed clean`
      );
      narrative = r10.narrative;
    } else if (r10.action === "blocked") {
      logTurnEvent(
        run.runId,
        `romance-register R10: draft BLOCKED (${r10.violations.map((v) => `[${v.kind}${v.tier ? `@${v.tier}` : ""}] "${v.phrase}"`).join(" | ")}); ` +
          `${r10.retryViolations ? "retry still violated" : "no clean retry"} — deterministic template stands in`
      );
      return { narration: null, source: "romance-blocked", provider, model, latencyMs: Date.now() - t0, handlesRetry };
    }
    // "clean" and "log-only" (Personal-Forbidden) pass through; the downstream
    // auditor block logs forbidden-lane violations as before.
  } catch {
    // enforcement must never break a turn
  }
  return { narration: narrative, source: "provider", provider, model, latencyMs: Date.now() - t0, handlesRetry };
}

// OOC (#37/#38) — the GM answers an out-of-character note AS THE GM (meta), never
// in-fiction. A distinct system prompt from the in-fiction narrator: it answers
// rules/recap/options questions plainly and is explicitly forbidden from narrating
// story events, advancing the fiction, changing the world, or speaking as a
// character. Bounded + non-fatal: any failure returns null and the caller shows a
// gentle fallback. No state is touched anywhere in this path.
async function narrateOocWithGm(run, question) {
  if (!run?.campaignId || typeof question !== "string" || !question.trim()) {
    return { reply: null };
  }
  // ooc-grounding (Jul 10): the OOC answer receives the SAME committed, on-screen
  // grounding a narration turn sees — recent narration verbatim, objectives,
  // conditions, clock, location, present NPCs, the recent committed development,
  // and system lore — so it answers specifically and never asks the player to
  // re-supply context that is on screen ("5 minutes to do what?" → "clarify").
  const messages = [
    {
      role: "system",
      content: buildOocSystemPrompt(run)
    },
    { role: "user", content: question.trim().slice(0, 800) }
  ];
  try {
    const oocT0 = Date.now();
    const response = await generateNarrative(messages, run.campaignId, { maxResponseTokens: 220, temperature: 0.3 });
    const raw = typeof response?.content === "string" ? response.content : (typeof response?.narrative === "string" ? response.narrative : "");
    // Item 3 (bucket-2): OOC bypasses runGmPipeline (direct generateNarrative), so
    // it records its own transcript entry with the true callType.
    recordGmGeneration({
      runId: run.runId,
      campaignId: run.campaignId,
      turnRef: Array.isArray(run.timeline) ? run.timeline.length : null,
      callType: "ooc",
      model: response?.model ?? null,
      finishReason: response?.finishReason ?? null,
      promptMessages: messages,
      rawOutput: String(raw),
      trimmedOutput: null,
      latencyMs: Date.now() - oocT0,
      trimApplied: false,
      handlesRetry: false
    });
    const reply = stripAiTells(String(raw).trim());
    return { reply: reply || null, model: response?.model || null };
  } catch {
    // The GM call failed (cloud outage / quota, and — by policy — NO local 8b
    // fallback). Flag it so the OOC handler shows an honest "unavailable" note
    // rather than the "didn't catch that" message meant for an empty question.
    return { reply: null, unavailable: true };
  }
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
// ANTI-TAMPER phase 1 (item 2): the wallet-attack wall. Numbers are env-tunable
// owner-table placeholders (economy-law Law 6); generous dev defaults.
const turnLimiter = limiterFromEnv("turn", { max: 10, windowMs: 60_000 });
const oocLimiter = limiterFromEnv("ooc", { max: 6, windowMs: 60_000 });
const newRunLimiter = limiterFromEnv("new_run", { max: 5, windowMs: 3_600_000 });
const authLimiter = limiterFromEnv("auth", { max: 10, windowMs: 3_600_000 });
const generationLimiter = limiterFromEnv("generation", { max: 10, windowMs: 86_400_000 });

// INPUT INTEGRITY — turn idempotency. A client stamps each submitted turn with a
// turnId; a RESUBMISSION of the same turnId (the resync/retry path after a
// client-side timeout or dropped connection) must NEVER re-roll or double-commit
// (dice roll server-side, so a naive resubmit would produce a different outcome
// AND a second timeline event). Two guards: `inFlightTurns` covers the concurrent
// window (the same turnId still processing), and a COMMITTED turnId is matched by
// scanning the run's timeline (durable across restarts — the turnId is stamped onto
// the turn's committed event). Keyed `${runId}::${turnId}`. Old clients omit turnId
// and keep today's exact behavior (no idempotency, no double-commit possible for a
// single submit).
// `${runId}::${turnId}` -> a gate Promise that resolves when the original submit
// of that turnId settles. A concurrent duplicate AWAITS the gate, then replays the
// original's committed outcome — exactly-once processing, no re-roll, no
// double-commit. (A Set can't serialize: two submits can both pass a has()-check in
// the window between the original's response finishing and its commit becoming
// visible to a stale snapshot.)
const inFlightTurns = new Map();
const TURN_ID_TIMELINE_SCAN = 50; // recent events scanned for a committed turnId

// The committed timeline event carrying this client turnId, or null. Scans from the
// newest event back, bounded — a resubmit always targets a very recent turn.
function findCommittedTurnEvent(run, turnId) {
  const timeline = Array.isArray(run?.timeline) ? run.timeline : [];
  for (let i = timeline.length - 1, seen = 0; i >= 0 && seen < TURN_ID_TIMELINE_SCAN; i -= 1, seen += 1) {
    const ev = timeline[i];
    if (ev && ev.payload && ev.payload.turnId === turnId) {
      return ev;
    }
  }
  return null;
}

async function buildLiveAttemptOptions(run, action, user) {
  if (!action || action.type !== "attempt") {
    return {};
  }
  // The test-hook providerOutput (selfplay) overrides any live provider anyway;
  // skip the model call entirely when it's present so the harness stays hermetic.
  if (testHooksEnabled() && action.testHook && typeof action.testHook === "object" && action.testHook.providerOutput) {
    return {};
  }
  // Belt-and-suspenders (anti-tamper item 1.3): a testHook payload arriving while
  // hooks are DISABLED is a probe — deny (ignore) and leave a loud footprint.
  if (!testHooksEnabled() && action.testHook) {
    // eslint-disable-next-line no-console
    console.warn(`[security] testHook payload REJECTED (hooks disabled) user=${user?.id || "anon"} run=${run?.runId || "?"}`);
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
  // LATENCY: skip the interpreter for actions the deterministic classifier ALREADY
  // resolves as no-check — passive OBSERVATION ("look around", "who's here") and
  // SAFE CONVERSATION (talking to a non-hostile). attemptNeedsCheck OVERRIDES the
  // provider to false for both (Ch3 Law 1), so the interpreter's proposal is
  // discarded anyway — running it only spends a serial ~6-15s deepseek call before
  // an outcome that was never in doubt. This is the reliable per-turn latency win
  // (the fast-lane interpreter routing was reverted — free gemini 429s under load).
  if (typeof action.intent === "string" && (isObservationQuery(action.intent) || isSafeConversation(action.intent))) {
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
      edition: run.edition,
      transcript: { runId: run.runId, turnRef: Array.isArray(run.timeline) ? run.timeline.length : null, callType: "narration" }
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

  // Debug/status: the single source of truth for "what is LIVE right now" — the
  // build the server is on, the GM model that ACTUALLY served the last turn
  // (never the configured value, so a silent 429→fallback is visible), and the
  // image provider/checkpoint that actually rendered. Feeds the in-app debug
  // panel. No secrets exposed (model names, short SHA, provider labels only), so
  // it needs no auth — the panel reads it before/around a run. `debugDefault`
  // tells the client whether to show the panel by default (dev on, prod off).
  if (req.method === "GET" && url.pathname === "/api/debug/status") {
    let cloudChain = "off";
    try {
      const lanes = resolveCloudChain();
      cloudChain = lanes ? lanes.map((lane) => lane.name).join(" → ") : "off (mainline)";
    } catch {
      cloudChain = "unknown";
    }
    const build = getBuildInfo();
    writeJson(res, 200, {
      ok: true,
      build,
      // Anti-tamper item 1.2: the badge surface tells the truth about hooks.
      testHooks: testHooksEnabled(),
      // Preflight (audit 5d548ac #1): the GM-key row. red (ok:false) → the client
      // raises a banner and the owner knows the AI GM will not run, instead of a
      // silent degrade to template prose.
      preflight: { gmKey: gmKeyPreflight },
      gm: {
        configuredModel: resolveGmModel(),
        served: getGmServe(),
        // GPU-safety at a glance: whether a slow cloud turn may cascade to the
        // local 8b (ollama loads ~6GB into the 8GB GPU — the freeze path). The
        // SAME predicate the fallback path evaluates, never a re-derivation.
        localFallback: localFallbackEnabled()
      },
      image: {
        configuredProvider: resolveImageProvider(),
        // What ACTUALLY rendered last: { provider, model, checkpoint, at } — the
        // IMAGE line always carries model + timestamp of the last real generation.
        served: getImageServe(),
        // Loud worker health: a dead/wedged image worker can no longer masquerade
        // as a cache issue (autopsy 2026-07-18).
        worker: imageWorkerStatus()
      },
      // Item 7: per-turn latency stage breakdown (interpreter/commit/gm/auditor/
      // renderReady) — last turn + a short ring of recent turns, so a slow outlier
      // stays visible. Collected by logging/turnTiming.js (runtimeStatus untouched).
      turnTiming: {
        last: getLastTurnTiming(),
        recent: getRecentTurnTimings()
      },
      // Auth observability (2026-07-18): the last few auth requests (method, path,
      // status, ms, inbound identity) so failed logins are visible at a glance —
      // family with the image.worker health line. No tokens/passwords/bodies.
      auth: {
        recent: lastAuthEvents()
      },
      cloudChain,
      nodeEnv: build.nodeEnv,
      debugDefault: debugPanelDefault()
    });
    return true;
  }

  // Public roadmap (item 6): owner-editable data file (docs/roadmap-public.json),
  // NOT hardcoded strings. Absent/unreadable/malformed → { items: [] } so the
  // client hides the panel cleanly. No auth, no release-notes machinery.
  if (req.method === "GET" && url.pathname === "/api/roadmap") {
    let items = [];
    try {
      const raw = fsSync.readFileSync(path.resolve(process.cwd(), "docs/roadmap-public.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items)) {
        items = parsed.items
          .filter((it) => it && typeof it.title === "string" && it.title.trim())
          .map((it) => ({
            title: String(it.title).trim(),
            description: typeof it.description === "string" ? it.description.trim() : "",
            status: ["building", "next", "planned"].includes(String(it.status || "").toLowerCase())
              ? String(it.status).toLowerCase()
              : ""
          }));
      }
    } catch {
      items = [];
    }
    writeJson(res, 200, { ok: true, items });
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

  // PAYMENT RAIL (groundwork, not go-live): LemonSqueezy webhook → receipt-backed
  // tier flip, replacing the admin set-tier stopgap. DISABLED unless
  // LEMONSQUEEZY_WEBHOOK_SECRET is set, so this never activates without an explicit
  // launch decision. Signature-verified against the RAW body (never re-serialized).
  if (req.method === "POST" && url.pathname === "/api/webhooks/lemonsqueezy") {
    try {
      const raw = await readRawBody(req, 512 * 1024);
      const handler = createLemonSqueezyWebhookHandler({ setUserTier, findUserByEmail });
      const result = await handler(raw, req.headers["x-signature"]);
      writeJson(res, result.status, result.body);
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      // RATE LIMIT (anti-tamper item 2): credential-stuffing hygiene, per IP.
      {
        const key = rateKeyFor(null, req);
        const verdict = authLimiter.check(key);
        if (!verdict.allowed) {
          emitRateLimited(res, writeJson, authLimiter, key, verdict, url.pathname);
          return true;
        }
      }
      enforceAuthRateLimit(req);
      const payload = await readJsonBody(req);
      // A guest registering keeps their identity: the guest user record is
      // promoted in place (same user id), so every run/campaign they started
      // as a guest is retained — "save your adventure", not "start over".
      const current = resolveAuthUser(req);
      const origin = originForRequest(req);
      const result = current?.isGuest
        ? upgradeGuestUser(current.id, payload, { origin })
        : registerUser(payload, { origin });
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // Guest play: mint a playable anonymous identity (no email/password) so a
  // stranger can start an adventure before deciding to register. Rate-limited
  // like the other auth endpoints so it can't be used to mass-mint users.
  if (req.method === "POST" && url.pathname === "/api/auth/guest") {
    try {
      enforceAuthRateLimit(req);
      const result = createGuestUser({ origin: originForRequest(req) });
      writeJson(res, 200, { ok: true, ...result });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      // RATE LIMIT (anti-tamper item 2): credential-stuffing hygiene, per IP.
      {
        const key = rateKeyFor(null, req);
        const verdict = authLimiter.check(key);
        if (!verdict.allowed) {
          emitRateLimited(res, writeJson, authLimiter, key, verdict, url.pathname);
          return true;
        }
      }
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
      // RATE LIMIT (anti-tamper item 2): fires BEFORE the guest cap (#67) — the
      // limiter is the burst wall (requests/min), the guest cap is the daily
      // spend meter; a burst is rejected before it can consume metered turns.
      {
        const body = await readJsonBody(req);
        req.__parsedBody = body; // handler below re-uses; body is read ONCE
        const isOoc = typeof body?.action?.intent === "string" && /^\s*\/ooc\b/i.test(body.action.intent);
        const limiter = isOoc ? oocLimiter : turnLimiter;
        const key = rateKeyFor(user, req);
        const verdict = limiter.check(key);
        if (!verdict.allowed) {
          emitRateLimited(res, writeJson, limiter, key, verdict, url.pathname);
          return true;
        }
      }
      // INPUT INTEGRITY (turn idempotency, read BEFORE the guest cap so a replay of
      // an already-committed turn returns its outcome even for a capped guest — the
      // turn was already spent, replaying it costs nothing). turnId is optional; an
      // old client omits it and keeps today's behavior.
      const turnId = typeof req.__parsedBody?.turnId === "string" ? req.__parsedBody.turnId.trim() : "";
      const idemKey = turnId ? `${run.runId}::${turnId}` : null;
      const replayCommittedTurn = (r) => {
        writeJson(res, 200, { ok: true, turnId, idempotentReplay: true, alreadyProcessed: true, run: r });
        return true;
      };
      if (turnId) {
        // Already COMMITTED: return the committed outcome (it is in `run` already) —
        // never re-roll, never append a second timeline event.
        const committed = findCommittedTurnEvent(run, turnId);
        if (committed) {
          return replayCommittedTurn(run);
        }
      }
      // Gate that this handler will resolve once its response settles; a concurrent
      // duplicate of the same turnId acquires nothing and instead awaits the prior
      // gate below, then replays the committed outcome.
      let releaseTurnGate = null;
      if (idemKey) {
        const inflight = inFlightTurns.get(idemKey);
        if (inflight) {
          // A submit of this turnId is already MID-FLIGHT — wait for it, then replay
          // its committed outcome (exactly-once; never a second roll/commit).
          await inflight.catch(() => {});
          const settledRun = getSoloRun(run.runId) || run;
          if (findCommittedTurnEvent(settledRun, turnId)) {
            return replayCommittedTurn(settledRun);
          }
          // The original produced no committed turn (e.g. it errored) — fall through
          // and process this one fresh, acquiring the gate below.
        }
        // Acquire the gate (check-and-set is synchronous + contiguous here, so it is
        // atomic under Node's single-threaded event loop).
        const gate = new Promise((resolve) => { releaseTurnGate = resolve; });
        inFlightTurns.set(idemKey, gate);
        const settle = () => {
          if (inFlightTurns.get(idemKey) === gate) {
            inFlightTurns.delete(idemKey);
          }
          if (releaseTurnGate) {
            releaseTurnGate();
            releaseTurnGate = null;
          }
        };
        res.once("finish", settle);
        res.once("close", settle);
        // TOCTOU close-out: `run` was snapshotted at the top of the handler and may
        // predate a same-turnId submit that acquired-and-finished while we awaited
        // the body (its gate is already gone, so the get() above missed it). Re-scan
        // a FRESH snapshot now that WE hold the gate — replay if it already committed.
        const freshRun = getSoloRun(run.runId);
        if (turnId && findCommittedTurnEvent(freshRun, turnId)) {
          return replayCommittedTurn(freshRun);
        }
      }
      // GUEST GM-TURN CAP (#67, pre-launch spend guard). Every guest GM turn is a
      // paid cloud call; a guest at their daily turn budget is soft-stopped HERE —
      // before the interpreter or narration fire — so anonymous sessions cannot
      // drive unlimited spend. Accounts are unlimited (turns:Infinity); BYOK
      // bypasses (they pay their own inference). No auto-top-up: the response is a
      // register nudge, never a silent charge. State is untouched (no turn taken).
      const turnByok = requestHasByokKey(req);
      const turnGate = canTakeGmTurn(user, { byok: turnByok });
      if (!turnGate.allowed) {
        writeJson(res, 200, {
          ok: true,
          status: "turn_cap_reached",
          turnCapReached: true,
          message: "You've reached the free guest play limit. Create a free account to keep going — your adventure is saved.",
          entitlement: entitlementSummary(user, { byok: turnByok }),
          run
        });
        return true;
      }
      const payload = req.__parsedBody ?? (await readJsonBody(req));
      const action = payload.action || payload;
      // Item 7: per-turn latency stage breakdown (interpreter/commit/gm/auditor/
      // renderReady) — logged to the run log + surfaced in /api/debug/status.
      const timing = startTurnTiming(run.runId, action?.type || "attempt");
      // LIVE attempt interpreter: for a real freeform attempt, adjudicate the
      // mechanics (incl. structured failureConsequence) via the GM first, then
      // pass it into the engine so per-case consequences + retry-foreclosure
      // actually fire in live play. No-op for non-attempt / test-hook actions.
      const attemptOptions = await buildLiveAttemptOptions(run, action, user);
      timing.mark("interpreter");
      const timelineLenBefore = Array.isArray(run.timeline) ? run.timeline.length : 0;
      const resolved = resolveSoloAction(run, action, attemptOptions);
      if (!resolved.ok) {
        throw Object.assign(new Error("Solo action could not be resolved."), {
          code: resolved.code || "ACTION_INVALID",
          statusCode: 400,
          validationErrors: resolved.errors,
          actionType: resolved.actionType
        });
      }
      // INPUT INTEGRITY: stamp the client turnId onto every timeline event THIS turn
      // committed, so a later resubmission of the same turnId is recognized as
      // already-committed (findCommittedTurnEvent) and replayed idempotently. Durable:
      // the stamp lives in run state and survives reload/restart. payload is free-form
      // (validateTimelineEvent does not whitelist its keys), so this is schema-safe.
      if (turnId && resolved.run && Array.isArray(resolved.run.timeline)) {
        for (let i = timelineLenBefore; i < resolved.run.timeline.length; i += 1) {
          const ev = resolved.run.timeline[i];
          if (ev) {
            ev.payload = { ...(ev.payload || {}), turnId };
          }
        }
      }
      // #67: count this turn against the guest cap (only guests are metered, so
      // this is a no-op write for accounts — gated to avoid needless disk writes).
      if (!turnGate.unlimited && user?.id) {
        incrementTurnCount(user.id);
      }

      // OOC (#37/#38) — an out-of-character note. The resolver committed NO state
      // (resolved.run is null) and tagged the question; answer AS GM (meta) and
      // return immediately, WITHOUT any in-fiction narration, timeline event, or
      // turn cost. The run is echoed back unchanged.
      if (resolved.code === "OOC") {
        const oocOut = await narrateOocWithGm(run, resolved.ooc?.question || "");
        const oocReply =
          oocOut.reply ||
          (oocOut.unavailable
            ? "(Out of character) The GM is momentarily unavailable — please try again in a moment."
            : "(Out of character) I didn't quite catch that — try rephrasing your note to me.");
        writeJson(res, 200, {
          ok: true,
          ooc: true,
          mode: "ooc",
          oocReply,
          run,
          action: resolved.action,
          availableMoves: resolved.availableMoves,
          availableActions: resolved.availableActions
        });
        return true;
      }

      // PLAYER GOALS (player-goals-law) — capture + honor, on the resolver's run
      // BEFORE it is persisted, so a goal declared this turn AND the artifact a
      // goal-relevant success just produced land in the SAME commit. Attempt
      // turns only (free-text intents); non-attempt actions carry no goal intent.
      let goalCapture = null;
      let goalHonored = [];
      if (resolved.run && resolved.action?.type === "attempt") {
        const goalIntent = resolved.attemptResult?.intent || resolved.action?.intent || "";
        const nowMinutes = resolved.run.world?.time?.minutes ?? 0;
        const turnNo = Array.isArray(resolved.run.timeline) ? resolved.run.timeline.length : 0;
        // THE THREE DOORS (B2). First answer any pending DEMONSTRATED ask, then the
        // OFFERED accept, then DECLARED capture; each Project/Ambition REGISTERS a D.5
        // thread source. Finally scan for a fresh demonstrated pattern to arm one ask.
        const demoAnswer = detectDemonstratedAnswer(resolved.run, goalIntent);
        if (demoAnswer === "confirm") {
          goalCapture = captureDemonstratedGoal(resolved.run, { nowMinutes, turn: turnNo });
        } else if (demoAnswer === "decline") {
          clearDemonstratedPrompt(resolved.run);
        }
        if (!goalCapture) {
          const offerAccept = detectGoalAcceptIntent(resolved.run, goalIntent);
          if (offerAccept) goalCapture = captureOfferedGoal(resolved.run, offerAccept.npcId, { nowMinutes, turn: turnNo });
        }
        if (!goalCapture) {
          // DECLARED door: intention-shaped speech commits a goal (guards: musing,
          // questions, one-shot actions never capture — see goals.detectGoalDeclaration).
          goalCapture = captureDeclaredGoal(resolved.run, goalIntent, { nowMinutes, turn: turnNo });
          if (goalCapture) registerGoalThread(resolved.run, goalCapture, { nowMinutes });
        }
        // Honor pipeline (Tasks): a goal-relevant build success writes the
        // goal-linked objectState + storm cover + achievement/XP.
        goalHonored = honorGoalsOnAttempt(resolved.run, {
          intent: goalIntent,
          attemptResult: resolved.attemptResult,
          nowMinutes
        });
        // DEMONSTRATED door: a repeated pattern (3+ same-token actions) arms ONE
        // diegetic ask (VOICE-flavored in Babel), surfaced on the next scene payload.
        if (!goalCapture && !resolved.run.flags?.demonstratedGoalPrompt) {
          const proposal = detectDemonstratedGoal(resolved.run);
          if (proposal) armDemonstratedAsk(resolved.run, proposal);
        }
      }
      const responseRun = resolved.run ? saveSoloRun(resolved.run) : run;
      if (goalCapture) {
        logTurnEvent(responseRun.runId, `goal CAPTURED (declared, ${goalCapture.scale}): "${goalCapture.summary}" [${goalCapture.goalId}]`);
      }
      for (const h of goalHonored) {
        logTurnEvent(responseRun.runId, `goal HONORED: "${h.summary}" [${h.goalId}] -> objectState ${h.objectId} (${h.band}${h.sheltered ? ", sheltered" : ""}); ${h.achieved ? `achieved +${h.xp}xp` : "progressed"}`);
      }
      timing.mark("commit");

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
      // #20-full: per-line speaker attribution for multi-NPC scenes (computed below
      // once the live narration is known), so the client can nameplate each line.
      let dialogueLines = [];

      // Generate the next scene's suggested actions in parallel with the GM
      // narration (overlapping its latency), so they're cached and ready by the
      // time the client reloads the scene — no extra wait, no blank suggestions.
      const [gmResult, suggestionsResult] = await Promise.all([
        narrateActionWithGm(responseRun, resolved, user),
        refreshSceneSuggestions(responseRun, setSoloRunSuggestions)
      ]);
      timing.mark("gm");
      // item 5: whether the handles-enforcement retry fired rides the timing line.
      timing.note("handlesRetry", gmResult?.handlesRetry ? 1 : 0);
      let gmNarration = gmResult?.narration || null;
      // SYSTEM-LORE AUDITOR (item 1, live check — NOT a ruler change): flag any
      // narration attributing a does-NOT capability to the WINDOW or VOICE.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        const loreViolations = detectSystemLoreViolations(gmNarration);
        if (loreViolations.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `system-lore VIOLATION: ${loreViolations.map((v) => `${v.subject} "${v.verb}" — ${v.sentence}`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
      }
      // DEADLINE-REFERENT AUDITOR (item 4, owner ruling — same severity class as
      // narrated-state drift): narrated time-boxed pressure ("maybe five minutes
      // to decide") with NO committed deadline referent (timed condition) is an
      // invented countdown — flag it loudly.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        const deadlineViolations = detectDeadlineViolations(gmNarration, responseRun);
        if (deadlineViolations.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `deadline-referent VIOLATION: ${deadlineViolations.map((v) => `"${v.phrase}" — ${v.sentence}`).join(" | ")} (no committed deadline backs this countdown) user=${user?.id || "anon"}`
          );
        }
        // ROMANCE/SFW AUDITOR (reputation-engine-v1 + LAW R10): Mainline
        // violations are now BLOCKED upstream in narrateActionWithGm
        // (enforceRomanceRegister), so on Mainline this is a residual check that
        // should never fire; on Personal-Forbidden it remains the law's log-only
        // record. Same severity family as narrated-state drift.
        const romanceViolations = detectRomanceRegisterViolations(gmNarration, responseRun);
        if (romanceViolations.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `romance-register VIOLATION: ${romanceViolations.map((v) => `[${v.kind}${v.tier ? `@${v.tier}` : ""}] "${v.phrase}" — ${v.sentence}`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
        // DISAGREEMENT AUDITOR (vn-dialogue-hardening law 1): a quoted line
        // grounded to a hostile/fearful/distrustful/wary NPC that reads as
        // simple compliance violates the committed standing — same severity
        // family as romance-register. Log-only; the directive is the contract.
        const complianceViolations = detectComplianceViolations(gmNarration, responseRun);
        if (complianceViolations.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `disagreement-law VIOLATION: ${complianceViolations.map((v) => `${v.name}[${v.reason}@${v.tier}] complied: "${v.line}"`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
        // GOAL-IGNORED AUDITOR (player-goals-law): the player pursued a committed
        // goal this turn and the narration neither engaged it nor lawfully
        // obstructed it — the founding "build a shelter, GM says go to town"
        // stiff-arm. Log-only; the goals directive is the contract.
        const ignoredGoals = detectGoalIgnored(gmNarration, responseRun, {
          intent: resolved.attemptResult?.intent || resolved.action?.intent || "",
          attemptResult: resolved.attemptResult
        });
        if (ignoredGoals.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `goal-ignored VIOLATION: ${ignoredGoals.map((g) => `"${g.summary}" [${g.goalId}] neither engaged nor lawfully obstructed — "${g.excerpt}"`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
        // STARTER-ZONE ANTI-LOST AUDITOR (owner ruling 2026-07-19): the Waking Mile
        // and the Green Static Fringe are HER kept-clear ground — getting-lost /
        // disorientation motifs are forbidden there (the wrongness lives BEYOND the
        // shimmer). Flags only INSIDE starter-zone locations. Log-only; the location
        // canon + the narrator directive are the contract.
        const lostMotifs = detectStarterZoneLostMotif(
          gmNarration,
          responseRun.locations?.[responseRun.currentLocationId] || {}
        );
        if (lostMotifs.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `starter-zone-lost VIOLATION @${responseRun.currentLocationId}: ${lostMotifs.map((m) => `"${m.phrase}"`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
        // COMBAT NARRATION AUDITOR (D.4) — WITH TEETH (A2, audit 5d548ac): the combat
        // directive says speak wounds in BANDS, never raw HP/damage numbers (the server
        // owns the numbers). A fabricated/leaked number inside a live fight is narrated-
        // state drift — so we STRIP it here at the trim layer (committed numbers are the
        // only numbers), not merely log it. The scrub replaces each raw figure with
        // wound-band language before anything downstream consumes the prose.
        const fab = scrubFabricatedCombatNumbers(gmNarration, responseRun.combat);
        if (fab.scrubbed.length > 0) {
          gmNarration = fab.text;
          logTurnEvent(
            responseRun.runId,
            `combat-number SCRUBBED @${responseRun.combat?.combatId || "?"}: ${fab.scrubbed.map((p) => `"${p}"`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
        // GEOMETRY AUDITOR (B3): narration that invents a door/gate/wall/water the
        // committed minted layout does not have (figurative language guarded). Log-only.
        const geoContradictions = detectGeometryContradiction(gmNarration, responseRun);
        if (geoContradictions.length > 0) {
          logTurnEvent(
            responseRun.runId,
            `geometry-contradiction VIOLATION @${responseRun.currentLocationId}: ${geoContradictions.map((g) => `[${g.kind}] "${g.phrase}"`).join(" | ")} user=${user?.id || "anon"}`
          );
        }
      }
      // PRONOUN ENFORCEMENT (item 6): repair narration that contradicts a present
      // NPC's committed gender BEFORE anything consumes it — same enforcement
      // class as phantom rejection (the server's pronouns are truth). Repairs are
      // logged so a drifting model is visible.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        // The PLAYER is audited too, keyed to their DECLARED gender (identity-as-
        // state): a narration that misgenders the champion is repaired like an NPC.
        // Legacy characters with no declared gender are simply not audited (neutral).
        const p = responseRun.player;
        const playerGender = typeof p?.gender === "string" && p.gender.trim() ? p.gender.trim() : pronounsToGender(p?.pronouns);
        const playerName = p?.displayName || p?.name;
        const auditRecords = Object.values(responseRun.npcs || {});
        if (playerGender && typeof playerName === "string" && playerName.trim().length >= 3) {
          auditRecords.unshift({ gender: playerGender, displayName: playerName, generatedName: playerName });
        }
        const pronounFix = repairNarrationPronouns(gmNarration, auditRecords);
        if (pronounFix.repairs.length > 0) {
          gmNarration = pronounFix.text;
          logTurnEvent(
            responseRun.runId,
            `pronoun-enforcement repaired narration for: ${pronounFix.repairs.map((r) => `${r.name}(${r.committed}${r.unrepairable ? ", unrepairable" : ""})`).join(", ")} user=${user?.id || "anon"}`
          );
        }
      }
      // SPIT BAN (owner law): a character spitting is a violation. Log it, then
      // surgically excise the gesture sentence (same "server owns the prose"
      // enforcement class as the pronoun repair) so the banned action never lands.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        const spits = detectSpitViolations(gmNarration);
        if (spits.length > 0) {
          const spitFix = stripSpitGestures(gmNarration);
          gmNarration = spitFix.text;
          logTurnEvent(
            responseRun.runId,
            `spit VIOLATION (banned) — removed ${spitFix.removed.length}: ${spits.map((v) => v.sentence).join(" | ")} user=${user?.id || "anon"}`
          );
        }
      }
      // ESSENCE-SIGHT never-invents guard (verdance-region-v1 §law-5): essence
      // traces are server-owned committed state. When the WINDOW shows NO trace at
      // the scene, the narrator must not assert a fresh essence trail / residue /
      // handler-scent — strip any such invented sight-fact. When a trace IS
      // committed here, trace-prose is the narrator DESCRIBING it, and is kept.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        const traceAudit = auditNarratedEssenceTraces(responseRun, gmNarration);
        if (traceAudit.stripped.length > 0) {
          gmNarration = traceAudit.text;
          logTurnEvent(
            responseRun.runId,
            `essence-sight VIOLATION (invented trace, none committed here) — stripped ${traceAudit.stripped.length}: ${traceAudit.stripped.join(" | ")} user=${user?.id || "anon"}`
          );
        }
      }
      // REPETITION GUARD (item 4): flag a stock physical-gesture phrase reused
      // across the session (the next tic after spit). Detection + logging here;
      // the merged signature set is persisted in the commit block's fresh snapshot.
      if (typeof gmNarration === "string" && gmNarration.trim()) {
        const priorSigs = Array.isArray(responseRun.flags?.gestureSignatures) ? responseRun.flags.gestureSignatures : [];
        const gestureCheck = detectRepeatedGestures(gmNarration, priorSigs);
        if (gestureCheck.repeated.length > 0) {
          logTurnEvent(responseRun.runId, `repeated-gesture guard: "${gestureCheck.repeated.join('", "')}" recurred this session user=${user?.id || "anon"}`);
        }
      }
      // PER-TURN SESSION TRANSCRIPT (data/logs/runs/<runId>.log) — the full causal
      // chain of this turn, including every formerly-silent fallback, so the owner
      // can tail it during a detached playtest and see exactly what happened.
      try {
        appendTurnLog(responseRun.runId, buildTurnTranscript(resolved, gmResult, suggestionsResult));
      } catch {
        // transcript must never break a turn
      }
      // R10 FALLBACK SANITIZER (live-probe finding): when the GM draft was
      // BLOCKED and the deterministic template stands in, the template can echo
      // the player's own over-tier intent ("I kiss her…" → "The kiss is
      // intense…"). Strip register-violating sentences from every template
      // surface this turn so the blocked register can't re-enter through the
      // safe path. Log-visible; non-fatal by construction (pure string filter).
      if (!gmNarration && gmResult?.source === "romance-blocked") {
        const surfaces = [
          ["attemptResult.narration", attemptResult, "narration"],
          ["talkResult.line", talkResult, "line"],
          ["searchResult.summary", searchResult, "summary"],
          ["restResult.summary", restResult, "summary"],
          ["useItemResult.summary", useItemResult, "summary"]
        ];
        for (const [label, holder, field] of surfaces) {
          if (holder && typeof holder[field] === "string" && holder[field].trim()) {
            const fix = stripRomanceRegister(holder[field], responseRun);
            if (fix.removed.length > 0) {
              holder[field] = fix.text;
              logTurnEvent(
                responseRun.runId,
                `romance-register R10: fallback template ${label} echoed the blocked register — stripped ${fix.removed.length} sentence(s)`
              );
            }
          }
        }
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

        // INTRODUCTION BEAT: the narration above carried the first-appearance
        // directive for every pending NPC — mark them introduced so the beat
        // fires exactly once. Only on a SUCCESSFUL narration (a failed/timeout
        // turn leaves the intro pending for the next one).
        for (const npcId of collectNpcsWithPendingIntro(responseRun)) {
          markNpcIntroduced(responseRun.runId, npcId);
          const held = responseRun.npcs?.[npcId];
          if (held) {
            held.introInstructions = null;
            held.flags = { ...(held.flags || {}), introduced: true };
          }
        }

        // #20-full: attribute each quoted line to a present speaker so a multi-NPC
        // scene gets the right nameplate per line (server-owned, grounded against
        // present NPCs — never a guessed name). Empty for ambient/no-dialogue turns.
        if (typeof gmNarration === "string" && gmNarration.trim()) {
          dialogueLines = attributeSceneDialogue(gmNarration, presentNpcsForVn(responseRun), {
            playerName: responseRun.player?.displayName
          });
        }

        // COMMITTED NPC ENTITIES (#27) — the coherence moat, NPC side. If the live
        // GM narrated a proper-noun character who spoke or acted (Grace, Doc Han,
        // a pursuer) with NO committed record, promote them into a real run.npcs
        // entity now, so the next turn's state holds them instead of the model
        // re-inventing or contradicting them. Read-modify-write on a fresh snapshot
        // (same discipline as the VN block below) so no interleaving image-worker
        // write is clobbered; skipped entirely when nothing phantom was named.
        if (typeof gmNarration === "string" && gmNarration.trim()) {
          const knownNames = [
            responseRun.player?.displayName,
            responseRun.locations?.[responseRun.currentLocationId]?.name,
            ...Object.values(responseRun.npcs || {}).map((npc) => npc?.displayName)
          ].filter(Boolean);
          const freshForNpc = getSoloRun(responseRun.runId);
          if (freshForNpc) {
            const committedNpcs = auditAndCommitNarratedNpcs(freshForNpc, gmNarration, knownNames);
            // INVENTED GENERIC AGENTS (B2): a model gives agency to an un-named
            // actor ("the creature's gaze", "some scavenger hisses") with no
            // committed entity — commit it as a real cast member so it persists.
            // Runs after the proper-noun pass so a just-committed named NPC counts
            // as cast and a generic paraphrase of it is not double-committed.
            const committedAgents = auditAndCommitInventedAgents(freshForNpc, gmNarration, knownNames);
            // PHANTOM PLACE/LORE (#41): commit any GM-asserted landmark ("the Old
            // Watchtower") as canonical lore so the reference persists as truth
            // instead of a phantom the next turn can contradict — the class that
            // scored a grading session F/0.
            const committedLore = auditAndCommitNarratedLore(freshForNpc, gmNarration, knownNames);
            // FOUND OBJECTS (the strongbox gap): a narrated discovery of a
            // discrete object ("you find a rusted iron strongbox") with no
            // committed backing becomes a real objectState on the current
            // location, so the world owns it from the turn it was narrated —
            // same commit-not-strip doctrine as #27/B2/#41.
            const committedObjects = auditAndCommitFoundObjects(freshForNpc, gmNarration, knownNames);
            // #50: backfill gender onto committed NPCs the narration genders but that
            // were minted ungendered (starting/identity cast) — so their portrait
            // matches the text (write-female/render-male fix).
            const genderedNpcs = backfillNpcGenderFromNarration(freshForNpc, gmNarration);
            // MANNERISM BACKFILL (item 3d) + REPETITION-GUARD PERSISTENCE (item 4)
            // on the same fresh snapshot so both survive an interleaving image
            // write. Present cast lacking a mannerism gets one now; the session's
            // gesture-signature set is merged so the guard sees across turns.
            const presentIds = Object.values(freshForNpc.npcs || {})
              .filter((npc) => npc && npc.currentLocationId === freshForNpc.currentLocationId && npc.status !== "gone")
              .map((npc) => npc.npcId);
            const manneredNpcs = backfillNpcMannerisms(freshForNpc, presentIds);
            const priorSigs = Array.isArray(freshForNpc.flags?.gestureSignatures) ? freshForNpc.flags.gestureSignatures : [];
            const gestureMerged = detectRepeatedGestures(gmNarration, priorSigs).signatures;
            const sigsChanged = gestureMerged.length !== priorSigs.length;
            freshForNpc.flags = { ...(freshForNpc.flags || {}), gestureSignatures: gestureMerged };
            if (committedNpcs.length > 0 || committedAgents.length > 0 || committedLore.length > 0 || committedObjects.length > 0 || genderedNpcs.length > 0 || manneredNpcs.length > 0 || sigsChanged) {
              saveSoloRun(freshForNpc);
              responseRun.npcs = freshForNpc.npcs;
              responseRun.memoryFacts = freshForNpc.memoryFacts;
              responseRun.locations = freshForNpc.locations;
              responseRun.flags = freshForNpc.flags;
              const committedCast = [...committedNpcs, ...committedAgents];
              if (committedCast.length > 0) {
                logTurnEvent(responseRun.runId, `#27/B2 committed ${committedCast.length} narrated actor(s): ${committedCast.join(", ")} user=${user?.id || "anon"}`);
              }
              if (committedLore.length > 0) {
                logTurnEvent(responseRun.runId, `#41 committed ${committedLore.length} narrated place/lore fact(s): ${committedLore.join(", ")}`);
              }
              if (committedObjects.length > 0) {
                logTurnEvent(responseRun.runId, `found-object committed ${committedObjects.length} narrated discover(ies): ${committedObjects.join(", ")} (objectState on ${freshForNpc.currentLocationId})`);
              }
            }
          }
        }

        // VN AGENCY RULE (vn-trigger-agency, Jul 11 owner ruling): the VN overlay
        // opens ONLY from PLAYER-INITIATED conversation — a talk action or a
        // freeform "speak to X" attempt, both resolved at resolveSoloAction time
        // (actions.js sets run.vn to the ADDRESSED NPC, and resets to ambient on
        // every other action). We DELIBERATELY no longer auto-promote VN from the
        // turn's free-text narration: a world event near the player (a momentum
        // arrival, an NPC-to-NPC exchange, a courier bursting in) is NARRATION and
        // renders in the log — it must NEVER auto-open a dialogue with an NPC the
        // player did not choose to address (the live "Ilse" bug: a courier beat
        // naming a present NPC hijacked the VN with the wrong, never-met speaker).
        // resolveSoloAction is now the SOLE authority on run.vn. An NPC wanting to
        // talk = narration stating so, with the choice left to the player.
        // (classifyNarrationVn is retained as a pure classifier for a possible
        // future EXPLICIT "committed event addresses the player" path, but it is
        // no longer wired to auto-activate VN from arbitrary narration.)
      }

      timing.mark("auditor");

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

      // #45 engine-half: a rerouted free-text turn (search/observe/take/move/rest)
      // carries no attemptResult; synthesize a uniform turn envelope so the client
      // logs EVERY player action as one renderable turn (never a vanished turn).
      if ((!attemptResult || Object.keys(attemptResult).length === 0) && resolved.action?.type !== "attempt") {
        const synthetic = synthesizeRerouteTurn(resolved, gmNarration);
        if (synthetic) {
          attemptResult = synthetic;
        }
      }

      timing.mark("renderReady");
      const turnTiming = timing.finish();

      writeJson(res, 200, {
        ok: true,
        // Echoed so the client can match this outcome to its in-flight turn and
        // retire the pending lifecycle (input integrity).
        turnId: turnId || null,
        run: responseRun,
        action: resolved.action,
        event: resolved.event,
        memoryFact: resolved.memoryFact,
        searchResult,
        talkResult,
        restResult,
        useItemResult,
        attemptResult,
        // Item 7: this turn's stage latency breakdown (also in the run log +
        // /api/debug/status), so a slow turn is attributable client-side too.
        turnTiming,
        // #20-full: [{ text, speakerId, speakerName, kind }] per quoted line.
        dialogueLines,
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
      const linked = ensureNpcImageAssets(run.runId, portraitTarget.npcId, { style: engineStyleForRun(run) });
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
        style: engineStyleForRun(run),
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
      // MAP-LAYOUT LAW: first map view is a "layout needed" moment — mint the
      // current location's layout deterministically and COMMIT it (resume-safe;
      // legacy runs lazy-mint here). No-op when the layout already exists.
      const layoutMint = ensureLocationLayout(run, run.currentLocationId);
      if (layoutMint.minted) {
        saveSoloRun(run);
      }
      // Entitlement gate: a free user past their daily image quota (and without a
      // BYOK key) stops triggering new image generation — the scene still renders
      // fully, just with placeholder art until the cap resets. Degrades softly; it
      // never blocks the scene. Identity/suggestions are text, so they stay open.
      const byok = requestHasByokKey(req);
      const imageGate = canGenerateImage(user, { byok });
      const allowImages = imageGate.allowed;
      // DIAGNOSABILITY (images "dead in-session"): when the daily image quota is
      // spent, EVERY image enqueuer below is dropped silently and the client
      // shows an eternal "Generating…" placeholder — the exact symptom that went
      // undiagnosed. Log it once per scene load so a quota-skip is never invisible
      // again. (The pipeline itself is healthy: provider→worker→write→payload→
      // client-poll all verified; a spent free cap or INKBORNE_MOCK_IMAGE=true are
      // the only ways images "fail". See the payment-rail report.)
      if (!allowImages) {
        console.warn(
          `[images] SKIPPED for run ${run.runId}: tier=${imageGate.tier} used=${imageGate.used}/${imageGate.limit} ` +
            `byok=${byok} — daily image quota spent; scene renders with placeholder art until reset.`
        );
      }
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
      // on every scene load and never fires for NPCs who never enter VN. A scene
      // whose sprite already resolved (run asset OR a Law-5 library checkout)
      // never enqueues — generating anyway would face-swap the served sprite.
      if (allowImages && scene.vnMode && !scene.vnBodyUri && typeof scene.speakerId === "string" && scene.speakerId) {
        const vnNpcId = scene.speakerId.includes(":")
          ? scene.speakerId.split(":").slice(1).join(":")
          : scene.speakerId;
        enqueueVnBodyImageJob({ runId: run.runId, npcId: vnNpcId, style: engineStyleForRun(run) });
      }
      // Enemy fullbody cook: when a fight is live, mint each un-cooked enemy's battle
      // sprite from its bestiary row (non-blocking; the battle surface shows the
      // empty-state silhouette until it lands).
      if (allowImages && scene.combat && scene.combat.status === "active") {
        for (const e of Array.isArray(scene.combat.enemies) ? scene.combat.enemies : []) {
          if (e && e.npcId && !e.bodyUri) {
            enqueueEnemyBodyImageJob({ runId: run.runId, npcId: e.npcId, style: engineStyleForRun(run) });
          }
        }
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
      const style = engineStyleForRun(run);
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
        stream: true,
        deferMemory: true,
        transcript: { runId, callType: "opening" }
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
      // RATE LIMIT (anti-tamper item 2): run creation is an opening GM call.
      {
        const key = rateKeyFor(user, req);
        const verdict = newRunLimiter.check(key);
        if (!verdict.allowed) {
          emitRateLimited(res, writeJson, newRunLimiter, key, verdict, url.pathname);
          return true;
        }
      }
      enforceSessionEntitlement(req, user);
      const payload = await readJsonBody(req);
      const result = await createWorldOnboardingRun(user.id, {
        world: payload?.world || {},
        character: payload?.character || {},
        draftPortraitId: payload?.draftPortraitId || null,
        // D.5: an optional authored scenario (e.g. "the_shipment"). Campaign-mode
        // only; the loader gates it. Falls back to the INKBORNE_SCENARIO env flag.
        scenarioId: payload?.scenarioId || null,
        // Custom World flow: an owner-scoped user world id, loaded via the additive
        // user-world path in onboarding (getUserWorld is owner-scoped → isolation).
        userWorldId: payload?.userWorldId || null,
        // C.13: the solo "new adventure" IS the sandbox flow (see onboardingFlow.js
        // — the loctype picker was removed because sandbox defaults to forest-ruins;
        // modules/campaigns carry their own start). Default to sandbox so a pure
        // open world with ZERO authored objective is what real play creates (owner
        // decision a), and the sandbox-gated behavior (C.5 quarry suppression,
        // player-authored goals) is actually REACHABLE live instead of inert. A
        // module/campaign start passes an explicit mode to opt back into the spine.
        mode: payload?.mode || (payload?.userWorldId ? "campaign" : "sandbox")
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
      // IDENTITY-AS-STATE: an identity-class edit ("male", "she", "older") is a
      // FIELD change, not token soup — return the resolved identity so the client
      // COMMITS it onto the character (every later gen/redo then carries it).
      const parsedIdentity = parseIdentityEdit(instruction);
      const identity = (parsedIdentity.pronouns || parsedIdentity.ageClass)
        ? { pronouns: parsedIdentity.pronouns, gender: parsedIdentity.gender, ageClass: parsedIdentity.ageClass }
        : null;
      writeJson(res, 200, {
        ok: true,
        draftId,
        status: "generating",
        identity,
        consistentEdit: pollinationsEditConfigured(),
        entitlement: entitlementSummary(user, { byok })
      });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  // UPLOAD a draft portrait (the "I'll upload my own" onboarding path). The
  // player's file IS the portrait: it lands on disk in the standard draft layout
  // (assets/<draftId>/player/base.<ext>) so the existing disk-first plumbing does
  // the rest — getDraftPortrait() reports it generated, runDraftPortraitJob's
  // idempotency SKIPS generation for this draftId, and world-run's
  // copyDraftPortraitToRun carries it onto the run player. NO generation call
  // fires anywhere on this path. png/jpg/webp, 5MB cap (owner spec).
  if (req.method === "POST" && url.pathname === "/api/onboarding/portrait/upload") {
    try {
      const MAX_UPLOAD_PORTRAIT_BYTES = 5 * 1024 * 1024;
      const uploadUser = requireAuth(req);
      // RATE LIMIT (anti-tamper item 2): generation-class surface (Ink system
      // replaces this later; skeleton now).
      {
        const key = rateKeyFor(uploadUser, req);
        const verdict = generationLimiter.check(key);
        if (!verdict.allowed) {
          emitRateLimited(res, writeJson, generationLimiter, key, verdict, url.pathname);
          return true;
        }
      }
      // 1MB slack for the multipart envelope; the real cap applies to file bytes.
      const raw = await readRawBody(req, MAX_UPLOAD_PORTRAIT_BYTES + 1024 * 1024);
      const file = parseMultipartFile(raw, req.headers["content-type"]);
      if (!file || !file.data || file.data.length === 0) {
        throw Object.assign(new Error("No image file provided."), { code: "BAD_REQUEST", statusCode: 400 });
      }
      if (file.data.length > MAX_UPLOAD_PORTRAIT_BYTES) {
        throw Object.assign(new Error("Image exceeds the 5MB limit."), { code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
      }
      const ext = detectImageExt(file.data);
      if (!ext || !["png", "jpg", "jpeg", "webp"].includes(ext)) {
        throw Object.assign(new Error("Unsupported image type. Use PNG, JPG, or WEBP."), { code: "UNSUPPORTED_MEDIA_TYPE", statusCode: 415 });
      }
      // Server-minted draftId (never client-supplied — no path traversal).
      const draftId = `draft_upload_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const { uri } = writeUploadedBasePortrait(draftId, "player", ext, file.data);
      writeJson(res, 201, { ok: true, draftId, status: "generated", uri });
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

  // Library read path (art-plumbing item 3): resolve the curated "keep" art for
  // an in-game slot (world-select card / scene stage) — the client consults this
  // FIRST and keeps its static/generated fallback when the response uri is null.
  if (req.method === "GET" && url.pathname === "/api/art/library") {
    try {
      requireAuth(req);
      const world = url.searchParams.get("world") || "";
      const kind = url.searchParams.get("kind") || "world-card";
      const style = url.searchParams.get("style") || "";
      const uri = resolveLibraryArt({ world, kind, style: style || undefined });
      writeJson(res, 200, { ok: true, uri });
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

  // ── WORLD CREATOR (the Custom World flow) ──────────────────────────────────
  // All owner-scoped (requireAuth → user.id). Draft/twist call the flash utility tier
  // through the service (mockable in tests); save is deterministic compile + persist.
  if (url.pathname === "/api/worlds" && req.method === "GET") {
    try {
      const user = requireAuth(req);
      writeJson(res, 200, { ok: true, worlds: listWorldsForSelect(user.id) });
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname === "/api/worlds/draft" && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const result = await serviceDraft({ creationId: payload?.creationId || user.id, interview: payload?.interview || {} });
      writeJson(res, 200, result);
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname === "/api/worlds/twist" && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const result = await serviceTwist({
        creationId: payload?.creationId || user.id,
        cardType: payload?.cardType,
        card: payload?.card || {},
        instruction: payload?.instruction || "",
        context: payload?.context || {}
      });
      writeJson(res, 200, result);
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname === "/api/worlds/save" && req.method === "POST") {
    try {
      const user = requireAuth(req);
      const payload = await readJsonBody(req);
      const result = serviceSaveWorld({
        userId: user.id,
        creationId: payload?.creationId || user.id,
        draft: payload?.draft || payload?.review || {},
        interview: payload?.interview || {},
        overrides: payload?.overrides || {},
        art: payload?.art || null
      });
      if (!result.ok) {
        throw Object.assign(new Error("World could not be compiled from the draft."), {
          code: "INVALID_WORLD",
          statusCode: 400,
          validationErrors: result.errors
        });
      }
      writeJson(res, 200, result);
    } catch (error) {
      routeError(res, error);
    }
    return true;
  }

  if (url.pathname.startsWith("/api/worlds/") && req.method === "DELETE") {
    try {
      const user = requireAuth(req);
      const id = decodeURIComponent(url.pathname.slice("/api/worlds/".length)).replace(/\/+$/, "");
      const { ok } = serviceDeleteWorld(user.id, id);
      if (!ok) {
        throw Object.assign(new Error("World not found."), { code: "NOT_FOUND", statusCode: 404 });
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
  const reqStartedAt = Date.now();
  let loggedPath = null;
  try {
    if ((req.url || "").startsWith("/api/")) {
      loggedPath = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
      // BATTERY GUARD: a request tagged by a test harness (selfplay/e2e/smoke
      // send x-notdnd-battery) runs in a battery-scoped context so the AI layer
      // skips the subscription-bound codex lane even on a server whose own env
      // has that lane enabled. Everything else about the request is unchanged.
      const isBattery = Boolean(req.headers["x-notdnd-battery"]);
      const dispatch = async () => {
        const handled = await handleApi(req, res);
        if (!handled) {
          writeText(res, 404, "Not found");
        }
      };
      await (isBattery ? runWithBatteryContext(dispatch) : dispatch());
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
  } finally {
    // Request log (observability): one line per /api request with the final status
    // and the INBOUND identity. In `finally` so it runs even on the early return
    // and after routeError. Best-effort — resolveAuthUser/recordRequest never throw
    // into the response. Static/asset serving is excluded by shouldLogRequest.
    if (loggedPath && shouldLogRequest(loggedPath)) {
      let userId = null;
      let isGuest = false;
      try {
        const who = resolveAuthUser(req);
        if (who) {
          userId = who.id;
          isGuest = Boolean(who.isGuest);
        }
      } catch {
        // identity resolution is best-effort; log as anon on failure
      }
      recordRequest({
        method: req.method,
        path: loggedPath,
        status: res.statusCode,
        durationMs: Date.now() - reqStartedAt,
        userId,
        isGuest
      });
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

// ============================================================================
// ANTI-TAMPER BOOT GUARD (item 1): test hooks physically cannot reach the
// public. Evaluated BEFORE binding the port. No override flag exists — exposing
// hooks publicly requires editing this code, on purpose, visibly.
// ============================================================================
function isLoopbackHost(h) {
  const v = String(h || "").trim().toLowerCase();
  return v === "127.0.0.1" || v === "::1" || v === "localhost" || v === "[::1]";
}
const explicitHost = process.env.NOTDND_HOST || process.env.HOST || "";
const requestedHost = explicitHost || "0.0.0.0";
const bootUnsafe = testHooksEnabled() || String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";
const bootPublic = (explicitHost && !isLoopbackHost(explicitHost)) || String(process.env.INKBORNE_PUBLIC || "").trim().toLowerCase() === "true";
let host = requestedHost;
if (bootUnsafe && bootPublic) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "",
      "============================================================",
      "REFUSING TO BOOT — unsafe build on a public bind.",
      "Failed conditions:",
      `  - unsafe: ${testHooksEnabled() ? "test hooks ENABLED (NODE_ENV is not 'production' or NOTDND_TEST_HOOKS=true)" : `NODE_ENV='${process.env.NODE_ENV || ""}' (not 'production')`}`,
      `  - public: ${explicitHost && !isLoopbackHost(explicitHost) ? `bind host '${explicitHost}' is not loopback` : "INKBORNE_PUBLIC=true is set"}`,
      "Fix ONE of:",
      "  - run a production build: NODE_ENV=production (and unset NOTDND_TEST_HOOKS)",
      "  - bind loopback only: NOTDND_HOST=127.0.0.1 (and unset INKBORNE_PUBLIC)",
      "There is NO override flag. Exposing test hooks publicly requires a code",
      "edit in server/index.js — on purpose, visibly.",
      "============================================================",
      ""
    ].join("\n")
  );
  process.exit(1);
} else if (bootUnsafe) {
  // Dev case: unsafe build, no explicit public intent. If the host was the
  // IMPLICIT 0.0.0.0 default, downgrade the bind to loopback so hooks can never
  // be reached from off-box by accident; an explicit loopback host is honored.
  if (!explicitHost) {
    host = "127.0.0.1";
  }
  // eslint-disable-next-line no-console
  console.warn(`[SECURITY] test hooks ENABLED — dev-only build (bind ${host}; set NODE_ENV=production for a public build)`);
}
server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`Failed to start Notdnd server on ${host}:${port}:`, error.message || error);
  process.exit(1);
});

server.listen(port, host, () => {
  // Freeze the build identity to THIS process's boot (the loaded code), so the
  // badge reports what is running, not a request-time disk read (stale-process
  // trap, 2026-07-18). startedAt now marks the real bind, not the first request.
  const b = initBuildInfo();
  // Startup confirmation: makes a successful bind obvious vs. a server stuck in
  // an EADDRINUSE loop (where only [DB] prints and the port never binds).
  // eslint-disable-next-line no-console
  console.log(`[SERVER] Inkborne listening on port ${port} — build ${b.sha}${b.dirty ? " (dirty)" : ""} @ ${b.startedAt}`);

  // GM KEY PREFLIGHT (audit 5d548ac #1). A missing/placeholder key is LOUD at boot,
  // then confirmed by ONE cheap models-list ping (never a generation; skipped in mock
  // mode). The result rides /api/debug/status so the client can raise a banner —
  // never a silent 401 → template-prose degrade.
  gmKeyPreflight = gmKeyState();
  if (!gmKeyPreflight.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `\n  ┌──────────────────────────────────────────────────────────────┐\n` +
      `  │  ⚠  GM KEY MISSING — the AI GM will NOT run.                   │\n` +
      `  │  ${gmKeyPreflight.reason}\n` +
      `  │  Get a FREE key at https://openrouter.ai and set               │\n` +
      `  │  INKBORNE_LLM_API_KEY in .env, then restart.                   │\n` +
      `  └──────────────────────────────────────────────────────────────┘\n`
    );
  }
  verifyGmKey()
    .then((result) => {
      gmKeyPreflight = result;
      // eslint-disable-next-line no-console
      (result.ok ? console.log : console.error)(`[PREFLIGHT] GM key: ${result.reason}`);
    })
    .catch(() => { /* keep the synchronous state; never crash boot on a probe error */ });
});
