import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildQuickstartBlueprint } from "../campaign/quickstart.js";
import { ensureCampaignMemoryDocs } from "../gm/memoryStore.js";
import { formatRollSummary, resolveAttack, resolveSkillCheck, rollDiceExpression } from "../rules/engine.js";
import { uid } from "../utils/ids.js";
import { createSeedState } from "./seedState.js";

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), "server/db/notdnd.db.json");
const SESSION_TTL_SECONDS = Number(process.env.NOTDND_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
const PBKDF2_ITERATIONS = Number(process.env.NOTDND_PBKDF2_ITERATIONS || 210000);

const READ_ROLES = new Set(["owner", "gm", "editor", "player", "viewer"]);
const WRITE_ROLES = new Set(["owner", "gm", "editor"]);
const PLAY_ROLES = new Set(["owner", "gm", "editor", "player"]);
const MANAGE_MEMBER_ROLES = new Set(["owner", "gm"]);

function storePath() {
  return process.env.NOTDND_DB_PATH ? path.resolve(process.env.NOTDND_DB_PATH) : DEFAULT_STORE_PATH;
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function normalizeDisplayName(input, fallback = "Player") {
  const name = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  return name || fallback;
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isAdmin: Boolean(user.isAdmin),
    createdAt: user.createdAt
  };
}

function makeError(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex"), iterations = PBKDF2_ITERATIONS) {
  const derived = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return {
    salt,
    hash: derived,
    iterations
  };
}

function verifyPassword(password, passwordRecord) {
  if (!passwordRecord || !passwordRecord.hash || !passwordRecord.salt) {
    return false;
  }

  const derived = crypto
    .pbkdf2Sync(String(password), passwordRecord.salt, Number(passwordRecord.iterations) || PBKDF2_ITERATIONS, 32, "sha256")
    .toString("hex");

  const left = Buffer.from(derived, "hex");
  const right = Buffer.from(String(passwordRecord.hash), "hex");
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

let db = null;

function ensureDefaults(target) {
  target.stateVersion = Number(target.stateVersion || 0);
  target.campaignVersions = target.campaignVersions && typeof target.campaignVersions === "object" ? target.campaignVersions : {};

  target.users = Array.isArray(target.users) ? target.users : [];
  target.sessions = Array.isArray(target.sessions) ? target.sessions : [];
  target.userPrefsByUser = target.userPrefsByUser && typeof target.userPrefsByUser === "object" ? target.userPrefsByUser : {};
  target.campaignMembersByCampaign =
    target.campaignMembersByCampaign && typeof target.campaignMembersByCampaign === "object"
      ? target.campaignMembersByCampaign
      : {};
  target.journalsByCampaign =
    target.journalsByCampaign && typeof target.journalsByCampaign === "object" ? target.journalsByCampaign : {};
  target.revealedCellsByMap =
    target.revealedCellsByMap && typeof target.revealedCellsByMap === "object" ? target.revealedCellsByMap : {};
  target.recentRollsByCampaign =
    target.recentRollsByCampaign && typeof target.recentRollsByCampaign === "object" ? target.recentRollsByCampaign : {};
  target.campaignPackagesByCampaign =
    target.campaignPackagesByCampaign && typeof target.campaignPackagesByCampaign === "object"
      ? target.campaignPackagesByCampaign
      : {};

  target.selectedCampaignId = target.selectedCampaignId || target.campaigns?.[0]?.id || null;

  target.campaigns = Array.isArray(target.campaigns) ? target.campaigns : [];
  target.books = Array.isArray(target.books) ? target.books : [];
  target.characters = Array.isArray(target.characters) ? target.characters : [];
  target.encounters = Array.isArray(target.encounters) ? target.encounters : [];
  target.maps = Array.isArray(target.maps) ? target.maps : [];
  target.tokensByMap = target.tokensByMap && typeof target.tokensByMap === "object" ? target.tokensByMap : {};
  target.initiative = Array.isArray(target.initiative) ? target.initiative : [];
  target.chatLog = Array.isArray(target.chatLog) ? target.chatLog : [];
  target.aiJobs = Array.isArray(target.aiJobs) ? target.aiJobs : [];
  target.gmSettingsByCampaign =
    target.gmSettingsByCampaign && typeof target.gmSettingsByCampaign === "object" ? target.gmSettingsByCampaign : {};
}

function loadFromDisk() {
  ensureStoreDir();
  if (!fs.existsSync(storePath())) {
    return null;
  }

  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeToDisk() {
  ensureStoreDir();
  fs.writeFileSync(storePath(), JSON.stringify(db, null, 2), "utf8");
}

function getUserById(userId) {
  return db.users.find((entry) => entry.id === userId) || null;
}

function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return db.users.find((entry) => entry.email === normalized) || null;
}

function userRoleForCampaign(userId, campaignId) {
  const members = db.campaignMembersByCampaign[campaignId] || [];
  const membership = members.find((entry) => entry.userId === userId);
  return membership?.role || null;
}

function campaignIdsForUser(userId) {
  const ids = [];
  for (const [campaignId, members] of Object.entries(db.campaignMembersByCampaign)) {
    if ((members || []).some((entry) => entry.userId === userId)) {
      ids.push(campaignId);
    }
  }
  return ids;
}

function assertCanReadCampaign(userId, campaignId) {
  const role = userRoleForCampaign(userId, campaignId);
  if (!role || !READ_ROLES.has(role)) {
    throw makeError("FORBIDDEN", "User does not have read access to this campaign.", 403);
  }
}

function assertCanWriteCampaign(userId, campaignId) {
  const role = userRoleForCampaign(userId, campaignId);
  if (!role || !WRITE_ROLES.has(role)) {
    throw makeError("FORBIDDEN", "User does not have write access to this campaign.", 403);
  }
}

function assertCanPlayCampaign(userId, campaignId) {
  const role = userRoleForCampaign(userId, campaignId);
  if (!role || !PLAY_ROLES.has(role)) {
    throw makeError("FORBIDDEN", "User does not have play access to this campaign.", 403);
  }
}

function assertCanManageMembers(userId, campaignId) {
  const role = userRoleForCampaign(userId, campaignId);
  if (!role || !MANAGE_MEMBER_ROLES.has(role)) {
    throw makeError("FORBIDDEN", "User does not have member-management access.", 403);
  }
}

function selectedCampaignIdForUser(userId, visibleCampaignIds = null) {
  const visible = visibleCampaignIds || campaignIdsForUser(userId);
  if (visible.length === 0) {
    return null;
  }

  const pref = db.userPrefsByUser[userId]?.selectedCampaignId;
  if (pref && visible.includes(pref)) {
    return pref;
  }

  return visible[0];
}

function selectedCampaignId(payload = {}, actorUserId = null, context = {}) {
  const raw = payload.campaignId;
  if (raw) {
    return raw;
  }

  if (actorUserId) {
    return selectedCampaignIdForUser(actorUserId);
  }

  if (context.internal) {
    return db.selectedCampaignId;
  }

  return null;
}

function bumpStateVersion(campaignId = null) {
  db.stateVersion = Number(db.stateVersion || 0) + 1;
  if (campaignId) {
    db.campaignVersions[campaignId] = Number(db.campaignVersions[campaignId] || 0) + 1;
  }
}

function ensureCampaignVersionSlot(campaignId) {
  if (!db.campaignVersions[campaignId]) {
    db.campaignVersions[campaignId] = 0;
  }
}

function pruneExpiredSessions() {
  const now = nowEpochSec();
  db.sessions = db.sessions.filter((session) => Number(session.expiresAt || 0) > now);
}

function createSessionForUser(userId) {
  const token = newSessionToken();
  const now = nowEpochSec();
  db.sessions.push({
    id: uid("sess"),
    userId,
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
    lastSeenAt: now
  });
  return token;
}

function bootstrapAdminAndMemberships() {
  if (db.users.length === 0) {
    const bootstrapEmail = normalizeEmail(process.env.NOTDND_BOOTSTRAP_EMAIL || "demo@notdnd.local");
    const bootstrapPassword = String(process.env.NOTDND_BOOTSTRAP_PASSWORD || "demo1234");
    const bootstrapDisplayName = normalizeDisplayName(process.env.NOTDND_BOOTSTRAP_DISPLAY_NAME || "Demo GM", "Demo GM");
    const passwordRecord = hashPassword(bootstrapPassword);

    db.users.push({
      id: uid("usr"),
      email: bootstrapEmail,
      displayName: bootstrapDisplayName,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      passwordIterations: passwordRecord.iterations,
      isAdmin: true,
      createdAt: nowEpochSec()
    });
  }

  const adminUser = db.users[0];
  for (const campaign of db.campaigns) {
    if (!db.campaignMembersByCampaign[campaign.id]) {
      db.campaignMembersByCampaign[campaign.id] = [];
    }
    const hasOwner = db.campaignMembersByCampaign[campaign.id].some((entry) => entry.userId === adminUser.id);
    if (!hasOwner) {
      db.campaignMembersByCampaign[campaign.id].push({
        userId: adminUser.id,
        role: "owner",
        addedAt: nowEpochSec()
      });
    }
    ensureCampaignVersionSlot(campaign.id);
    db.journalsByCampaign[campaign.id] = db.journalsByCampaign[campaign.id] || [];
    db.recentRollsByCampaign[campaign.id] = db.recentRollsByCampaign[campaign.id] || [];
    db.campaignPackagesByCampaign[campaign.id] = db.campaignPackagesByCampaign[campaign.id] || {
      campaignId: campaign.id,
      chapters: [],
      scenes: [],
      npcs: [],
      items: [],
      spells: [],
      rules: [],
      starterOptions: []
    };
    ensureCampaignMemoryDocs(campaign.id);
  }

  for (const map of db.maps) {
    db.revealedCellsByMap[map.id] = db.revealedCellsByMap[map.id] || {};
  }

  if (adminUser && !db.userPrefsByUser[adminUser.id]) {
    db.userPrefsByUser[adminUser.id] = {
      selectedCampaignId: db.selectedCampaignId || db.campaigns[0]?.id || null
    };
  }
}

function ensureDb() {
  if (!db) {
    db = loadFromDisk() || createSeedState();
    ensureDefaults(db);
    bootstrapAdminAndMemberships();
    writeToDisk();
    return;
  }

  ensureDefaults(db);
  pruneExpiredSessions();
}

function assertActor(context = {}) {
  if (context.internal) {
    return;
  }
  if (!context.actorUserId) {
    throw makeError("UNAUTHORIZED", "Authentication required.", 401);
  }
}

function assertExpectedVersion(context = {}) {
  if (context.internal) {
    return;
  }

  if (context.expectedVersion === undefined || context.expectedVersion === null) {
    return;
  }

  const expected = Number(context.expectedVersion);
  if (!Number.isFinite(expected)) {
    throw makeError("BAD_REQUEST", "expectedVersion must be a number.", 400);
  }

  if (expected !== Number(db.stateVersion || 0)) {
    throw makeError("VERSION_CONFLICT", "State version conflict.", 409, {
      expectedVersion: expected,
      currentVersion: Number(db.stateVersion || 0)
    });
  }
}

function appendChatLine(campaignId, speaker, text) {
  db.chatLog.push({
    id: uid("chat"),
    campaignId,
    speaker,
    text,
    createdAt: nowEpochSec()
  });
}

function appendRecentRoll(campaignId, rollRecord) {
  if (!db.recentRollsByCampaign[campaignId]) {
    db.recentRollsByCampaign[campaignId] = [];
  }
  db.recentRollsByCampaign[campaignId].unshift(rollRecord);
  db.recentRollsByCampaign[campaignId] = db.recentRollsByCampaign[campaignId].slice(0, 40);
}

function upsertHomebrewBook(book) {
  const normalizedTitle = String(book.title || "").toLowerCase();
  const existing = db.books.find((entry) => String(entry.title || "").toLowerCase() === normalizedTitle);
  if (existing) {
    return existing.id;
  }

  const id = uid("book");
  db.books.unshift({
    id,
    title: book.title || "Imported Homebrew",
    type: book.type || "Homebrew",
    tags: book.tags || [],
    chapters: book.chapters || [],
    createdAt: nowEpochSec()
  });
  return id;
}

function applyCampaignMembership(campaignId, userId, role) {
  if (!db.campaignMembersByCampaign[campaignId]) {
    db.campaignMembersByCampaign[campaignId] = [];
  }

  const existing = db.campaignMembersByCampaign[campaignId].find((entry) => entry.userId === userId);
  if (existing) {
    existing.role = role;
    return;
  }

  db.campaignMembersByCampaign[campaignId].push({
    userId,
    role,
    addedAt: nowEpochSec()
  });
}

function stateForUser(userId = null) {
  const hasUser = Boolean(userId);
  const visibleCampaignIds = hasUser ? campaignIdsForUser(userId) : db.campaigns.map((entry) => entry.id);
  const visibleSet = new Set(visibleCampaignIds);

  const campaigns = db.campaigns.filter((campaign) => visibleSet.has(campaign.id));
  const selectedId = hasUser ? selectedCampaignIdForUser(userId, visibleCampaignIds) : db.selectedCampaignId;

  const maps = db.maps.filter((map) => visibleSet.has(map.campaignId));
  const mapIdSet = new Set(maps.map((map) => map.id));
  const tokensByMap = {};
  const revealedCellsByMap = {};
  for (const [mapId, tokens] of Object.entries(db.tokensByMap)) {
    if (mapIdSet.has(mapId)) {
      tokensByMap[mapId] = tokens;
    }
  }
  for (const [mapId, revealed] of Object.entries(db.revealedCellsByMap || {})) {
    if (mapIdSet.has(mapId)) {
      revealedCellsByMap[mapId] = revealed;
    }
  }

  const journalsByCampaign = {};
  for (const campaignId of visibleCampaignIds) {
    const role = hasUser ? userRoleForCampaign(userId, campaignId) : "owner";
    const entries = db.journalsByCampaign?.[campaignId] || [];
    journalsByCampaign[campaignId] = entries.filter((entry) => {
      if (entry.visibility !== "gm") {
        return true;
      }
      return role === "owner" || role === "gm" || role === "editor";
    });
  }

  const recentRollsByCampaign = {};
  for (const campaignId of visibleCampaignIds) {
    recentRollsByCampaign[campaignId] = db.recentRollsByCampaign?.[campaignId] || [];
  }

  const gmSettings =
    db.gmSettingsByCampaign?.[selectedId] || {
      gmName: "Narrator Prime",
      gmStyle: "Cinematic Tactical",
      safetyProfile: "Table-Friendly",
      primaryRulebook: "Core Rules SRD",
      gmMode: "human",
      agentProvider: "local",
      agentModel: "local-gm-v1"
    };

  const campaignVersions = {};
  const campaignPackagesByCampaign = {};
  for (const campaignId of visibleCampaignIds) {
    campaignVersions[campaignId] = Number(db.campaignVersions[campaignId] || 0);
    campaignPackagesByCampaign[campaignId] = db.campaignPackagesByCampaign?.[campaignId] || {
      campaignId,
      chapters: [],
      scenes: [],
      npcs: [],
      items: [],
      spells: [],
      rules: [],
      starterOptions: []
    };
  }

  return {
    campaigns: deepClone(campaigns),
    selectedCampaignId: selectedId,
    books: deepClone(db.books),
    characters: deepClone(db.characters.filter((entry) => visibleSet.has(entry.campaignId))),
    encounters: deepClone(db.encounters.filter((entry) => visibleSet.has(entry.campaignId))),
    maps: deepClone(maps),
    tokensByMap: deepClone(tokensByMap),
    revealedCellsByMap: deepClone(revealedCellsByMap),
    initiative: deepClone(db.initiative.filter((entry) => visibleSet.has(entry.campaignId))),
    chatLog: deepClone(db.chatLog.filter((entry) => visibleSet.has(entry.campaignId))),
    aiJobs: deepClone(db.aiJobs.filter((entry) => visibleSet.has(entry.campaignId))),
    journalsByCampaign: deepClone(journalsByCampaign),
    recentRollsByCampaign: deepClone(recentRollsByCampaign),
    campaignPackagesByCampaign: deepClone(campaignPackagesByCampaign),
    gmSettings: deepClone(gmSettings),
    stateVersion: Number(db.stateVersion || 0),
    campaignVersions,
    auth: {
      user: sanitizeUser(getUserById(userId))
    }
  };
}

function campaignIdFromMapId(mapId) {
  const map = db.maps.find((entry) => entry.id === mapId);
  return map?.campaignId || null;
}

export function resolveStorePath() {
  return storePath();
}

export function initializeDatabase() {
  ensureDb();
  writeToDisk();
}

export function resetDatabase() {
  ensureDb();
  const existingUsers = deepClone(db.users);
  db = createSeedState();
  ensureDefaults(db);

  db.users = existingUsers.length > 0 ? existingUsers : [];
  db.sessions = [];
  db.userPrefsByUser = {};
  db.campaignMembersByCampaign = {};
  db.campaignVersions = {};
  db.stateVersion = 0;

  bootstrapAdminAndMemberships();
  writeToDisk();
}

export function getState(options = {}) {
  ensureDb();
  const userId = options?.userId || null;
  return stateForUser(userId);
}

export function getAiJobById(jobId) {
  ensureDb();
  const found = db.aiJobs.find((job) => job.id === jobId);
  return found ? deepClone(found) : null;
}

export function updateAiJobStatus({ jobId, status, result, providerName, modelValue }) {
  ensureDb();
  const job = db.aiJobs.find((entry) => entry.id === jobId);
  if (!job) {
    return;
  }

  job.status = status;
  job.updatedAt = nowEpochSec();
  if (result !== undefined) {
    job.result = result;
  }
  if (providerName !== undefined) {
    job.providerName = providerName;
  }
  if (modelValue !== undefined) {
    job.modelValue = modelValue;
  }

  bumpStateVersion(job.campaignId);
  writeToDisk();
}

export function registerUser({ email, password, displayName }) {
  ensureDb();

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw makeError("BAD_REQUEST", "Valid email is required.", 400);
  }
  if (String(password || "").length < 8) {
    throw makeError("BAD_REQUEST", "Password must be at least 8 characters.", 400);
  }
  if (getUserByEmail(normalizedEmail)) {
    throw makeError("CONFLICT", "Email already registered.", 409);
  }

  const passwordRecord = hashPassword(password);
  const user = {
    id: uid("usr"),
    email: normalizedEmail,
    displayName: normalizeDisplayName(displayName, normalizedEmail.split("@")[0]),
    passwordHash: passwordRecord.hash,
    passwordSalt: passwordRecord.salt,
    passwordIterations: passwordRecord.iterations,
    isAdmin: false,
    createdAt: nowEpochSec()
  };

  db.users.push(user);
  db.userPrefsByUser[user.id] = { selectedCampaignId: null };

  const token = createSessionForUser(user.id);
  writeToDisk();

  return {
    user: sanitizeUser(user),
    token,
    expiresIn: SESSION_TTL_SECONDS
  };
}

export function loginUser({ email, password }) {
  ensureDb();
  pruneExpiredSessions();

  const user = getUserByEmail(email);
  if (!user) {
    throw makeError("UNAUTHORIZED", "Invalid email or password.", 401);
  }

  const ok = verifyPassword(password, {
    hash: user.passwordHash,
    salt: user.passwordSalt,
    iterations: user.passwordIterations
  });
  if (!ok) {
    throw makeError("UNAUTHORIZED", "Invalid email or password.", 401);
  }

  const token = createSessionForUser(user.id);
  writeToDisk();

  return {
    user: sanitizeUser(user),
    token,
    expiresIn: SESSION_TTL_SECONDS
  };
}

export function logoutSessionToken(token) {
  ensureDb();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => session.token !== token);
  const changed = db.sessions.length !== before;
  if (changed) {
    writeToDisk();
  }
  return changed;
}

