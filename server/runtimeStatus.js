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

// --- BUILD: git tip of the CHECKOUT the server is serving --------------------
// Cached with a short TTL (not process-lifetime): a long-lived dev server serves
// client files from disk per request, so after a pull/commit the checkout moves
// while the process stays — a boot-frozen badge then lies for the process's whole
// life (the 2026-07-09 "66d8a72 while serving fb48ed9" incident). Env overrides
// (INKBORNE_BUILD_SHA / _BRANCH) win so a deploy that builds outside a git
// checkout can still stamp the build; those are truly static, so they cache forever.
const BUILD_TTL_MS = 30_000;
let cachedBuild = null;
let cachedBuildAt = 0;
let bootStartedAt = null;
function gitValue(args) {
  try {
    return String(execFileSync("git", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch {
    return "";
  }
}

// Dirty = a TRACKED file differs from HEAD, excluding known runtime churn the
// server itself writes inside the repo (the waitlist db; anything under data/).
// Untracked files never count — `??` noise (campaign dirs, logs, reports) made
// the flag permanently true and therefore meaningless.
const RUNTIME_CHURN_RE = /^(?:server\/db\/waitlist\.json|data\/)/;
export function isTrackedSourceDirty(porcelain) {
  return String(porcelain || "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .some((line) => {
      const status = line.slice(0, 2);
      if (status === "??") return false; // untracked never counts
      const rest = line.slice(3).trim();
      // renames read "old -> new" — judge the destination path.
      const file = rest.includes(" -> ") ? rest.split(" -> ").pop() : rest;
      return !RUNTIME_CHURN_RE.test(file);
    });
}

export function getBuildInfo() {
  const envSha = String(process.env.INKBORNE_BUILD_SHA || "").trim();
  const now = Date.now();
  if (cachedBuild && (envSha || now - cachedBuildAt < BUILD_TTL_MS)) {
    return cachedBuild;
  }
  if (!bootStartedAt) {
    bootStartedAt = new Date().toISOString();
  }
  const sha = envSha || gitValue(["rev-parse", "--short", "HEAD"]);
  const branch = String(process.env.INKBORNE_BUILD_BRANCH || "").trim() || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = envSha ? false : isTrackedSourceDirty(gitValue(["status", "--porcelain"]));
  cachedBuild = {
    sha: sha || "unknown",
    branch: branch || "unknown",
    dirty,
    nodeEnv: String(process.env.NODE_ENV || "development"),
    startedAt: bootStartedAt
  };
  cachedBuildAt = now;
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
