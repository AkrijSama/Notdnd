import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildQuickstartBlueprint } from "../campaign/quickstart.js";
import { ensureCampaignMemoryDocs, ensureCampaignMemoryDocsAsync } from "../gm/memoryStore.js";
import { formatRollSummary, resolveAttack, resolveSkillCheck, rollDiceExpression } from "../rules/engine.js";
import { NPC_EXPRESSIONS, createDefaultSoloRun, validateSoloRun } from "../solo/schema.js";
import { backfillConditionKinds } from "../solo/conditions.js";
import { uid } from "../utils/ids.js";
import { createSeedState } from "./seedState.js";
import { getDatabase } from "./database.js";

// Legacy JSON store (default location). On first run it is imported into SQLite
// and renamed to <path>.bak.
const DEFAULT_LEGACY_JSON_PATH = path.resolve(process.cwd(), "server/db/notdnd.db.json");
// SQLite store (default location). The active, durable store.
const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "server/db/notdnd.sqlite");
const SESSION_TTL_SECONDS = Number(process.env.NOTDND_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
const PBKDF2_ITERATIONS = Number(process.env.NOTDND_PBKDF2_ITERATIONS || 210000);

const READ_ROLES = new Set(["owner", "gm", "editor", "player", "viewer"]);
const WRITE_ROLES = new Set(["owner", "gm", "editor"]);
const PLAY_ROLES = new Set(["owner", "gm", "editor", "player"]);
const MANAGE_MEMBER_ROLES = new Set(["owner", "gm"]);

// Resolves the active SQLite store path. Honours NOTDND_DB_PATH (callers/tests
// still point at it): a ".json" value is mapped to its ".sqlite" sibling so
// existing temp-dir setups keep working without changes; ":memory:" yields an
// ephemeral in-memory database.
function storePath() {
  // Brand rename: INKBORNE_DB_PATH first, legacy NOTDND_DB_PATH as fallback.
  const configured = process.env.INKBORNE_DB_PATH ?? process.env.NOTDND_DB_PATH;
  if (!configured) {
    return DEFAULT_SQLITE_PATH;
  }
  if (configured === ":memory:") {
    return ":memory:";
  }
  const resolved = path.resolve(configured);
  if (resolved.endsWith(".sqlite")) {
    return resolved;
  }
  if (resolved.endsWith(".json")) {
    return `${resolved.slice(0, -".json".length)}.sqlite`;
  }
  return `${resolved}.sqlite`;
}

// Resolves the legacy JSON store path for the one-time migration. Mirrors
// storePath()'s NOTDND_DB_PATH handling but points at the ".json" file.
function legacyJsonPath() {
  const configured = process.env.INKBORNE_DB_PATH ?? process.env.NOTDND_DB_PATH;
  if (!configured) {
    return DEFAULT_LEGACY_JSON_PATH;
  }
  if (configured === ":memory:") {
    return null;
  }
  const resolved = path.resolve(configured);
  if (resolved.endsWith(".json")) {
    return resolved;
  }
  if (resolved.endsWith(".sqlite")) {
    return `${resolved.slice(0, -".sqlite".length)}.json`;
  }
  return `${resolved}.json`;
}

function ensureStoreDir() {
  const target = storePath();
  if (target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
}

function conn() {
  return getDatabase(storePath());
}

// Reconstructs the in-memory db object from the SQLite tables. Returns null when
// the store has never been initialized (no rows / no sentinel), so the caller
// falls through to legacy-JSON migration or a fresh seed.
function readFromSqlite() {
  const sdb = conn();
  const initialized = sdb.prepare("SELECT value FROM kv WHERE key = ?").get("__initialized__");
  if (!initialized) {
    return null;
  }

  const out = {};
  for (const row of sdb.prepare("SELECT key, value FROM kv").all()) {
    if (row.key === "__initialized__") {
      continue;
    }
    out[row.key] = JSON.parse(row.value);
  }
  out.users = sdb.prepare("SELECT data FROM users").all().map((row) => JSON.parse(row.data));
  out.sessions = sdb.prepare("SELECT data FROM sessions").all().map((row) => JSON.parse(row.data));
  out.soloRuns = {};
  for (const row of sdb.prepare("SELECT id, data FROM campaigns").all()) {
    out.soloRuns[row.id] = JSON.parse(row.data);
  }
  return out;
}

// Reads the legacy JSON store (pre-SQLite). Returns the parsed object or null.
function loadLegacyJson() {
  const jsonPath = legacyJsonPath();
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Set when loadFromDisk imported a legacy JSON file; the file is renamed to .bak
// only after the first successful SQLite write (so a crash mid-migration never
// loses data).
let pendingLegacyMigrationPath = null;

function finalizeLegacyMigration() {
  if (!pendingLegacyMigrationPath) {
    return;
  }
  const jsonPath = pendingLegacyMigrationPath;
  pendingLegacyMigrationPath = null;
  try {
    fs.renameSync(jsonPath, `${jsonPath}.bak`);
  } catch {
    // best-effort: data is already safely in SQLite; the .bak rename is cosmetic
  }
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

// Subscription tiers. 'free' is image-gated (a daily generation cap); the paid
// tiers lift the image/session limits. The entitlement policy (limits, BYOK
// bypass) lives in server/auth/entitlements.js — the repository only owns the
// tier field and the daily usage counters it reads.
export const USER_TIERS = Object.freeze(["free", "adventurer", "premium"]);
const DEFAULT_USER_TIER = "free";

function normalizeTier(tier) {
  const value = String(tier || "").trim().toLowerCase();
  return USER_TIERS.includes(value) ? value : DEFAULT_USER_TIER;
}

// UTC day key (YYYY-MM-DD) for the daily image/session usage counters. UTC so
// the reset boundary is stable regardless of the server's local timezone.
function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
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
    isGuest: Boolean(user.isGuest),
    tier: normalizeTier(user.tier),
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
  target.campaignRuntimeByCampaign =
    target.campaignRuntimeByCampaign && typeof target.campaignRuntimeByCampaign === "object"
      ? target.campaignRuntimeByCampaign
      : {};
  target.soloRuns = target.soloRuns && typeof target.soloRuns === "object" && !Array.isArray(target.soloRuns)
    ? target.soloRuns
    : {};
  // Manually-authored custom homebrew content, keyed by userId -> array of items.
  // Persisted via the kv catch-all (writeToDisk). Additive to the SRD content.
  target.userHomebrew = target.userHomebrew && typeof target.userHomebrew === "object" && !Array.isArray(target.userHomebrew)
    ? target.userHomebrew
    : {};
  // Daily entitlement usage counters, keyed by userId -> { date: 'YYYY-MM-DD'
  // (UTC), images, sessions }. Resets at midnight UTC (the stored date no longer
  // matching today zeroes the counts on next access). Persisted via the kv
  // catch-all; the free-tier image/session caps meter off this.
  target.dailyUsageByUser =
    target.dailyUsageByUser && typeof target.dailyUsageByUser === "object" && !Array.isArray(target.dailyUsageByUser)
      ? target.dailyUsageByUser
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

function defaultCampaignRuntimeState() {
  return {
    mode: "freeform",
    initiativeOrder: [],
    turnPointer: 0,
    waitingForGm: false,
    typingByUser: {},
    updatedAt: nowEpochSec()
  };
}

function loadFromDisk() {
  ensureStoreDir();
  // Prefer the SQLite store. If it has never been written, fall back to a
  // one-time import of the legacy JSON file (renamed to .bak after the first
  // successful SQLite write — see finalizeLegacyMigration).
  const fromSqlite = readFromSqlite();
  if (fromSqlite) {
    return fromSqlite;
  }
  const legacy = loadLegacyJson();
  if (legacy) {
    pendingLegacyMigrationPath = legacyJsonPath();
    return legacy;
  }
  return null;
}

// Persists the whole in-memory db to SQLite in a single transaction (atomic and
// durable — the JSON store had neither). users/sessions/soloRuns get their own
// tables; every other top-level key is JSON in `kv` so nothing is dropped. A
// full replace per write matches the previous whole-file rewrite cost while
// eliminating the corruption/torn-write risk.
function writeToDisk() {
  ensureStoreDir();
  const sdb = conn();

  const persist = sdb.transaction(() => {
    sdb.prepare("DELETE FROM users").run();
    const insertUser = sdb.prepare(
      "INSERT INTO users (id, email, displayName, passwordHash, isAdmin, tier, createdAt, data) " +
        "VALUES (@id, @email, @displayName, @passwordHash, @isAdmin, @tier, @createdAt, @data)"
    );
    for (const user of Array.isArray(db.users) ? db.users : []) {
      if (!user || typeof user.id !== "string") {
        continue;
      }
      insertUser.run({
        id: user.id,
        email: typeof user.email === "string" ? user.email : null,
        displayName: typeof user.displayName === "string" ? user.displayName : null,
        passwordHash: typeof user.passwordHash === "string" ? user.passwordHash : null,
        isAdmin: user.isAdmin ? 1 : 0,
        tier: normalizeTier(user.tier),
        createdAt: Number.isFinite(Number(user.createdAt)) ? Number(user.createdAt) : null,
        data: JSON.stringify(user)
      });
    }

    sdb.prepare("DELETE FROM sessions").run();
    const insertSession = sdb.prepare(
      "INSERT INTO sessions (token, userId, createdAt, expiresAt, data) " +
        "VALUES (@token, @userId, @createdAt, @expiresAt, @data)"
    );
    for (const session of Array.isArray(db.sessions) ? db.sessions : []) {
      if (!session || typeof session.token !== "string") {
        continue;
      }
      insertSession.run({
        token: session.token,
        userId: typeof session.userId === "string" ? session.userId : null,
        createdAt: Number.isFinite(Number(session.createdAt)) ? Number(session.createdAt) : null,
        expiresAt: Number.isFinite(Number(session.expiresAt)) ? Number(session.expiresAt) : null,
        data: JSON.stringify(session)
      });
    }

    sdb.prepare("DELETE FROM campaigns").run();
    const insertRun = sdb.prepare("INSERT INTO campaigns (id, userId, data) VALUES (@id, @userId, @data)");
    const soloRuns = db.soloRuns && typeof db.soloRuns === "object" ? db.soloRuns : {};
    for (const [runId, run] of Object.entries(soloRuns)) {
      if (!runId || !run) {
        continue;
      }
      insertRun.run({
        id: runId,
        userId: typeof run.userId === "string" ? run.userId : null,
        data: JSON.stringify(run)
      });
    }

    // Everything else (campaigns[] multiplayer array, books, maps, aiJobs,
    // stateVersion, *ByCampaign maps, etc.) → kv catch-all so no key is lost.
    sdb.prepare("DELETE FROM kv").run();
    const insertKv = sdb.prepare("INSERT INTO kv (key, value) VALUES (?, ?)");
    insertKv.run("__initialized__", "1");
    for (const [key, value] of Object.entries(db)) {
      if (key === "users" || key === "sessions" || key === "soloRuns") {
        continue;
      }
      insertKv.run(key, JSON.stringify(value === undefined ? null : value));
    }
  });

  persist();
}

function getUserById(userId) {
  return db.users.find((entry) => entry.id === userId) || null;
}

function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return db.users.find((entry) => entry.email === normalized) || null;
}

// Exported email→user lookup for the payment webhook (LemonSqueezy fallback
// buyer match when checkout custom_data.user_id is absent). Returns a sanitized
// user ({ id, tier, ... }) or null. Never throws.
export function findUserByEmail(email) {
  ensureDb();
  const user = getUserByEmail(email);
  return user ? sanitizeUser(user) : null;
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

function ensureCampaignRuntimeSlot(campaignId) {
  if (!db.campaignRuntimeByCampaign[campaignId]) {
    db.campaignRuntimeByCampaign[campaignId] = defaultCampaignRuntimeState();
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

// The demo account (known email + password) is a credential-stuffing target, so
// it is created ONLY when explicitly enabled for local development — never by
// default, and never in production. Tests enable it via the env in the npm
// "unit" script.
function demoBootstrapEnabled() {
  return String(process.env.NOTDND_BOOTSTRAP_DEMO || "").trim().toLowerCase() === "true";
}

function bootstrapAdminAndMemberships() {
  if (db.users.length === 0 && demoBootstrapEnabled()) {
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
      resetToken: null,
      resetTokenExpiresAt: null,
      isAdmin: true,
      // The env-gated demo/bootstrap account is the local testing identity, so it
      // gets a paid tier (unlimited images/sessions) to keep it unthrottled.
      tier: "adventurer",
      createdAt: nowEpochSec()
    });
  }

  // May be undefined when the demo bootstrap is disabled and no one has
  // registered yet (a fresh production install); owner assignment is then
  // skipped — real users own the campaigns they create.
  const adminUser = db.users[0];
  for (const campaign of db.campaigns) {
    if (!db.campaignMembersByCampaign[campaign.id]) {
      db.campaignMembersByCampaign[campaign.id] = [];
    }
    if (adminUser) {
      const hasOwner = db.campaignMembersByCampaign[campaign.id].some((entry) => entry.userId === adminUser.id);
      if (!hasOwner) {
        db.campaignMembersByCampaign[campaign.id].push({
          userId: adminUser.id,
          role: "owner",
          addedAt: nowEpochSec()
        });
      }
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
    // Now that the data is safely in SQLite, retire the legacy JSON file (if the
    // load above imported one) by renaming it to .bak.
    finalizeLegacyMigration();
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
  const campaignRuntimeByCampaign = {};
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
    campaignRuntimeByCampaign[campaignId] = db.campaignRuntimeByCampaign?.[campaignId] || defaultCampaignRuntimeState();
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
    campaignRuntimeByCampaign: deepClone(campaignRuntimeByCampaign),
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

function validateSoloRunOrThrow(run) {
  const validation = validateSoloRun(run);
  if (!validation.ok) {
    throw makeError("INVALID_SOLO_RUN", "Solo run validation failed.", 400, {
      validationErrors: validation.errors
    });
  }
}

function nowIso() {
  return new Date().toISOString();
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
  db.campaignRuntimeByCampaign = {};
  db.soloRuns = {};
  db.stateVersion = 0;

  bootstrapAdminAndMemberships();
  writeToDisk();
}

export function createSoloRun({ userId = null, runId = null, worldSeed = null, now = null } = {}) {
  ensureDb();
  const run = createDefaultSoloRun({
    userId,
    runId,
    worldSeed,
    now
  });
  validateSoloRunOrThrow(run);
  if (db.soloRuns[run.runId]) {
    throw makeError("CONFLICT", "Solo run already exists.", 409);
  }

  db.soloRuns[run.runId] = deepClone(run);
  bumpStateVersion();
  writeToDisk();
  return deepClone(run);
}

export function getSoloRun(runId) {
  ensureDb();
  const key = String(runId || "").trim();
  if (!key) {
    return null;
  }
  const stored = db.soloRuns[key];
  if (!stored) {
    return null;
  }
  // Item 1 one-time kind backfill: legacy runs committed conditions before the
  // required `kind` field existed. Assign kinds on the STORED record once (cheap
  // no-op scan afterwards — every entry then carries kind) and persist, so the
  // heuristic never runs for this run again. New mints carry kind from the
  // committer and never hit this branch.
  if (backfillConditionKinds(stored) > 0) {
    writeToDisk();
  }
  return deepClone(stored);
}

export function listSoloRunsForUser(userId) {
  ensureDb();
  const key = userId === null || userId === undefined ? null : String(userId);
  return Object.values(db.soloRuns)
    .filter((run) => run.userId === key)
    .map((run) => deepClone(run))
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function saveSoloRun(run) {
  ensureDb();
  const next = deepClone(run);
  next.updatedAt = nowIso();
  validateSoloRunOrThrow(next);

  db.soloRuns[next.runId] = next;
  bumpStateVersion();
  writeToDisk();
  return deepClone(next);
}

export function deleteSoloRun(runId) {
  ensureDb();
  const key = String(runId || "").trim();
  if (!key || !db.soloRuns[key]) {
    return false;
  }
  delete db.soloRuns[key];
  bumpStateVersion();
  writeToDisk();
  return true;
}

// Sets (or clears) a player-chosen display title on a run. Additive `title` field
// on the JSON blob — no migration. A blank title clears it, reverting the home
// card to its computed default ("<Character> — <World>"). Deliberately does NOT
// touch updatedAt: renaming is not play, so the last-played sort stays accurate.
export function renameSoloRun(runId, title) {
  ensureDb();
  const key = String(runId || "").trim();
  const run = db.soloRuns[key];
  if (!run) {
    return null;
  }
  const clean = String(title || "").trim().slice(0, 80);
  if (clean) {
    run.title = clean;
  } else {
    delete run.title;
  }
  validateSoloRunOrThrow(run);
  bumpStateVersion();
  writeToDisk();
  return deepClone(run);
}

// ---------------------------------------------------------------------------
// Custom homebrew content (manually authored, per user).
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of a user's custom content items (newest first).
 * @param {string} userId
 * @returns {object[]}
 */
export function listUserHomebrew(userId) {
  ensureDb();
  const key = String(userId || "").trim();
  if (!key) {
    return [];
  }
  const items = Array.isArray(db.userHomebrew[key]) ? db.userHomebrew[key] : [];
  return deepClone(items);
}

/**
 * Stores a validated custom-content item for a user, assigning it an id +
 * createdAt. The caller is responsible for validating/sanitizing `item`
 * (see customContent.validateCustomItem). Returns the stored record.
 * @param {string} userId
 * @param {object} item validated, sanitized custom item (with type + name)
 * @returns {object} stored record
 */
export function addUserHomebrew(userId, item) {
  ensureDb();
  const key = String(userId || "").trim();
  if (!key) {
    throw makeError("BAD_REQUEST", "userId is required.", 400);
  }
  if (!item || typeof item !== "object") {
    throw makeError("BAD_REQUEST", "A custom-content item is required.", 400);
  }
  if (!Array.isArray(db.userHomebrew[key])) {
    db.userHomebrew[key] = [];
  }
  const record = {
    ...deepClone(item),
    id: `hb_${crypto.randomBytes(8).toString("hex")}`,
    createdAt: nowEpochSec()
  };
  db.userHomebrew[key].unshift(record);
  bumpStateVersion();
  writeToDisk();
  return deepClone(record);
}

/**
 * Removes one of a user's custom-content items by id. Returns true if removed.
 * @param {string} userId
 * @param {string} itemId
 * @returns {boolean}
 */
export function deleteUserHomebrew(userId, itemId) {
  ensureDb();
  const key = String(userId || "").trim();
  const id = String(itemId || "").trim();
  if (!key || !id || !Array.isArray(db.userHomebrew[key])) {
    return false;
  }
  const before = db.userHomebrew[key].length;
  db.userHomebrew[key] = db.userHomebrew[key].filter((entry) => entry && entry.id !== id);
  if (db.userHomebrew[key].length === before) {
    return false;
  }
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Narrow write: concludes a solo run by moving it out of the "active" status and
 * recording how it ended. The outcome (e.g. "died", "exited"/"abandoned",
 * "completed_quest") maps to a terminal status — "abandoned" for a voluntary
 * exit, "completed" otherwise — and is stored verbatim on run.outcome alongside
 * run.completedAt. Idempotent: a run that is already concluded is returned
 * unchanged (so a later abandon can't overwrite a death). Returns the concluded
 * run (deep clone), or null if the run does not exist.
 * @param {string} runId
 * @param {string} [outcome]
 * @returns {object|null}
 */
export function completeSoloRun(runId, outcome = "completed") {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return null;
  }
  if (run.status === "active") {
    const cleaned = typeof outcome === "string" && outcome.trim() ? outcome.trim() : "completed";
    run.status = cleaned === "abandoned" || cleaned === "exited" ? "abandoned" : "completed";
    run.outcome = cleaned;
    run.completedAt = nowIso();
    run.updatedAt = run.completedAt;
    bumpStateVersion();
    writeToDisk();
  }
  return deepClone(run);
}

// ---------------------------------------------------------------------------
// Image-asset writes (narrow, surgical).
//
// These deliberately do NOT go through saveSoloRun: that path deep-clones and
// fully re-validates the entire run, and writes the whole run back. The image
// worker runs asynchronously alongside live gameplay, so using saveSoloRun for
// its write-backs risks clobbering concurrent gameplay state with a stale
// full-run snapshot. Instead we mutate only the targeted asset record in place
// and persist. (writeToDisk still serialises the whole db — inherent to this
// JSON store — but we avoid the deep-clone / full-run overwrite race.)
// ---------------------------------------------------------------------------

/**
 * Ensures an NPC has queued image-asset records for its base portrait and every
 * expression variant, linking them onto the NPC. Idempotent: existing records
 * and links are left untouched. Returns the resolved asset id map, or null if
 * the run/NPC does not exist.
 * @param {string} runId
 * @param {string} npcId
 * @param {{ style?: string, expressions?: string[] }} [options]
 * @returns {{ base: string, variants: Record<string, string> } | null}
 */
export function ensureNpcImageAssets(runId, npcId, options = {}) {
  ensureDb();
  const runKey = String(runId || "").trim();
  const run = db.soloRuns[runKey];
  if (!run) {
    return null;
  }
  const npc = run.npcs && run.npcs[npcId];
  if (!npc) {
    return null;
  }

  run.imageAssets = run.imageAssets && typeof run.imageAssets === "object" ? run.imageAssets : {};
  const expressions = Array.isArray(options.expressions) ? options.expressions : NPC_EXPRESSIONS;
  const style = typeof options.style === "string" ? options.style : null;
  const now = nowIso();

  const ensureAsset = (assetId) => {
    if (!run.imageAssets[assetId]) {
      run.imageAssets[assetId] = {
        assetId,
        targetType: "npc",
        targetId: npcId,
        status: "queued",
        promptSummary: style ? `style:${style}` : null,
        uri: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        tags: [],
        flags: {},
        edition: run.edition ?? null,
        policyProfileId: run.policyProfileId ?? null,
        contentTags: []
      };
    }
    return assetId;
  };

  const baseAssetId = ensureAsset(`img_${npcId}_base`);
  if (!npc.imageAssetId) {
    npc.imageAssetId = baseAssetId;
  }

  npc.expressionVariants = npc.expressionVariants && typeof npc.expressionVariants === "object" ? npc.expressionVariants : {};
  const variants = {};
  for (const expression of expressions) {
    const assetId = ensureAsset(`img_${npcId}_${expression}`);
    if (!npc.expressionVariants[expression]) {
      npc.expressionVariants[expression] = assetId;
    }
    variants[expression] = assetId;
  }

  // Full-body VN sprite slot — distinct from the bust (base) and the expression
  // variants. Created as a queued placeholder (cheap, no image bytes); generated
  // lazily by runVnBodyImageJob only when the NPC first enters VN mode.
  const vnBodyAssetId = ensureAsset(`img_${npcId}_vnBody`);

  bumpStateVersion();
  writeToDisk();
  return { base: baseAssetId, variants, vnBody: vnBodyAssetId };
}

/**
 * Ensures a single location-background image asset exists on the run (keyed by a
 * deterministic id) and links it onto the location. Mirrors the generate-once
 * pattern used for portraits; idempotent. Returns { assetId } or null when the
 * run/location does not exist.
 * @param {string} runId
 * @param {string} locationId
 * @param {{ promptSummary?: string }} [options]
 * @returns {{ assetId: string } | null}
 */
export function ensureLocationImageAsset(runId, locationId, options = {}) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return null;
  }
  const location = run.locations && run.locations[locationId];
  if (!location) {
    return null;
  }

  run.imageAssets = run.imageAssets && typeof run.imageAssets === "object" ? run.imageAssets : {};
  const assetId = `img_location_${locationId}`;
  if (!run.imageAssets[assetId]) {
    const now = nowIso();
    run.imageAssets[assetId] = {
      assetId,
      targetType: "location",
      targetId: locationId,
      status: "queued",
      promptSummary: typeof options.promptSummary === "string" ? options.promptSummary : null,
      uri: null,
      // Player can lock a good location image so it never regenerates on revisit
      // or via Redo. Default false (unlocked / rerollable).
      locked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      tags: [],
      flags: {},
      edition: run.edition ?? null,
      policyProfileId: run.policyProfileId ?? null,
      contentTags: []
    };
  }
  if (!location.imageAssetId) {
    location.imageAssetId = assetId;
  }

  bumpStateVersion();
  writeToDisk();
  return { assetId };
}

/**
 * Surgically updates a single image asset's status (and uri) without
 * re-validating or rewriting the whole run. Returns false if the run or asset
 * does not exist.
 * @param {string} runId
 * @param {string} assetId
 * @param {"placeholder"|"queued"|"generated"|"failed"} status
 * @param {string|null} [uri]
 * @returns {boolean}
 */
export function updateImageAssetStatus(runId, assetId, status, uri = null) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run || !run.imageAssets || !run.imageAssets[assetId]) {
    return false;
  }
  const asset = run.imageAssets[assetId];
  asset.status = status;
  if (uri !== undefined && uri !== null) {
    asset.uri = String(uri);
  }
  asset.updatedAt = nowIso();
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Locks (or unlocks) a location's background image so it is final for that
 * location — Redo/Save controls disappear and revisits never regenerate it.
 * Returns the asset summary, or null when the run/asset does not exist.
 * @param {string} runId
 * @param {string} locationId
 * @param {boolean} [locked]
 */
export function setLocationImageLocked(runId, locationId, locked = true) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return null;
  }
  const location = run.locations && run.locations[String(locationId)];
  const assetId = (location && location.imageAssetId) || `img_location_${locationId}`;
  const asset = run.imageAssets && run.imageAssets[assetId];
  if (!asset) {
    return null;
  }
  asset.locked = Boolean(locked);
  asset.updatedAt = nowIso();
  bumpStateVersion();
  writeToDisk();
  return { assetId, locked: asset.locked, status: asset.status, uri: asset.uri || null };
}

/**
 * Prepares a location image for a Redo: refuses when locked ({ locked: true }),
 * otherwise flips an existing asset back to "queued" so the worker regenerates
 * it (and resolveLocationImageUri hides the stale one until the new image lands).
 * Returns { ok: true } when clear to regenerate (asset may not exist yet — the
 * worker creates it), or null when the run/location does not exist.
 * @param {string} runId
 * @param {string} locationId
 */
export function markLocationImageRegenerating(runId, locationId) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return null;
  }
  const location = run.locations && run.locations[String(locationId)];
  if (!location) {
    return null;
  }
  const assetId = location.imageAssetId || `img_location_${locationId}`;
  const asset = run.imageAssets && run.imageAssets[assetId];
  if (asset && asset.locked) {
    return { locked: true };
  }
  if (asset) {
    asset.status = "queued";
    asset.uri = null;
    asset.updatedAt = nowIso();
    bumpStateVersion();
    writeToDisk();
  }
  return { ok: true, locked: false };
}

/**
 * Surgically writes a generated identity onto an NPC without re-validating or
 * rewriting the whole run. Stores only string/number fields (never raw
 * generation output beyond these), and promotes generatedName to displayName so
 * the name surfaces through existing rendering. Returns false if the run or NPC
 * does not exist.
 * @param {string} runId
 * @param {string} npcId
 * @param {{ generatedName?: string, appearance?: string, personality?: string, portraitPrompt?: string, identitySeed?: number }} identity
 * @returns {boolean}
 */
export function updateNpcIdentity(runId, npcId, identity = {}) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  const npc = run?.npcs?.[npcId];
  if (!npc) {
    return false;
  }

  if (typeof identity.generatedName === "string" && identity.generatedName.trim()) {
    let name = identity.generatedName.trim();
    // Final per-run first-name uniqueness guard (the two-Maras bug): if another
    // committed NPC already holds this first name, suffix rather than collide.
    // (Mint-time uniqueness lives in npcIdentity — this backstops stale queue
    // jobs that were generated before the roster changed.) Inline, no import:
    // npcIdentity imports this module, so the helper can't be reused here.
    const firstLc = name.split(/\s+/)[0].toLowerCase();
    const clash = Object.values(run.npcs || {}).some(
      (other) =>
        other && other.npcId !== npcId &&
        [other.generatedName, other.displayName].some(
          (n) => typeof n === "string" && n.trim().split(/\s+/)[0].toLowerCase() === firstLc && firstLc.length >= 3
        )
    );
    if (clash) {
      const renamed = `${name} the Younger`;
      if (typeof identity.portraitPrompt === "string") {
        identity.portraitPrompt = identity.portraitPrompt.replace(name, renamed);
      }
      name = renamed;
    }
    npc.generatedName = name;
    npc.displayName = name;
  }
  if (typeof identity.appearance === "string") {
    npc.appearance = identity.appearance;
  }
  if (typeof identity.personality === "string") {
    npc.personality = identity.personality;
  }
  if (typeof identity.portraitPrompt === "string") {
    npc.portraitPrompt = identity.portraitPrompt;
  }
  // Committed mannerism (spit-ban vacuum fill): set once, never overwritten so the
  // NPC keeps a stable physical tell across the run.
  if (typeof identity.mannerism === "string" && identity.mannerism.trim() && !(typeof npc.mannerism === "string" && npc.mannerism.trim())) {
    npc.mannerism = identity.mannerism.trim();
  }
  // Committed voice spec (vn-dialogue-hardening law 2): set once, like the
  // mannerism — a stable spoken register across the run. Shape is enforced by
  // schema.validateNpc; here we only require the three fields to be present.
  if (
    identity.voice && typeof identity.voice === "object" &&
    typeof identity.voice.register === "string" &&
    typeof identity.voice.sentenceLength === "string" &&
    typeof identity.voice.talkativeness === "string" &&
    !(npc.voice && typeof npc.voice === "object")
  ) {
    npc.voice = {
      register: identity.voice.register,
      sentenceLength: identity.voice.sentenceLength,
      talkativeness: identity.voice.talkativeness
    };
  }
  // #50: gender + pronouns feed the portrait prompt (groundNpcPortrait). Only set
  // when not ALREADY committed — a value inferred from the narration on commit
  // (npcCommit.inferNpcGenderFromNarration) is authoritative over a later guess.
  if (typeof identity.gender === "string" && identity.gender.trim() && !(typeof npc.gender === "string" && npc.gender.trim())) {
    npc.gender = identity.gender.trim();
  }
  if (typeof identity.pronouns === "string" && identity.pronouns.trim() && !(typeof npc.pronouns === "string" && npc.pronouns.trim())) {
    npc.pronouns = identity.pronouns.trim();
  }
  if (Number.isFinite(Number(identity.identitySeed))) {
    npc.identitySeed = Number(identity.identitySeed);
  }
  if (typeof identity.memoryDocId === "string" && identity.memoryDocId.trim()) {
    npc.memoryDocId = identity.memoryDocId.trim();
  }

  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Narrow write that marks an NPC's intro instructions consumed (the GM has
 * introduced them). Clears introInstructions so the directive fires only once.
 * Returns false if the run or NPC does not exist.
 * @param {string} runId
 * @param {string} npcId
 * @returns {boolean}
 */
/**
 * Narrow write: stores the player's generated portrait URI on run.player.
 * Bytes live on disk; only the string URI is persisted. Returns false if the
 * run/player does not exist.
 * @param {string} runId
 * @param {string|null} uri
 * @returns {boolean}
 */
export function updatePlayerPortrait(runId, uri) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run || !run.player) {
    return false;
  }
  run.player.portraitUri = typeof uri === "string" && uri ? uri : null;
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Narrow write: stores the current scene narrative on run.narration. Used by the
 * action loop + world-entry opening so /gm-scene reflects real GM prose as the
 * player acts. Returns false if the run does not exist.
 * @param {string} runId
 * @param {string|null} narration
 * @returns {boolean}
 */
