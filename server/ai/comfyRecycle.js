// ---------------------------------------------------------------------------
// COMFYUI IDLE/SIZE-TRIGGERED RECYCLE (owner stamp 2026-07-22).
//
// THE PROBLEM (JOB 1 diagnosis, 04ff6c5): ComfyUI accumulates RSS unboundedly over a
// session. After ~5.5h it reached the 24G cgroup leash (MemoryHigh=24G / MemoryMax=28G,
// systemd-run --user) and began disk-thrashing; a cook took 972s and tripped the 240s
// COMFYUI_TIMEOUT_MS. A restart cleared it (a cold portrait then cooked 51.2s @ 14.4G).
// Raising the cap only delays an unbounded leak.
//
// THE MITIGATION (NOT a fix — see docs/design/comfyui-recycle.md): recycle ComfyUI when
// its cgroup RSS crosses a threshold (default 20G, BELOW the 24G MemoryHigh so it acts
// BEFORE thrash begins). The recycle relaunches under the SAME systemd-run memory leash
// via scripts/comfyui-server.sh --restart — NEVER a bare process that would escape the
// cgroup (that would reintroduce the kernel-confirmed ~50G freeze class).
//
// NEVER MID-COOK: the primary trigger runs at the START of a serialized cook slot
// (resourceGate.withCookSlot), where no cook is in flight; it ADDITIONALLY refuses if
// ComfyUI's own /queue shows a running job. An idle monitor recycles between sessions.
//
// PURE-ish: node built-ins only (child_process/path/url). On a box with no ComfyUI unit
// (CI, a hosted ComfyUI, the placeholder provider) every probe returns null and this is a
// no-op — we never recycle a unit we cannot measure.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/comfyui-server.sh");

// Law-6 tunables (env). Default 20G is below the 24G MemoryHigh: recycle BEFORE thrash.
export const recycleRssFloorMb = () => num(process.env.NOTDND_COMFY_RECYCLE_RSS_MB, 20000);
export const recycleEnabled = () => String(process.env.NOTDND_COMFY_RECYCLE ?? "true").toLowerCase() !== "false";
const restartTimeoutMs = () => num(process.env.NOTDND_COMFY_RECYCLE_RESTART_TIMEOUT_MS, 180000);

function comfyPort() {
  const url = process.env.NOTDND_COMFYUI_URL || process.env.INKBORNE_COMFYUI_URL || "http://127.0.0.1:8188";
  const m = url.match(/:(\d+)/);
  return m ? m[1] : "8188";
}
const unitName = () => `comfyui-${comfyPort()}`;

// ── observability state (Job 1.4 / 1.5): counters split by reason so a recycle
//    STORM — especially an "unresponsive" one that could hide a crash loop — is legible.
const state = {
  rssRecycleCount: 0,
  unresponsiveRecycleCount: 0,
  lastRecycleAt: null,
  lastReason: null,
  lastRssBeforeMb: null,
  lastRssAfterMb: null,
  lastDowntimeMs: null,
  lastQueueDepthAtRecycle: null,
  lastMeasuredRssMb: null,
  lastMeasuredAt: null
};
let _recycleInFlight = null; // a promise-guard so the timer + the cook path never double-restart

// Test seam ONLY (never set in production): inject the rss/queue probes and stub the
// restart, so the never-mid-cook DEFER decision and the fire decision are deterministically
// testable without a live ComfyUI. The LIVE recycle path is verified by forcing the real
// condition (Job 4), not by these hooks.
let _testHooks = null;
export function __setComfyRecycleTestHooks(hooks) { _testHooks = hooks; }

// ── probes ───────────────────────────────────────────────────────────────────
// cgroup RSS in MiB via `systemctl --user show <unit> -p MemoryCurrent` — the SAME
// accounting the leash enforces. null when there is no unit (not our box).
export async function comfyRssMb() {
  if (_testHooks && "rssMb" in _testHooks) { const mb = _testHooks.rssMb; if (mb != null) { state.lastMeasuredRssMb = mb; state.lastMeasuredAt = Date.now(); } return mb; }
  try {
    const { stdout } = await exec("systemctl", ["--user", "show", unitName(), "-p", "MemoryCurrent", "--value"], { timeout: 4000 });
    const bytes = Number(String(stdout).trim());
    const mb = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
    if (mb != null) { state.lastMeasuredRssMb = mb; state.lastMeasuredAt = Date.now(); }
    return mb;
  } catch {
    return null;
  }
}

