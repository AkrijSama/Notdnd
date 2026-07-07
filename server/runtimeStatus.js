// ---------------------------------------------------------------------------
// Runtime status — the single source of truth for "what is LIVE right now".
//
// Exists because the same question kept costing sessions of confusion: which
// BUILD is the server on, which GM model is ACTUALLY serving turns (configured
// vs served can diverge silently on a 429→fallback), and which image provider
// actually rendered. The server logs already carry this — this module captures
// the same facts into memory so a human (via the /api/debug/status endpoint and
// the in-app debug panel) can glance instead of grepping.
//
// Two record points feed it: the GM serving path (openrouter.js, at the moment a
// call returns) and the image path (providers.js, at a successful render). Both
// record the ACTUAL served attribution, never the configured intent.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

// --- BUILD: git tip the running server was launched from --------------------
// Resolved once (a spawn per request would be wasteful) and cached. Env overrides
// (INKBORNE_BUILD_SHA / _BRANCH) win so a deploy that builds outside a git
// checkout can still stamp the build; otherwise we read git at first ask.
let cachedBuild = null;
function gitValue(args) {
  try {
    return String(execFileSync("git", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch {
    return "";
  }
}
export function getBuildInfo() {
  if (cachedBuild) {
    return cachedBuild;
  }
  const sha = String(process.env.INKBORNE_BUILD_SHA || "").trim() || gitValue(["rev-parse", "--short", "HEAD"]);
  const branch = String(process.env.INKBORNE_BUILD_BRANCH || "").trim() || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = process.env.INKBORNE_BUILD_SHA ? false : gitValue(["status", "--porcelain"]).length > 0;
  cachedBuild = {
    sha: sha || "unknown",
    branch: branch || "unknown",
    dirty,
    nodeEnv: String(process.env.NODE_ENV || "development"),
    startedAt: new Date().toISOString()
  };
  return cachedBuild;
}

// The debug panel is ON by default in dev, OFF in production. The client persists
// an explicit user toggle, but this is the initial default when none is stored.
export function debugPanelDefault() {
  return getBuildInfo().nodeEnv !== "production";
}

// --- GM: the model that ACTUALLY served the last narrative turn --------------
// { tier, model, provider, latencyMs, local, fallback, configuredModel, at }
let lastGmServe = null;
export function recordGmServe(rec = {}) {
  lastGmServe = {
    tier: rec.tier || "narrative",
    model: rec.model || "unknown",
    provider: rec.provider || "unknown",
    latencyMs: Number.isFinite(rec.latencyMs) ? rec.latencyMs : null,
    local: Boolean(rec.local),
    fallback: Boolean(rec.fallback),
    configuredModel: rec.configuredModel || null,
    at: new Date().toISOString()
  };
}
export function getGmServe() {
  return lastGmServe;
}

// --- IMAGE: the provider/checkpoint that ACTUALLY rendered the last image -----
// { provider, model, checkpoint, mock, at }
let lastImageServe = null;
export function recordImageServe(rec = {}) {
  lastImageServe = {
    provider: rec.provider || "unknown",
    model: rec.model || null,
    checkpoint: rec.checkpoint || null,
    mock: Boolean(rec.mock),
    at: new Date().toISOString()
  };
}
export function getImageServe() {
  return lastImageServe;
}
