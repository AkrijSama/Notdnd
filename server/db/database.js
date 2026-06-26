import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// SQLite connection + schema for the NotDND data store.
//
// Replaces the old whole-file JSON rewrite (server/db/notdnd.db.json), which
// had no locking or atomicity — concurrent writes corrupted the file and an
// ephemeral-host redeploy wiped it. SQLite gives us atomic, durable writes
// with real locking (WAL mode), while the repository keeps its in-memory
// working set and persists it transactionally.
//
// Schema (the four primary entities get their own tables; everything else in
// the repository's in-memory db is JSON in the `kv` catch-all so no top-level
// key is ever dropped):
//   users     — id, email, displayName, passwordHash, isAdmin, createdAt + data blob
//   sessions  — token, userId, createdAt, expiresAt + data blob
//   campaigns — id (= solo runId), userId, data blob (full run state)
//   waitlist  — id, email, createdAt + data blob
//   kv        — key/value JSON for every other repository top-level key
//
// Each entity row keeps a full JSON `data` blob as the source of truth, so the
// evolving run/user/session shapes round-trip exactly without a schema
// migration on every feature addition; the extra columns are denormalized for
// inspectability/future queries.
// ---------------------------------------------------------------------------

let connection = null;
let connectionPath = null;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    displayName TEXT,
    passwordHash TEXT,
    isAdmin INTEGER DEFAULT 0,
    createdAt INTEGER,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT,
    createdAt INTEGER,
    expiresAt INTEGER,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    userId TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    email TEXT,
    createdAt INTEGER,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function applySchema(db) {
  // WAL gives concurrent readers + a single writer without the whole-file
  // corruption the JSON store suffered; NORMAL sync is the standard durable
  // pairing with WAL.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
}

/**
 * Returns a singleton better-sqlite3 connection for the given path, creating
 * the file/dir and schema on first use. Re-opens if the requested path changes
 * (e.g. a test pointing at a fresh temp DB). Pass ":memory:" for an ephemeral
 * in-memory database.
 * @param {string} sqlitePath
 * @returns {import("better-sqlite3").Database}
 */
export function getDatabase(sqlitePath) {
  const target = sqlitePath || ":memory:";
  if (connection && connectionPath === target) {
    return connection;
  }
  if (connection) {
    try {
      connection.close();
    } catch {
      // best-effort; opening the new connection is what matters
    }
    connection = null;
    connectionPath = null;
  }

  if (target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  connection = new Database(target);
  applySchema(connection);
  connectionPath = target;
  return connection;
}

/**
 * Closes the active connection (used by tests/teardown). No-op if none open.
 */
export function closeDatabase() {
  if (connection) {
    try {
      connection.close();
    } catch {
      // ignore
    }
    connection = null;
    connectionPath = null;
  }
}