export function updateSoloRunNarration(runId, narration) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return false;
  }
  run.narration = typeof narration === "string" && narration.trim() ? narration : null;
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Narrow write: caches the 3 contextual suggested actions for the run's current
 * scene, keyed so a poll can tell whether they're still fresh (and the scene
 * builder serves them instead of the generic fallback). Returns false if the
 * run does not exist.
 * @param {string} runId
 * @param {string} sceneKey
 * @param {string[]} actions
 * @returns {boolean}
 */
export function setSoloRunSuggestions(runId, sceneKey, actions) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return false;
  }
  run.suggestedActions = Array.isArray(actions)
    ? actions.slice(0, 3).map((action) => String(action || "")).filter((action) => action.trim().length > 0)
    : [];
  run.suggestedActionsKey = typeof sceneKey === "string" ? sceneKey : "";
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Narrow write: persists the solo battle-map token positions on run.battleMap so
 * they survive reloads. Shape: { width, height, positions: { tokenId: {x,y} } }.
 * Returns false if the run does not exist.
 * @param {string} runId
 * @param {object|null} battleMap
 * @returns {boolean}
 */
export function updateSoloRunBattleMap(runId, battleMap) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return false;
  }
  run.battleMap = battleMap && typeof battleMap === "object" && !Array.isArray(battleMap) ? battleMap : null;
  bumpStateVersion();
  writeToDisk();
  return true;
}

