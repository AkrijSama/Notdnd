// ---------------------------------------------------------------------------
// COOK RESOURCE GATE — Law-6 for the GPU (the stabilizer law, owner 2026-07-21).
//
// THE LESSON: a batch of W7 exemplar cooks froze the whole machine. The old
// GPU-safety check (scripts/art/generate.mjs::assertSafeWindow) had a 1024 MiB
// floor and only re-checked VRAM between CHUNKS OF 10 — so ten cold JANKU/nihilmania
// `--novram` renders queued back-to-back, each streaming weights into system RAM,
// drove VRAM + RAM + swap into thrash and hung the desktop. No kernel OOM-kill;
// the machine simply starved and froze.
//
// THE RULE: before EVERY ComfyUI job, check free VRAM *and* system-RAM headroom
// against a floor. Insufficient => SKIP AND MARK PENDING, never queue into a
// starving machine. When the desktop shares the card (a DISPLAY is attached),
// cooks additionally drop to strictly-sequential with a cool-down between jobs so
// the display never loses its slice mid-render.
//
// PURE by design — node built-ins only (child_process/os/fs). It carries no db or
// server import chain, so the offline batch tools (scripts/art) may import it
// without coupling to the server. On a machine with no `nvidia-smi` (CI, the
// placeholder provider) the VRAM check is a NO-OP — we never block a machine we
// cannot measure.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Floors are env-tunable so a dedicated headless render box can lower them and a
// shared desktop can raise them. Defaults are sized for the owner's 8 GB RTX 4060
// shared with the KDE desktop (~1.2 GB baseline) + occasional games: a cold
// JANKU/nihilmania `--novram` render needs real VRAM working headroom, and because
// `--novram` offloads weights to system RAM, RAM headroom starves just as hard.
export const cookVramFloorMb = () => num(process.env.NOTDND_COOK_VRAM_FLOOR_MB, 3000);
export const cookRamFloorMb = () => num(process.env.NOTDND_COOK_RAM_FLOOR_MB, 6000);
export const cookCooldownMs = () => num(process.env.NOTDND_COOK_COOLDOWN_MS, 4000);

// The whole gate can be disabled (a truly dedicated render box, or a test harness
// that wants the old unguarded behaviour). Default ON.
export function gateEnabled() {
  return String(process.env.NOTDND_COOK_RESOURCE_GATE ?? "true").toLowerCase() !== "false";
}

// Free / used / total VRAM in MiB via nvidia-smi. ok:false when nvidia-smi is
// absent or unparseable — the caller treats an unmeasurable GPU as "don't block".
export function gpuMemoryMb() {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.free,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 4000 }
    );
    const line = String(out).trim().split("\n")[0] || "";
    const [free, used, total] = line.split(",").map((s) => Number(String(s).trim()));
    const ok = Number.isFinite(free) && Number.isFinite(total);
    return { free: ok ? free : null, used: Number.isFinite(used) ? used : null, total: ok ? total : null, ok };
  } catch {
    return { free: null, used: null, total: null, ok: false };
  }
}

// Usable system RAM in MiB. Prefer /proc/meminfo MemAvailable (reclaimable cache
// counts as usable); fall back to os.freemem() where /proc is absent.
export function systemAvailableMb() {
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const m = mi.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* not linux / no /proc — fall through */
  }
  return Math.round(os.freemem() / 1024 / 1024);
}

// Does the display share the render card? A DISPLAY (or Wayland socket) attached to
// this process means an interactive desktop is on the same GPU — cooks must be
// strictly sequential + cooled. A headless render box has neither. Force with
// NOTDND_COOK_FORCE_SEQUENTIAL=1.
export function desktopSharesCard() {
  if (num(process.env.NOTDND_COOK_FORCE_SEQUENTIAL, 0) === 1) return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// The measured verdict. `ok` = safe to start a cook right now.
export function cookResourceStatus() {
  const gpu = gpuMemoryMb();
  const freeRamMb = systemAvailableMb();
  const vramFloor = cookVramFloorMb();
  const ramFloor = cookRamFloorMb();
  // An unmeasurable GPU (no nvidia-smi) never blocks — we do not starve-guard a
  // machine we cannot read (CI, placeholder provider, non-comfy hosts).
  const vramOk = !gpu.ok || gpu.free >= vramFloor;
  const ramOk = freeRamMb >= ramFloor;
  const ok = vramOk && ramOk;
  let reason = "";
  if (!vramOk) reason = `free VRAM ${gpu.free} MiB < floor ${vramFloor} MiB`;
  else if (!ramOk) reason = `available system RAM ${freeRamMb} MiB < floor ${ramFloor} MiB`;
  return {
    ok,
    reason,
    freeVramMb: gpu.free,
    usedVramMb: gpu.used,
    totalVramMb: gpu.total,
    gpuMeasured: gpu.ok,
    freeRamMb,
    vramFloor,
    ramFloor,
    desktopSharesCard: desktopSharesCard()
  };
}

// Throw a classified RESOURCE_GATE_BLOCKED (retryable) when the machine is starving.
// Callers catch by `.code` to SKIP-AND-MARK-PENDING rather than queue the job.
export function assertCookResources(label = "cook") {
  if (!gateEnabled()) return { ok: true, reason: "", disabled: true };
  const status = cookResourceStatus();
  if (!status.ok) {
    const err = new Error(
      `RESOURCE_GATE: ${label} skipped — ${status.reason} (Law-6: never queue into a starving machine)`
    );
    err.code = "RESOURCE_GATE_BLOCKED";
    err.retryable = true;
    err.status = status;
    throw err;
  }
  return status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// Strictly-sequential cook slot with a desktop-share cool-down. Every cook routes
// through here: a module-level promise chain serialises them (one GPU can only
// render one thing at a time; parallel cooks only thrash), and when the desktop
// shares the card we hold a cool-down since the previous cook finished so the
// display reclaims its slice before the next render starts. The resource gate is
// re-asserted AFTER acquiring the slot (headroom may have changed while queued).
let _chain = Promise.resolve();
let _lastCookEndedAt = 0;

export async function withCookSlot(label, fn) {
  if (!gateEnabled()) return fn();
  const run = async () => {
    if (desktopSharesCard() && _lastCookEndedAt) {
      const since = Date.now() - _lastCookEndedAt;
      const cd = cookCooldownMs();
      if (since < cd) await sleep(cd - since);
    }
    assertCookResources(label);
    try {
      return await fn();
    } finally {
      _lastCookEndedAt = Date.now();
    }
  };
  // Serialise regardless of the previous cook's outcome; never let one rejection
  // poison the chain for the next caller.
  const p = _chain.then(run, run);
  _chain = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

// Human-readable one-liner for logs / reports.
export function formatCookStatus(s = cookResourceStatus()) {
  const vram = s.gpuMeasured ? `VRAM ${s.freeVramMb}/${s.totalVramMb}MiB free` : "VRAM n/a (no nvidia-smi)";
  return `${vram}, RAM ${s.freeRamMb}MiB avail, floors ${s.vramFloor}/${s.ramFloor}MiB, desktop-shares=${s.desktopSharesCard} => ${s.ok ? "OK" : "BLOCKED: " + s.reason}`;
}