export function getUserBySessionToken(token) {
  ensureDb();
  pruneExpiredSessions();

  if (!token) {
    return null;
  }

  const session = db.sessions.find((entry) => entry.token === token);
  if (!session) {
    return null;
  }

  if (Number(session.expiresAt) <= nowEpochSec()) {
    db.sessions = db.sessions.filter((entry) => entry.token !== token);
    writeToDisk();
    return null;
  }

  session.lastSeenAt = nowEpochSec();
  const user = getUserById(session.userId);
  if (!user) {
    return null;
  }

  return sanitizeUser(user);
}

export function listCampaignMembers(campaignId, context = {}) {
  ensureDb();
  assertActor(context);
  assertCanReadCampaign(context.actorUserId, campaignId);

  const members = db.campaignMembersByCampaign[campaignId] || [];
  return members
    .map((member) => ({
      role: member.role,
      addedAt: member.addedAt,
      user: sanitizeUser(getUserById(member.userId))
    }))
    .filter((entry) => entry.user);
}

export function addCampaignMember({ campaignId, email, role }, context = {}) {
  ensureDb();
  assertActor(context);
  assertCanManageMembers(context.actorUserId, campaignId);

  const normalizedRole = String(role || "viewer").toLowerCase();
  if (!READ_ROLES.has(normalizedRole)) {
    throw makeError("BAD_REQUEST", "Invalid role.", 400);
  }

  const user = getUserByEmail(email);
  if (!user) {
    throw makeError("NOT_FOUND", "User with that email does not exist.", 404);
  }

  applyCampaignMembership(campaignId, user.id, normalizedRole);
  bumpStateVersion(campaignId);
  writeToDisk();

  return {
    campaignId,
    role: normalizedRole,
    user: sanitizeUser(user)
  };
}