// Is the unit active (leashed + running)? Used to tell "not our box" from "wedged".
async function unitActive() {
  if (_testHooks && "unitActive" in _testHooks) return _testHooks.unitActive;
  try {
    const { stdout } = await exec("systemctl", ["--user", "show", unitName(), "-p", "ActiveState", "--value"], { timeout: 4000 });
    return String(stdout).trim() === "active";
  } catch {
    return false;
  }
}

// ComfyUI /queue depth. reachable:false = the HTTP API did not answer (wedged, or down).
export async function comfyQueue() {
  if (_testHooks && _testHooks.queue) return _testHooks.queue;
  const port = comfyPort();
  try {
    const { stdout } = await exec("curl", ["-s", "--max-time", "4", `http://127.0.0.1:${port}/queue`], { timeout: 6000 });
    const j = JSON.parse(stdout);
    return { running: (j.queue_running || []).length, pending: (j.queue_pending || []).length, reachable: true };
  } catch {
    return { running: 0, pending: 0, reachable: false };
  }
}

// ── the recycle (relaunch under the SAME leash) ───────────────────────────────
async function doRecycle(reason, rssBeforeMb, queueDepth) {
  if (_recycleInFlight) return _recycleInFlight; // never double-restart
  _recycleInFlight = (async () => {
    const t0 = Date.now();
    console.log(`[comfy-recycle] START reason=${reason} rss_before=${rssBeforeMb}MB queue_running=${queueDepth} unit=${unitName()}`);
    let ok = true;
    try {
      if (_testHooks && _testHooks.restart) {
        await _testHooks.restart(reason); // test stub — never a real restart
      } else {
        // scripts/comfyui-server.sh <port> --restart: kill-by-port + VERIFIED leashed
        // relaunch (systemd-run --user with MemoryHigh/MemoryMax). NEVER a bare process.
        await exec("bash", [SCRIPT, comfyPort(), "--restart"], { timeout: restartTimeoutMs() });
      }
    } catch (e) {
      ok = false;
      console.error(`[comfy-recycle] restart script FAILED reason=${reason}: ${e?.message || e}`);
    }
    const rssAfterMb = await comfyRssMb();
    const downtimeMs = Date.now() - t0;
    if (reason === "unresponsive") state.unresponsiveRecycleCount += 1;
    else state.rssRecycleCount += 1;
    state.lastRecycleAt = new Date().toISOString();
    state.lastReason = reason;
    state.lastRssBeforeMb = rssBeforeMb;
    state.lastRssAfterMb = rssAfterMb;
    state.lastDowntimeMs = downtimeMs;
    state.lastQueueDepthAtRecycle = queueDepth;
    console.log(`[comfy-recycle] DONE reason=${reason} ok=${ok} rss_before=${rssBeforeMb}MB rss_after=${rssAfterMb}MB downtime=${downtimeMs}ms rss_count=${state.rssRecycleCount} unresponsive_count=${state.unresponsiveRecycleCount}`);
    return { ok, reason, rssBeforeMb, rssAfterMb, downtimeMs };
  })();
  try {
    return await _recycleInFlight;
  } finally {
    _recycleInFlight = null;
  }
}

