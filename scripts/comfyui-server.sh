#!/usr/bin/env bash
# Canonical ComfyUI launcher — MEMORY-LEASHED + GPU-safe + supervised.
#
# Why this exists (2026-07-21 kernel-confirmed freeze #1): ComfyUI (pid 872553)
# ballooned to ~50 GB anon-rss and was OOM-killed at 02:29 — but the OOM-killer
# reaping a 50 GB process on a shared desktop box takes the whole machine down with
# it (thrash, then hard-hang). The fix is a cgroup MEMORY LEASH: launch ComfyUI in a
# transient systemd unit with MemoryHigh/MemoryMax set, so the kernel THROTTLES and
# reclaims inside the cgroup (and, at the ceiling, OOM-kills ONLY this cgroup —
# ComfyUI dies, the box lives) instead of executing a box-wide OOM. Law-6: the cap is
# a per-machine parameter, env-tunable, never a hardcoded rule.
#
# GPU: `--novram` is mandatory on this 8 GB RTX 4060 shared with the KDE desktop
# (the ORIGINAL 2026-07-07 8GB-freeze constraint). Weights stream from system RAM —
# which is exactly why the RAM leash matters: --novram trades VRAM pressure for RAM
# pressure, and unbounded RAM is what killed the box.
#
# Supervision: a transient `systemd-run --user` SERVICE (not a bare setsid) so the
# process is detached, reaper-safe, AND its limits are inspectable
# (`systemctl --user status comfyui-<port>`). This is the ComfyUI sibling of
# scripts/play-server.sh's detached/supervised guarantee.
#
# Usage:
#   scripts/comfyui-server.sh [PORT]            # leashed + --novram + detached (default PORT 8188)
#   scripts/comfyui-server.sh 8188 --restart    # kill-by-port + verified leashed relaunch
#   scripts/comfyui-server.sh 8188 --status     # print the unit + its memory leash rows
#
# Tunables (Law-6, env):
#   NOTDND_COMFY_MEM_HIGH   soft throttle boundary   (default 24G)
#   NOTDND_COMFY_MEM_MAX    hard cgroup ceiling      (default 28G)
#   NOTDND_COMFY_DIR        ComfyUI checkout         (default ~/ComfyUI)
#   NOTDND_COMFY_EXTRA_ARGS extra python args        (default empty)
set -euo pipefail

PORT="${1:-8188}"
MODE="${2:-}"

COMFY_DIR="${NOTDND_COMFY_DIR:-$HOME/ComfyUI}"
MEM_HIGH="${NOTDND_COMFY_MEM_HIGH:-24G}"
MEM_MAX="${NOTDND_COMFY_MEM_MAX:-28G}"
EXTRA_ARGS="${NOTDND_COMFY_EXTRA_ARGS:-}"
UNIT="comfyui-${PORT}"
PY="${COMFY_DIR}/venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "comfyui-server: no python at ${PY} (set NOTDND_COMFY_DIR)" >&2
  exit 1
fi

# PID(s) LISTENING on the port (not clients). Empty when free.
port_pids() {
  ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}\b" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# The cgroup memory ceiling actually in force for the unit, or empty if not leashed.
unit_mem_max() {
  systemctl --user show "$UNIT" -p MemoryMax --value 2>/dev/null | grep -vE '^(infinity)?$' || true
}

# PERMANENT PREFLIGHT ROW: a launched ComfyUI MUST be memory-leashed — the unit's
# MemoryMax must be a finite ceiling, not `infinity`. An un-leashed launch (bare
# python) has no unit and FAILS this. Prints the row and returns non-zero on FAIL.
preflight_capped() {
  local mx; mx="$(unit_mem_max)"
  if [ -n "$mx" ] && [ "$mx" != "infinity" ]; then
    echo "  comfyui memory-capped: PASS (unit ${UNIT}, MemoryMax=${mx} bytes, MemoryHigh=${MEM_HIGH})"
    return 0
  fi
  echo "  comfyui memory-capped: FAIL (unit ${UNIT} has no finite MemoryMax — an un-leashed/bare launch). Relaunch via this script." >&2
  return 1
}

if [ "$MODE" = "--status" ]; then
  systemctl --user status "$UNIT" --no-pager 2>&1 | head -12 || true
  echo "--- leash ---"
  preflight_capped || exit 1
  exit 0
fi

# --- kill any prior instance on the port (by PORT, never by pattern — the
#     pkill-pattern self-kill hazard) and clear a spent transient unit ---
OLD_PIDS="$(port_pids || true)"
if [ -n "$OLD_PIDS" ]; then
  echo "comfyui-server: killing listener(s) on :${PORT}: $(echo "$OLD_PIDS" | tr '\n' ' ')"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  else
    for p in $OLD_PIDS; do kill "$p" 2>/dev/null || true; done
  fi
fi
# stop a same-named unit if it lingers, and clear any failed state so the name is reusable
systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true

# VERIFY the port frees (up to ~5s; SIGKILL escalation at 3s).
for i in $(seq 1 10); do
  [ -z "$(port_pids || true)" ] && break
  if [ "$i" = 6 ]; then
    for p in $(port_pids || true); do kill -9 "$p" 2>/dev/null || true; done
  fi
  sleep 0.5
done
if [ -n "$(port_pids || true)" ]; then
  echo "comfyui-server FAILED: :${PORT} still held after kill: $(port_pids | tr '\n' ' ')" >&2
  exit 1
fi

# --- launch, leashed + detached, as a transient user service ---
echo "comfyui-server: launching ${UNIT} · --novram · MemoryHigh=${MEM_HIGH} MemoryMax=${MEM_MAX}"
# shellcheck disable=SC2086
systemd-run --user \
  --unit="$UNIT" \
  --description="ComfyUI (memory-leashed, --novram) on :${PORT}" \
  --working-directory="$COMFY_DIR" \
  -p MemoryHigh="$MEM_HIGH" \
  -p MemoryMax="$MEM_MAX" \
  -p MemorySwapMax=0 \
  "$PY" main.py --port "$PORT" --novram $EXTRA_ARGS

# systemd-run returns immediately; the unit is now supervised. Wait for the port.
echo "  waiting for :${PORT} to accept ..."
READY=""
for i in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:${PORT}/system_stats" >/dev/null 2>&1; then
    READY="1"; echo "  ComfyUI READY (~$((i*2))s)"; break
  fi
  sleep 2
done

echo "  unit:   $(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null) / $(systemctl --user show "$UNIT" -p SubState --value 2>/dev/null)"
preflight_capped || exit 1

if [ -z "$READY" ]; then
  echo "comfyui-server WARN: unit is leashed+running but :${PORT} did not answer in 120s (still loading? check: systemctl --user status ${UNIT})" >&2
  exit 2
fi
echo "comfyui-server: done — ${UNIT} leashed, detached, serving :${PORT}"