export function createQuickstartCampaignFromParsed({
  campaignName,
  setting,
  players,
  parsed,
  actorUserId = null
}) {
  ensureDb();

  if (actorUserId) {
    assertActor({ actorUserId });
  }

  const blueprint = buildQuickstartBlueprint({
    campaignName,
    setting,
    players,
    parsed
  });

  const sourceBookIds = [];
  for (const book of blueprint.books) {
    sourceBookIds.push(upsertHomebrewBook(book));
  }

  const campaign = {
    ...blueprint.campaign,
    sourceBooks: sourceBookIds,
    createdAt: nowEpochSec()
  };

  db.campaigns.unshift(campaign);
  db.selectedCampaignId = campaign.id;
  ensureCampaignVersionSlot(campaign.id);
  ensureCampaignMemoryDocs(campaign.id, blueprint.memoryDocs || {});

  if (actorUserId) {
    applyCampaignMembership(campaign.id, actorUserId, "owner");
    db.userPrefsByUser[actorUserId] = { selectedCampaignId: campaign.id };
  } else if (db.users[0]) {
    applyCampaignMembership(campaign.id, db.users[0].id, "owner");
  }

  db.characters = [...blueprint.characters.map((entry) => ({ ...entry, createdAt: nowEpochSec() })), ...db.characters];
  db.encounters = [...blueprint.encounters.map((entry) => ({ ...entry, createdAt: nowEpochSec() })), ...db.encounters];
  db.maps = [...blueprint.maps.map((entry) => ({ ...entry, createdAt: nowEpochSec() })), ...db.maps];
  for (const map of blueprint.maps) {
    db.tokensByMap[map.id] = blueprint.tokensByMap[map.id] || [];
    db.revealedCellsByMap[map.id] = db.revealedCellsByMap[map.id] || {};
  }
  db.initiative.push(...blueprint.initiative.map((turn) => ({ ...turn, createdAt: nowEpochSec() })));
  db.journalsByCampaign[campaign.id] = [
    ...(blueprint.journals || []).map((entry) => ({
      ...entry,
      authorUserId: actorUserId,
      createdAt: nowEpochSec(),
      updatedAt: nowEpochSec()
    })),
    ...(db.journalsByCampaign[campaign.id] || [])
  ];
  db.recentRollsByCampaign[campaign.id] = db.recentRollsByCampaign[campaign.id] || [];
  db.campaignPackagesByCampaign[campaign.id] = blueprint.campaignPackage || {
    campaignId: campaign.id,
    chapters: [],
    scenes: [],
    npcs: [],
    items: [],
    spells: [],
    rules: [],
    starterOptions: []
  };

  db.gmSettingsByCampaign[campaign.id] = {
    ...blueprint.gmSettings,
    updatedAt: nowEpochSec()
  };

  for (const line of blueprint.chatLines) {
    appendChatLine(campaign.id, line.speaker, line.text);
  }
  appendChatLine(campaign.id, "System", "VTT room launched with party sheets, tokens, and initiative preloaded.");

  bumpStateVersion(campaign.id);
  writeToDisk();

  return {
    campaignId: campaign.id,
    mapId: blueprint.maps[0]?.id || null,
    encounterId: blueprint.encounters[0]?.id || null,
    parsedSummary: blueprint.parsedSummary
  };
}