// ── the BEFORE-COOK trigger (Job 1.3 primary) ─────────────────────────────────
// Called at the START of a serialized cook slot (resourceGate.withCookSlot), so no
// cook is in flight. Recycles when RSS >= floor and the queue is drained. Distinguishes
// an RSS-threshold recycle (the leak) from an UNRESPONSIVE one (wedged) — logged and
// counted separately so a crash loop cannot hide behind the leak recycle (Job 3.3).
export async function maybeRecycleComfyBeforeCook(label = "cook") {
  if (!recycleEnabled()) return { recycled: false, disabled: true };
  const rss = await comfyRssMb();
  if (rss == null) {
    // No measurable unit → not our leashed ComfyUI (hosted/CI/placeholder). Never recycle.
    // But if the URL points at a local unit that is DOWN/wedged, distinguish it:
    return { recycled: false, unmeasurable: true };
  }
  const q = await comfyQueue();
  // WEDGED: the unit is active (leashed process alive) but its HTTP API does not answer.
  // A cook against it would fail. Recycle with a DISTINCT reason + counter (Job 3.3) so a
  // repeated wedge is visible as a storm, not silently masked as a normal RSS recycle.
  if (!q.reachable && (await unitActive())) {
    console.warn(`[comfy-recycle] UNRESPONSIVE: unit active but /queue did not answer (rss ${rss}MB) — recycling (reason=unresponsive)`);
    await doRecycle("unresponsive", rss, null);
    return { recycled: true, reason: "unresponsive", rssMb: rss };
  }
  if (rss < recycleRssFloorMb()) return { recycled: false, rssMb: rss };
  if (q.reachable && q.running > 0) {
    // NEVER MID-COOK: a job is in flight — refuse, re-check on the next slot.
    console.log(`[comfy-recycle] DEFERRED: rss ${rss}MB >= floor ${recycleRssFloorMb()}MB but queue_running=${q.running} (never mid-cook)`);
    return { recycled: false, deferred: true, rssMb: rss };
  }
  await doRecycle("rss_threshold", rss, q.running);
  return { recycled: true, reason: "rss_threshold", rssMb: rss };
}

// ── the IDLE monitor (Job 2.3) ────────────────────────────────────────────────
// Absorbs the cold-start BETWEEN sessions: on an interval, if ComfyUI is idle (queue
// empty) and RSS is over the floor, recycle now rather than in front of the next player.
// Cheap, self-guarded against the cook-path recycle. Returns a stop() handle.
let _monitorTimer = null;
export function startComfyRecycleMonitor({ intervalMs = num(process.env.NOTDND_COMFY_RECYCLE_MONITOR_MS, 300000) } = {}) {
  if (_monitorTimer || !recycleEnabled()) return () => {};
  const tick = async () => {
    try {
      if (_recycleInFlight) return; // a cook-path recycle is already running
      const rss = await comfyRssMb();
      if (rss == null || rss < recycleRssFloorMb()) return;
      const q = await comfyQueue();
      if (q.reachable && (q.running > 0 || q.pending > 0)) return; // not idle — leave it to the cook path
      console.log(`[comfy-recycle] IDLE recycle: rss ${rss}MB >= floor ${recycleRssFloorMb()}MB, queue idle — absorbing the cold start now`);
      await doRecycle("rss_threshold_idle", rss, 0);
    } catch (e) {
      console.error(`[comfy-recycle] monitor tick error: ${e?.message || e}`);
    }
  };
  _monitorTimer = setInterval(tick, Math.max(30000, intervalMs));
  if (typeof _monitorTimer.unref === "function") _monitorTimer.unref(); // never keep the process alive
  return () => { if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; } };
}

// ── status for /api/debug/status (Job 1.5) ────────────────────────────────────
export function comfyRecycleStatus() {
  return {
    enabled: recycleEnabled(),
    rssFloorMb: recycleRssFloorMb(),
    lastMeasuredRssMb: state.lastMeasuredRssMb,
    lastMeasuredAt: state.lastMeasuredAt ? new Date(state.lastMeasuredAt).toISOString() : null,
    rssRecycleCount: state.rssRecycleCount,
    unresponsiveRecycleCount: state.unresponsiveRecycleCount,
    lastRecycleAt: state.lastRecycleAt,
    lastReason: state.lastReason,
    lastRssBeforeMb: state.lastRssBeforeMb,
    lastRssAfterMb: state.lastRssAfterMb,
    lastDowntimeMs: state.lastDowntimeMs,
    lastQueueDepthAtRecycle: state.lastQueueDepthAtRecycle
  };
}

// Test seam: reset counters (used by the harness/tests only).
export function __resetComfyRecycleState() {
  Object.assign(state, {
    rssRecycleCount: 0, unresponsiveRecycleCount: 0, lastRecycleAt: null, lastReason: null,
    lastRssBeforeMb: null, lastRssAfterMb: null, lastDowntimeMs: null, lastQueueDepthAtRecycle: null,
    lastMeasuredRssMb: null, lastMeasuredAt: null
  });
}
