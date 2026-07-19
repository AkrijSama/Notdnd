// HTTP REQUEST LOG (2026-07-18). The play server logged NO requests, so during
// the login diagnosis we were blind to the owner's auth attempts (their statuses,
// timing, and identity). This records one greppable JSONL line per /api request:
// method, path, status, duration, the INBOUND identity (userId, or "guest"/"anon"),
// and a timestamp. Auth endpoints are ALWAYS logged; static/asset serving is
// excluded as noise. Bodies, passwords, and tokens are NEVER logged. A small
// in-memory ring of the last auth events feeds /api/debug/status (family with the
// image.worker health line). Best-effort: logging never throws into a request.
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "data/logs");
const LOG_FILE = path.join(LOG_DIR, "requests.jsonl");
const MAX_BYTES = 5 * 1024 * 1024; // rotate at ~5MB, keeping one prior generation
const AUTH_RING = 5;
const recentAuth = [];

export function isAuthPath(pathname) {
  return String(pathname || "").startsWith("/api/auth/");
}

// Only /api traffic is logged; static/asset serving is excluded as noise.
export function shouldLogRequest(pathname) {
  return String(pathname || "").startsWith("/api/");
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); // one previous generation is kept
    }
  } catch {
    // no file yet (or stat failed) → nothing to rotate
  }
}

/**
 * Records one request. The identity is the INBOUND identity resolved from the
 * session token: for /api/auth/login the inbound identity is the guest/none making
 * the attempt, and the STATUS conveys the outcome (200 ok, 401/409 failure). No
 * body / password / token is ever passed in or stored. Never throws.
 * @param {{ method?: string, path?: string, status?: number, durationMs?: number, userId?: string|null, isGuest?: boolean }} entry
 */
export function recordRequest({ method, path: pathname, status, durationMs, userId = null, isGuest = false } = {}) {
  if (!shouldLogRequest(pathname)) {
    return;
  }
  const rec = {
    at: new Date().toISOString(),
    method: String(method || ""),
    path: String(pathname || ""),
    status: Number(status) || 0,
    ms: Math.max(0, Math.round(Number(durationMs) || 0)),
    who: userId ? String(userId) : isGuest ? "guest" : "anon"
  };
  if (isAuthPath(pathname)) {
    recentAuth.push(rec);
    if (recentAuth.length > AUTH_RING) {
      recentAuth.splice(0, recentAuth.length - AUTH_RING);
    }
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(rec)}\n`);
  } catch {
    // disk/log failure must never break a request
  }
}

// The last N auth events for /api/debug/status (newest last).
export function lastAuthEvents(n = AUTH_RING) {
  return recentAuth.slice(-Math.max(0, n));
}
