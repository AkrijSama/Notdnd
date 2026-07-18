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

// --- BUILD: the identity of the RUNNING PROCESS, not a request-time disk read -
// Two truths that DIVERGE and must both be told (learned the hard way twice):
//   • LOADED code — Node loads server modules ONCE at boot, so the backend logic
//     is frozen at the boot checkout. A 2026-07-18 incident: a 20h-old process
//     served pre-fix code while a disk-tracking badge showed the fixed SHA, so the
//     "stale process" was invisible. The badge MUST report the loaded SHA.
//   • DISK checkout — the client bundle is served from disk per request, so after
//     a pull/commit it moves while the process stays (the 2026-07-09 "66d8a72 while
//     serving fb48ed9" incident). Tracked live so divergence is visible.
// So: `sha`/`startedAt` are FROZEN at boot (the loaded code — the process's true
// identity); `diskSha` tracks the live checkout; `stale` (diskSha !== sha) is the
// loud "restart needed" flag that would have caught both incidents. Env overrides
// (INKBORNE_BUILD_SHA/_BRANCH) win for out-of-checkout deploys.
const DISK_TTL_MS = 30_000;
let bootBuild = null; // frozen at first call = the loaded code, process-lifetime
let cachedDiskSha = null;
let cachedDiskAt = 0;
function gitValue(args) {
  try {
    return String(execFileSync("git", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch {
    return "";
  }
}

// Capture the loaded-code identity ONCE. Call at server boot so `startedAt` marks
// the real process start (not the first debug request). Idempotent.
export function initBuildInfo() {
  if (bootBuild) {
    return bootBuild;
  }
  const envSha = String(process.env.INKBORNE_BUILD_SHA || "").trim();
  const sha = envSha || gitValue(["rev-parse", "--short", "HEAD"]);
  const branch = String(process.env.INKBORNE_BUILD_BRANCH || "").trim() || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = envSha ? false : isTrackedSourceDirty(gitValue(["status", "--porcelain"]));
  bootBuild = {
    sha: sha || "unknown",
    branch: branch || "unknown",
    dirty,
    nodeEnv: String(process.env.NODE_ENV || "development"),
    startedAt: new Date().toISOString()
  };
  return bootBuild;
}

// Dirty = a TRACKED file differs from HEAD, excluding known runtime churn the
// server itself writes inside the repo (the waitlist db; anything under data/).
// Untracked files never count — `??` noise (campaign dirs, logs, reports) made
// the flag permanently true and therefore meaningless.
const RUNTIME_CHURN_RE = /^(?:server\/db\/waitlist\.json|data\/)/;
export function isTrackedSourceDirty(porcelain) {
  return String(porcelain || "")
    .split("\n")
    .map((line) => line.trim()) // column-agnostic: gitValue trims output, which
    .filter((line) => line.length > 0) // eats the first line's leading status space
    .some((line) => {
      if (line.startsWith("??")) return false; // untracked never counts
      // "<status> <path>" — status is the first token ("M", "MM", "R", …).
      const rest = line.replace(/^\S{1,2}\s+/, "");
      // renames read "old -> new" — judge the destination path.
      const file = rest.includes(" -> ") ? rest.split(" -> ").pop() : rest;
      return !RUNTIME_CHURN_RE.test(file);
    });
}

export function getBuildInfo() {
  // LOADED code — frozen at boot. This is the running process's true identity.
  const boot = initBuildInfo();
  const envSha = String(process.env.INKBORNE_BUILD_SHA || "").trim();
  // DISK checkout — live (cheap TTL). With an env-stamped build there is no git
  // checkout to diverge, so disk == loaded by definition.
  let diskSha = boot.sha;
  if (!envSha) {
    const now = Date.now();
    if (cachedDiskSha === null || now - cachedDiskAt >= DISK_TTL_MS) {
      cachedDiskSha = gitValue(["rev-parse", "--short", "HEAD"]) || boot.sha;
      cachedDiskAt = now;
    }
    diskSha = cachedDiskSha;
  }
  return {
    ...boot,
    diskSha,
    // The loud restart signal: disk has moved past the code this process loaded.
    stale: diskSha !== boot.sha
  };
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