export function markNpcIntroduced(runId, npcId) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  const npc = run?.npcs?.[npcId];
  if (!npc) {
    return false;
  }
  npc.introInstructions = null;
  // Durable introduced flag: default (synthesized) intros have no
  // introInstructions to consume, so the pending-intro check reads this.
  if (!npc.flags || typeof npc.flags !== "object" || Array.isArray(npc.flags)) {
    npc.flags = {};
  }
  npc.flags.introduced = true;
  bumpStateVersion();
  writeToDisk();
  return true;
}

/**
 * Creates a custom NPC on a solo run from user input and persists it (full-run
 * validate). Identity is left for the fill-gaps generator/bridge to complete.
 * Origin "user" is coerced to "hybrid" until image upload exists (Ticket 34);
 * with no name/description it defaults to "procedural". Returns { runId, npcId }
 * or null if the run does not exist.
 * @param {string} runId
 * @param {{ name?: string, description?: string, introInstructions?: string, origin?: string }} input
 * @returns {{ runId: string, npcId: string } | null}
 */
export function createSoloNpc(runId, input = {}) {
  ensureDb();
  const run = db.soloRuns[String(runId || "").trim()];
  if (!run) {
    return null;
  }

  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const introInstructions = String(input.introInstructions || "").trim();

  // Portrait upload exists now, so "user" is a valid origin (a portrait is
  // uploaded in a follow-up request). Unknown/empty origins default by intent.
  let origin = String(input.origin || "").trim().toLowerCase();
  if (origin !== "procedural" && origin !== "hybrid" && origin !== "user") {
    origin = name || description ? "hybrid" : "procedural";
  }

  const role = (description || "wanderer").slice(0, 80);
  const npcId = uid("npc");
  const npc = {
    npcId,
    displayName: name || role,
    role,
    currentLocationId: run.currentLocationId,
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: run.edition ?? null,
    policyProfileId: run.policyProfileId ?? null,
    contentTags: [],
    origin
  };
  if (name) {
    npc.generatedName = name;
  }
  if (introInstructions) {
    npc.introInstructions = introInstructions;
  }

  run.npcs = run.npcs && typeof run.npcs === "object" ? run.npcs : {};
  run.npcs[npcId] = npc;
  validateSoloRunOrThrow(run);
  bumpStateVersion();
  writeToDisk();
  return { runId: run.runId, npcId };
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
    resetToken: null,
    resetTokenExpiresAt: null,
    isAdmin: false,
    tier: DEFAULT_USER_TIER,
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

// Guest play: a real user record (stable id) with no credentials. Runs, campaign
// membership, entitlement counters, and campaign-memory dirs all key on the user
// id, so a guest who later registers keeps everything via upgradeGuestUser —
// nothing is copied or moved. Guests can never be logged into (email is null, so
// loginUser can't find them); their only key is the session token minted here.
export function createGuestUser() {
  ensureDb();

  const user = {
    id: uid("usr"),
    email: null,
    displayName: "Wanderer",
    passwordHash: null,
    passwordSalt: null,
    passwordIterations: null,
    resetToken: null,
    resetTokenExpiresAt: null,
    isAdmin: false,
    isGuest: true,
    tier: DEFAULT_USER_TIER,
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

// Promotes a guest to a full account IN PLACE — same user id, so every run,
// campaign membership, and usage counter the guest accumulated is retained
// without any migration. Validation mirrors registerUser exactly.
export function upgradeGuestUser(userId, { email, password, displayName }) {
  ensureDb();

  const user = getUserById(userId);
  if (!user) {
    throw makeError("NOT_FOUND", "User not found.", 404);
  }
  if (!user.isGuest) {
    throw makeError("CONFLICT", "This account is already registered.", 409);
  }

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
  user.email = normalizedEmail;
  user.displayName = normalizeDisplayName(displayName, normalizedEmail.split("@")[0]);
  user.passwordHash = passwordRecord.hash;
  user.passwordSalt = passwordRecord.salt;
  user.passwordIterations = passwordRecord.iterations;
  user.isGuest = false;

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

// Password reset: a short-lived 6-digit code stored on the user record. No email
// provider yet, so the code is logged to the console (real delivery is a
// follow-up). Never exposed via sanitizeUser, so it does not leak in responses.
const RESET_TOKEN_TTL_SECONDS = 15 * 60;

function generateResetCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Issues a password-reset code for an email. Always returns ok (never reveals
 * whether the email exists — account-enumeration guard). When the user exists,
 * a 6-digit, 15-minute code is stored and logged to the console.
 * @param {{ email?: string }} input
 * @returns {{ ok: true }}
 */
export function requestPasswordReset({ email } = {}) {
  ensureDb();
  const normalizedEmail = normalizeEmail(email);
  const user = normalizedEmail ? getUserByEmail(normalizedEmail) : null;
  if (user) {
    const code = generateResetCode();
    user.resetToken = code;
    user.resetTokenExpiresAt = nowEpochSec() + RESET_TOKEN_TTL_SECONDS;
    writeToDisk();
    // eslint-disable-next-line no-console
    console.log(`[auth] Password reset code for ${user.email}: ${code} (expires in 15 minutes)`);
  }
  return { ok: true };
}

/**
 * Completes a password reset: validates the code (present, unexpired, matching),
 * hashes the new password, and clears the code. Existing sessions are
 * invalidated so a leaked code cannot ride an old session. A too-short password
 * is rejected WITHOUT consuming the code so the user can retry.
 * @param {{ email?: string, token?: string, newPassword?: string }} input
 * @returns {{ ok: true }}
 */
export function confirmPasswordReset({ email, token, newPassword } = {}) {
  ensureDb();
  const normalizedEmail = normalizeEmail(email);
  const user = normalizedEmail ? getUserByEmail(normalizedEmail) : null;
  const code = String(token || "").trim();

  if (!user || !user.resetToken || !user.resetTokenExpiresAt) {
    throw makeError("BAD_REQUEST", "Invalid or expired reset code.", 400);
  }
  if (Number(user.resetTokenExpiresAt) <= nowEpochSec()) {
    user.resetToken = null;
    user.resetTokenExpiresAt = null;
    writeToDisk();
    throw makeError("BAD_REQUEST", "Invalid or expired reset code.", 400);
  }

  // Constant-time comparison so the code cannot be guessed by timing.
  const expected = Buffer.from(String(user.resetToken));
  const provided = Buffer.from(code);
  const matches = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  if (!matches) {
    throw makeError("BAD_REQUEST", "Invalid or expired reset code.", 400);
  }

  if (String(newPassword || "").length < 8) {
    throw makeError("BAD_REQUEST", "Password must be at least 8 characters.", 400);
  }

  const passwordRecord = hashPassword(newPassword);
  user.passwordHash = passwordRecord.hash;
  user.passwordSalt = passwordRecord.salt;
  user.passwordIterations = passwordRecord.iterations;
  user.resetToken = null;
  user.resetTokenExpiresAt = null;
  // Invalidate all existing sessions for this user after a password change.
  db.sessions = db.sessions.filter((session) => session.userId !== user.id);
  writeToDisk();

  return { ok: true };
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

/**
 * Returns a user's subscription tier ('free' | 'adventurer' | 'premium').
 * Defaults to 'free' for an unknown user or a missing/invalid stored value, so
 * the entitlement layer always has a concrete tier to gate against.
 * @param {string} userId
 * @returns {'free'|'adventurer'|'premium'}
 */
export function getUserTier(userId) {
  ensureDb();
  const user = getUserById(userId);
  return normalizeTier(user?.tier);
}

/**
 * Sets a user's subscription tier (manual assignment during beta — no payment
 * processor yet). Validates the tier, persists, and returns the sanitized user.
 * @param {string} userId
 * @param {'free'|'adventurer'|'premium'} tier
 * @returns {{ id: string, email: string, displayName: string, isAdmin: boolean, tier: string, createdAt: number }}
 */
export function setUserTier(userId, tier) {
  ensureDb();
  const value = String(tier || "").trim().toLowerCase();
  if (!USER_TIERS.includes(value)) {
    throw makeError("BAD_REQUEST", `Invalid tier. Expected one of: ${USER_TIERS.join(", ")}.`, 400);
  }
  const user = getUserById(userId);
  if (!user) {
    throw makeError("NOT_FOUND", "User not found.", 404);
  }
  user.tier = value;
  writeToDisk();
  return sanitizeUser(user);
}

// Reads the live daily-usage record for a user, rolling it over to today (UTC)
// when the stored date is stale. `persist=true` writes a rollover back so a
// fresh day starts from zero on disk; reads pass false to avoid a write per call.
function currentDailyUsage(userId, { persist = false } = {}) {
  const today = utcDateKey();
  const key = String(userId || "");
  if (!key) {
    return { date: today, images: 0, sessions: 0 };
  }
  let record = db.dailyUsageByUser[key];
  if (!record || typeof record !== "object" || record.date !== today) {
    record = { date: today, images: 0, sessions: 0, turns: 0 };
    if (persist) {
      db.dailyUsageByUser[key] = record;
    }
  }
  return record;
}

/**
 * Returns today's (UTC) entitlement usage for a user: image generations and
 * sessions started. Read-only — a stale day reads as zeroed without persisting.
 * @param {string} userId
 * @returns {{ date: string, images: number, sessions: number }}
 */
export function getDailyUsage(userId) {
  ensureDb();
  const record = currentDailyUsage(userId);
  return { date: record.date, images: Number(record.images) || 0, sessions: Number(record.sessions) || 0, turns: Number(record.turns) || 0 };
}

/**
 * Increments today's image-generation count for a user and persists it. Called
 * at actual generation time (the image worker), not at enqueue, so re-enqueued
 * in-flight jobs never double-count. Returns the new daily image count.
 * @param {string} userId
 * @returns {number}
 */
export function incrementImageCount(userId) {
  ensureDb();
  const key = String(userId || "");
  if (!key) {
    return 0;
  }
  const record = currentDailyUsage(userId, { persist: true });
  db.dailyUsageByUser[key] = record;
  record.images = (Number(record.images) || 0) + 1;
  writeToDisk();
  return record.images;
}

/**
 * Increments today's session-started count for a user and persists it. Returns
 * the new daily session count.
 * @param {string} userId
 * @returns {number}
 */
export function incrementSessionCount(userId) {
  ensureDb();
  const key = String(userId || "");
  if (!key) {
    return 0;
  }
  const record = currentDailyUsage(userId, { persist: true });
  db.dailyUsageByUser[key] = record;
  record.sessions = (Number(record.sessions) || 0) + 1;
  writeToDisk();
  return record.sessions;
}

/**
 * Increments today's GM-turn count for a user and persists it. Called when a paid
 * GM turn actually fires, so a guest turn cap (entitlements.canTakeGmTurn) can
 * bound anonymous paid spend. Returns the new daily turn count.
 * @param {string} userId
 * @returns {number}
 */
export function incrementTurnCount(userId) {
  ensureDb();
  const key = String(userId || "");
  if (!key) {
    return 0;
  }
  const record = currentDailyUsage(userId, { persist: true });
  db.dailyUsageByUser[key] = record;
  record.turns = (Number(record.turns) || 0) + 1;
  writeToDisk();
  return record.turns;
}

export function getCampaignRole(campaignId, context = {}) {
  ensureDb();
  assertActor(context);
  return userRoleForCampaign(context.actorUserId, campaignId);
}

export function assertCampaignReadAccess(campaignId, context = {}) {
  ensureDb();
  assertActor(context);
  assertCanReadCampaign(context.actorUserId, campaignId);
}

export function assertCampaignWriteAccess(campaignId, context = {}) {
  ensureDb();
  assertActor(context);
  assertCanWriteCampaign(context.actorUserId, campaignId);
}

export function assertCampaignPlayAccess(campaignId, context = {}) {
  ensureDb();
  assertActor(context);
  assertCanPlayCampaign(context.actorUserId, campaignId);
}

export function getCampaignRuntimeState(campaignId, context = {}) {
  ensureDb();
  if (!context.internal) {
    assertActor(context);
    assertCanReadCampaign(context.actorUserId, campaignId);
  }
  ensureCampaignRuntimeSlot(campaignId);
  return deepClone(db.campaignRuntimeByCampaign[campaignId]);
}

export function setCampaignRuntimeState(campaignId, patch = {}, context = {}) {
  ensureDb();
  if (!context.internal) {
    assertActor(context);
    assertCanPlayCampaign(context.actorUserId, campaignId);
  }
  ensureCampaignRuntimeSlot(campaignId);

  const prev = db.campaignRuntimeByCampaign[campaignId] || defaultCampaignRuntimeState();
  const nextMode = patch.mode === "combat" ? "combat" : patch.mode === "freeform" ? "freeform" : prev.mode;
  const nextInitiativeOrder = Array.isArray(patch.initiativeOrder) ? patch.initiativeOrder : prev.initiativeOrder;
  const nextPointer = Number.isFinite(Number(patch.turnPointer)) ? Number(patch.turnPointer) : prev.turnPointer;
  const nextTyping = patch.typingByUser && typeof patch.typingByUser === "object" ? patch.typingByUser : prev.typingByUser;

  db.campaignRuntimeByCampaign[campaignId] = {
    ...prev,
    ...patch,
    mode: nextMode,
    initiativeOrder: nextInitiativeOrder,
    turnPointer: Math.max(0, nextPointer),
    waitingForGm: patch.waitingForGm !== undefined ? Boolean(patch.waitingForGm) : Boolean(prev.waitingForGm),
    typingByUser: nextTyping,
    updatedAt: nowEpochSec()
  };

  bumpStateVersion(campaignId);
  writeToDisk();
  return deepClone(db.campaignRuntimeByCampaign[campaignId]);
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

export async function createQuickstartCampaignFromParsed({
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
  ensureCampaignRuntimeSlot(campaign.id);
  await ensureCampaignMemoryDocsAsync(campaign.id, blueprint.memoryDocs || {});

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
      ensureCampaignRuntimeSlot(id);
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

    case "delete_campaign": {
      const campaignId = String(payload.campaignId || "").trim();
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "campaignId is required", 400);
      }
      const role = userRoleForCampaign(actorUserId, campaignId);
      if (role !== "owner") {
        throw makeError("FORBIDDEN", "Only the campaign owner can delete it.", 403);
      }
      const exists = db.campaigns.some((entry) => entry.id === campaignId);
      if (!exists) {
        throw makeError("NOT_FOUND", "Campaign not found.", 404);
      }

      db.campaigns = db.campaigns.filter((entry) => entry.id !== campaignId);
      db.characters = (db.characters || []).filter((entry) => entry.campaignId !== campaignId);
      db.encounters = (db.encounters || []).filter((entry) => entry.campaignId !== campaignId);
      const removedMapIds = new Set(
        (db.maps || []).filter((entry) => entry.campaignId === campaignId).map((entry) => entry.id)
      );
      db.maps = (db.maps || []).filter((entry) => entry.campaignId !== campaignId);
      if (db.tokensByMap && typeof db.tokensByMap === "object") {
        for (const mapId of removedMapIds) {
          delete db.tokensByMap[mapId];
        }
      }
      db.chatLog = (db.chatLog || []).filter((entry) => entry.campaignId !== campaignId);
      db.aiJobs = (db.aiJobs || []).filter((entry) => entry.campaignId !== campaignId);
      delete db.campaignMembersByCampaign[campaignId];
      delete db.gmSettingsByCampaign[campaignId];
      delete db.journalsByCampaign[campaignId];
      delete db.recentRollsByCampaign[campaignId];
      delete db.campaignPackagesByCampaign[campaignId];
      delete db.campaignRuntimeByCampaign[campaignId];
      delete db.campaignVersions[campaignId];

      for (const [userId, prefs] of Object.entries(db.userPrefsByUser || {})) {
        if (prefs?.selectedCampaignId === campaignId) {
          db.userPrefsByUser[userId] = { selectedCampaignId: null };
        }
      }
      if (db.selectedCampaignId === campaignId) {
        db.selectedCampaignId = db.campaigns[0]?.id || null;
      }

      writeToDisk();
      return { ok: true, campaignId };
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

    case "set_campaign_runtime_state": {
      const campaignId = selectedCampaignId(payload, actorUserId, context);
      if (!campaignId) {
        throw makeError("BAD_REQUEST", "No campaign selected.", 400);
      }
      assertCanPlayCampaign(actorUserId, campaignId);
      const runtime = setCampaignRuntimeState(
        campaignId,
        {
          mode: payload.mode,
          initiativeOrder: payload.initiativeOrder,
          turnPointer: payload.turnPointer,
          waitingForGm: payload.waitingForGm,
          typingByUser: payload.typingByUser
        },
        { internal: true }
      );
      return { campaignId, runtime };
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