export function getMetrics() {
  ensureDb();
  return {
    stateVersion: Number(db.stateVersion || 0),
    campaigns: db.campaigns.length,
    users: db.users.length,
    sessions: db.sessions.length,
    books: db.books.length,
    characters: db.characters.length,
    aiJobs: db.aiJobs.length,
    journals: Object.values(db.journalsByCampaign || {}).reduce((sum, items) => sum + (items?.length || 0), 0),
    recentRolls: Object.values(db.recentRollsByCampaign || {}).reduce((sum, items) => sum + (items?.length || 0), 0),
    packages: Object.keys(db.campaignPackagesByCampaign || {}).length,
    activeConnectionsEstimate: 0
  };
}

export function getCurrentStateVersion() {
  ensureDb();
  return Number(db.stateVersion || 0);
}

export function applyOperation(op, payload = {}, context = {}) {
  ensureDb();
  assertActor(context);
  assertExpectedVersion(context);

  const actorUserId = context.actorUserId || null;

  switch (op) {
    case "reset_all": {
      const actor = getUserById(actorUserId);
      if (!actor?.isAdmin && !context.internal) {
        throw makeError("FORBIDDEN", "Admin access required for reset_all.", 403);
      }
      resetDatabase();
      return { ok: true };
    }

    case "select_campaign": {
      if (!payload.campaignId) {
        throw makeError("BAD_REQUEST", "campaignId is required", 400);
      }
      assertCanReadCampaign(actorUserId, payload.campaignId);
      db.userPrefsByUser[actorUserId] = { selectedCampaignId: payload.campaignId };
      bumpStateVersion(payload.campaignId);
      writeToDisk();
      return { campaignId: payload.campaignId };
    }

    case "create_campaign": {
      const id = payload.id || uid("cmp");
      const campaign = {
        id,
        name: payload.name || "Unnamed Campaign",
        setting: payload.setting || "Unknown Setting",
        status: payload.status || "Prep",
        readiness: Number(payload.readiness) || 35,
        sessionCount: Number(payload.sessionCount) || 0,
        players: payload.players || [],
        sourceBooks: payload.sourceBooks || payload.bookIds || [],
        activeMapId: payload.activeMapId || null,
        activeEncounterId: payload.activeEncounterId || null,
        createdAt: nowEpochSec()
      };

      db.campaigns.unshift(campaign);
      db.selectedCampaignId = id;
      ensureCampaignVersionSlot(id);
      applyCampaignMembership(id, actorUserId, "owner");
      db.userPrefsByUser[actorUserId] = { selectedCampaignId: id };

      db.gmSettingsByCampaign[id] = {
        gmName: "Narrator Prime",
        gmStyle: "Cinematic Tactical",
        safetyProfile: "Table-Friendly",
        primaryRulebook: "Core Rules SRD",
        gmMode: "human",
        agentProvider: "local",
        agentModel: "local-gm-v1",
        updatedAt: nowEpochSec()
      };
      db.journalsByCampaign[id] = db.journalsByCampaign[id] || [];
      db.recentRollsByCampaign[id] = db.recentRollsByCampaign[id] || [];
      db.campaignPackagesByCampaign[id] = db.campaignPackagesByCampaign[id] || {
        campaignId: id,
        chapters: [],
        scenes: [],
        npcs: [],
        items: [],
        spells: [],
        rules: [],
        starterOptions: []
      };
      ensureCampaignMemoryDocs(id);

      bumpStateVersion(id);
      writeToDisk();
      return { id };
    }

    case "increment_campaign_readiness": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      const amount = Number(payload.amount) || 0;
      db.campaigns = db.campaigns.map((campaign) =>
        campaign.id === campaignId
          ? { ...campaign, readiness: Math.max(0, Math.min(100, Number(campaign.readiness || 0) + amount)) }
          : campaign
      );

      bumpStateVersion(campaignId);
      writeToDisk();
      return { campaignId };
    }

    case "set_active_map": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      const mapId = String(payload.mapId || "");
      if (!campaignId || !mapId) {
        throw makeError("BAD_REQUEST", "campaignId and mapId are required.", 400);
      }
      assertCanReadCampaign(actorUserId, campaignId);
      const map = db.maps.find((entry) => entry.id === mapId && entry.campaignId === campaignId);
      if (!map) {
        throw makeError("NOT_FOUND", "Map not found for campaign.", 404);
      }

      db.campaigns = db.campaigns.map((campaign) =>
        campaign.id === campaignId
          ? {
              ...campaign,
              activeMapId: mapId
            }
          : campaign
      );

      bumpStateVersion(campaignId);
      writeToDisk();
      return { campaignId, mapId };
    }

    case "add_book": {
      const id = payload.id || uid("book");
      db.books.unshift({
        id,
        title: payload.title || "Untitled Book",
        type: payload.type || "Homebrew",
        tags: payload.tags || [],
        chapters: payload.chapters || [],
        createdAt: nowEpochSec()
      });
      bumpStateVersion();
      writeToDisk();
      return { id };
    }

    case "add_character": {
      const id = payload.id || uid("char");
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      db.characters.unshift({
        id,
        campaignId,
        name: payload.name || "Unnamed",
        className: payload.className || "Class",
        level: Number(payload.level) || 1,
        ac: Number(payload.ac) || 10,
        hp: Number(payload.hp) || 8,
        speed: Number(payload.speed) || 30,
        stats: payload.stats || {},
        proficiencies: payload.proficiencies || [],
        spells: payload.spells || [],
        inventory: payload.inventory || [],
        createdAt: nowEpochSec()
      });

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "add_encounter": {
      const id = payload.id || uid("enc");
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      db.encounters.unshift({
        id,
        campaignId,
        name: payload.name || "Untitled Encounter",
        difficulty: payload.difficulty || "Medium",
        monsters: payload.monsters || [],
        xpBudget: Number(payload.xpBudget) || 0,
        createdAt: nowEpochSec()
      });

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "set_token_position": {
      const mapId = payload.mapId;
      const tokenId = payload.tokenId;
      if (!mapId || !tokenId) {
        throw makeError("BAD_REQUEST", "mapId and tokenId are required", 400);
      }

      const campaignId = campaignIdFromMapId(mapId);
      if (!campaignId) {
        throw makeError("NOT_FOUND", "Map not found", 404);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      const tokens = db.tokensByMap[mapId] || [];
      db.tokensByMap[mapId] = tokens.map((token) =>
        token.id === tokenId ? { ...token, x: Number(payload.x) || 0, y: Number(payload.y) || 0 } : token
      );

      bumpStateVersion(campaignId);
      writeToDisk();
      return { mapId, tokenId };
    }

    case "add_initiative_turn": {
      const id = payload.id || uid("init");
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      db.initiative.push({
        id,
        campaignId,
        name: payload.name || "Unit",
        value: Number(payload.value) || 10,
        createdAt: nowEpochSec()
      });

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "push_chat_line": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      if (!context.internal) {
        assertCanPlayCampaign(actorUserId, campaignId);
      }

      const id = payload.id || uid("chat");
      db.chatLog.push({
        id,
        campaignId,
        speaker: payload.speaker || "System",
        text: payload.text || "",
        createdAt: nowEpochSec()
      });

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "roll_dice": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      const expression = String(payload.expression || "1d20").trim();
      const label = String(payload.label || "Roll").trim();
      const roll = rollDiceExpression(expression);

      const record = {
        id: uid("roll"),
        campaignId,
        type: "dice",
        label,
        actor: payload.actor || getUserById(actorUserId)?.displayName || "Player",
        expression,
        total: roll.total,
        detail: roll.terms,
        createdAt: nowEpochSec()
      };

      appendRecentRoll(campaignId, record);
      appendChatLine(campaignId, record.actor, `${label}: ${formatRollSummary(roll)}`);

      bumpStateVersion(campaignId);
      writeToDisk();
      return { roll: record };
    }

    case "resolve_attack": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      const attack = resolveAttack({
        attacker: payload.attacker || getUserById(actorUserId)?.displayName || "Attacker",
        target: payload.target || "Target",
        attackExpression: payload.attackExpression || "1d20+5",
        targetAc: payload.targetAc || 12,
        damageExpression: payload.damageExpression || "1d8+3",
        damageType: payload.damageType || "slashing"
      });

      const record = {
        id: uid("roll"),
        campaignId,
        type: "attack",
        label: `${attack.attacker} -> ${attack.target}`,
        actor: attack.attacker,
        expression: attack.toHit.expression,
        total: attack.toHit.total,
        detail: attack,
        createdAt: nowEpochSec()
      };

      appendRecentRoll(campaignId, record);

      const damageText = attack.hit && attack.damage ? ` for ${attack.damage.total} ${attack.damageType}` : "";
      appendChatLine(
        campaignId,
        attack.attacker,
        `${attack.attacker} attacks ${attack.target}: ${attack.toHit.total} vs AC ${attack.targetAc} (${attack.hit ? "HIT" : "MISS"})${damageText}`
      );

      bumpStateVersion(campaignId);
      writeToDisk();
      return { attack: record };
    }

    case "resolve_skill_check": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      const check = resolveSkillCheck({
        expression: payload.expression || "1d20",
        dc: payload.dc || 10,
        label: payload.label || "Skill Check"
      });

      const record = {
        id: uid("roll"),
        campaignId,
        type: "skill_check",
        label: check.label,
        actor: payload.actor || getUserById(actorUserId)?.displayName || "Player",
        expression: check.roll.expression,
        total: check.roll.total,
        detail: check,
        createdAt: nowEpochSec()
      };

      appendRecentRoll(campaignId, record);
      appendChatLine(
        campaignId,
        record.actor,
        `${record.label}: ${check.roll.total} vs DC ${check.dc} (${check.success ? "SUCCESS" : "FAIL"})`
      );

      bumpStateVersion(campaignId);
      writeToDisk();
      return { check: record };
    }

    case "queue_ai_job": {
      const id = payload.id || uid("job");
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      db.aiJobs.unshift({
        id,
        campaignId,
        type: payload.type || "gm",
        prompt: payload.prompt || "",
        status: payload.status || "Queued",
        providerName: payload.providerName,
        modelValue: payload.modelValue,
        result: payload.result || null,
        createdAt: nowEpochSec(),
        updatedAt: nowEpochSec()
      });

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "set_ai_job_status": {
      if (!payload.jobId) {
        throw makeError("BAD_REQUEST", "jobId is required", 400);
      }

      const job = db.aiJobs.find((entry) => entry.id === payload.jobId);
      if (!job) {
        throw makeError("NOT_FOUND", "AI job not found", 404);
      }

      if (!context.internal) {
        assertCanWriteCampaign(actorUserId, job.campaignId);
      }

      updateAiJobStatus({
        jobId: payload.jobId,
        status: payload.status || "Queued",
        result: payload.result,
        providerName: payload.providerName,
        modelValue: payload.modelValue
      });
      return { jobId: payload.jobId };
    }

    case "set_gm_settings": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      db.gmSettingsByCampaign[campaignId] = {
        gmName: payload.gmName || "Narrator Prime",
        gmStyle: payload.gmStyle || "Cinematic Tactical",
        safetyProfile: payload.safetyProfile || "Table-Friendly",
        primaryRulebook: payload.primaryRulebook || "Core Rules SRD",
        gmMode: payload.gmMode === "agent" ? "agent" : "human",
        agentProvider: payload.agentProvider || "local",
        agentModel: payload.agentModel || "local-gm-v1",
        updatedAt: nowEpochSec()
      };

      bumpStateVersion(campaignId);
      writeToDisk();
      return { campaignId };
    }

    case "upsert_map": {
      const id = payload.id || uid("map");
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      const existing = db.maps.find((map) => map.id === id);
      if (existing) {
        db.maps = db.maps.map((map) =>
          map.id === id
            ? {
                ...map,
                name: payload.name || map.name,
                width: Number(payload.width) || map.width,
                height: Number(payload.height) || map.height,
                fogEnabled: payload.fogEnabled !== undefined ? Boolean(payload.fogEnabled) : map.fogEnabled,
                dynamicLighting:
                  payload.dynamicLighting !== undefined ? Boolean(payload.dynamicLighting) : map.dynamicLighting,
                imageUrl: payload.imageUrl !== undefined ? String(payload.imageUrl || "").trim() : map.imageUrl || ""
              }
            : map
        );
      } else {
        db.maps.unshift({
          id,
          campaignId,
          name: payload.name || "Untitled Map",
          width: Number(payload.width) || 10,
          height: Number(payload.height) || 10,
          fogEnabled: Boolean(payload.fogEnabled),
          dynamicLighting: Boolean(payload.dynamicLighting),
          imageUrl: String(payload.imageUrl || "").trim(),
          createdAt: nowEpochSec()
        });
      }

      db.revealedCellsByMap[id] = db.revealedCellsByMap[id] || {};

      bumpStateVersion(campaignId);
      writeToDisk();
      return { id };
    }

    case "toggle_fog_cell": {
      const mapId = payload.mapId;
      if (!mapId) {
        throw makeError("BAD_REQUEST", "mapId is required", 400);
      }

      const campaignId = campaignIdFromMapId(mapId);
      if (!campaignId) {
        throw makeError("NOT_FOUND", "Map not found", 404);
      }
      assertCanWriteCampaign(actorUserId, campaignId);

      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw makeError("BAD_REQUEST", "x and y are required", 400);
      }

      if (!db.revealedCellsByMap[mapId]) {
        db.revealedCellsByMap[mapId] = {};
      }

      const key = `${x},${y}`;
      const nextValue = payload.revealed !== undefined ? Boolean(payload.revealed) : !Boolean(db.revealedCellsByMap[mapId][key]);
      db.revealedCellsByMap[mapId][key] = nextValue;

      bumpStateVersion(campaignId);
      writeToDisk();
      return { mapId, x, y, revealed: nextValue };
    }

    case "add_journal_entry": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      if (!db.journalsByCampaign[campaignId]) {
        db.journalsByCampaign[campaignId] = [];
      }

      const entry = {
        id: payload.id || uid("jrnl"),
        campaignId,
        title: String(payload.title || "Untitled Note").trim(),
        body: String(payload.body || "").trim(),
        tags: Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
        visibility: payload.visibility === "gm" ? "gm" : "party",
        authorUserId: actorUserId,
        createdAt: nowEpochSec(),
        updatedAt: nowEpochSec()
      };

      db.journalsByCampaign[campaignId].unshift(entry);
      bumpStateVersion(campaignId);
      writeToDisk();
      return { entry };
    }

    case "update_journal_entry": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);

      const entryId = String(payload.entryId || "");
      if (!entryId) {
        throw makeError("BAD_REQUEST", "entryId is required", 400);
      }

      const entries = db.journalsByCampaign[campaignId] || [];
      let updated = null;
      db.journalsByCampaign[campaignId] = entries.map((entry) => {
        if (entry.id !== entryId) {
          return entry;
        }
        updated = {
          ...entry,
          title: payload.title !== undefined ? String(payload.title).trim() : entry.title,
          body: payload.body !== undefined ? String(payload.body).trim() : entry.body,
          tags: payload.tags !== undefined ? (Array.isArray(payload.tags) ? payload.tags : entry.tags) : entry.tags,
          visibility: payload.visibility === "gm" || payload.visibility === "party" ? payload.visibility : entry.visibility,
          updatedAt: nowEpochSec()
        };
        return updated;
      });

      if (!updated) {
        throw makeError("NOT_FOUND", "Journal entry not found", 404);
      }

      bumpStateVersion(campaignId);
      writeToDisk();
      return { entry: updated };
    }

    default:
      throw makeError("BAD_REQUEST", `Unsupported operation: ${op}`, 400);
  }
}
