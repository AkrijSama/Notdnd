#!/usr/bin/env bash
# Canonical play-server launcher (dev / director's box). GPU-SAFE by default.
#
# Why this exists (2026-07-08 GPU-freeze finding): the cloud->local GM fallback
# drops a slow turn onto the local inkborne-gm:8b, which ollama loads (~6GB) into
# the 8GB GPU and keeps VRAM-resident for minutes — a live freeze trigger
# independent of ComfyUI. This launcher sets INKBORNE_GM_LOCAL_FALLBACK=false as a
# PER-PROCESS default (never persisted to .env), so a slow turn fallback-TAGS but
# never touches the GPU. Cloud chain (deepseek -> gemma backstop) is unchanged.
#
# It also clears the scenario-forcing env (the 2026-07-05/07-06 .env hazard) and
# reaper-escapes the process (setsid) so an editor/agent exit can't take it down.
#
# RESTART HARDENING (2026-07-09 finding): a casual setsid/nohup relaunch silently
# fails when an old PID still holds the port — the owner "restarted" while a 20h-old
# process kept serving 4173 with a stale build badge. `--restart` kills by port,
# VERIFIES the port is free, relaunches detached, then FAILS LOUDLY (non-zero) if
# the old PID survives, the port never frees, or the new process dies within 5s.
#
# Usage:
#   scripts/play-server.sh [PORT]              # foreground, PORT default 4173
#   scripts/play-server.sh 4173 --bg           # detached, logs to LOGFILE below
#   scripts/play-server.sh 4173 --restart      # kill-by-port + verified relaunch
#
# To ALLOW the local 8b (accepting the GPU risk), export it before launch:
#   INKBORNE_GM_LOCAL_FALLBACK=true scripts/play-server.sh
set -euo pipefail

PORT="${1:-4173}"
MODE="${2:-}"

cd "$(dirname "$0")/.."

PIDFILE="/tmp/inkborne-play-${PORT}.pid"
LOGFILE="${NOTDND_PLAY_LOG:-/tmp/inkborne-play-${PORT}.log}"

# GPU-safe default: only set if the operator hasn't explicitly chosen.
if [ -z "${INKBORNE_GM_LOCAL_FALLBACK:-}" ] && [ -z "${NOTDND_GM_LOCAL_FALLBACK:-}" ]; then
  export INKBORNE_GM_LOCAL_FALLBACK=false
fi

# INTERPRETER FAST-LANE default-on (baseline: interpreter median 3.8s / max 15s of
# every contested turn — a sequential prefix before narration). Routes JUST the
# roll-gating interpreter to a fast PAID model (gemini-2.5-flash via OpenRouter —
# reliable; the FREE gemini tier 429s under per-turn volume and was reverted).
# Measured −24% total turn latency. Interpreter failure degrades to the engine's
# heuristic classification, so this can only speed a turn up, never break it.
# Opt out: NOTDND_INTERPRETER_MODEL=off scripts/play-server.sh
if [ -z "${NOTDND_INTERPRETER_MODEL:-}" ] && [ -z "${INKBORNE_INTERPRETER_MODEL:-}" ]; then
  export NOTDND_INTERPRETER_MODEL="google/gemini-2.5-flash"
elif [ "${NOTDND_INTERPRETER_MODEL:-}" = "off" ]; then
  unset NOTDND_INTERPRETER_MODEL
fi

echo "play server: port ${PORT} · local-8b GM fallback=${INKBORNE_GM_LOCAL_FALLBACK:-${NOTDND_GM_LOCAL_FALLBACK}} (GPU-safe when false)"

# Clear scenario-forcing operator env so a plain launch is never silently a
# scenario run (see scripts/battery-server.sh for the original finding).
COMMON=(env -u NODE_ENV INKBORNE_SCENARIO= NOTDND_SCENARIO= PORT="$PORT")

# PID(s) currently LISTENING on the port (not clients). Empty when free.
port_pids() {
  ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}\b" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

launch_bg() {
  echo "  detached; logs -> ${LOGFILE}"
  setsid nohup "${COMMON[@]}" node server/index.js > "$LOGFILE" 2>&1 < /dev/null &
  NEWPID=$!
  disown 2>/dev/null || true
  echo "$NEWPID" > "$PIDFILE"
  echo "  pid ${NEWPID} (pidfile ${PIDFILE})"
}

if [ "$MODE" = "--restart" ]; then
  # 1. Kill whatever holds the port (by PORT, never by a command-line pattern —
  #    the pkill-pattern self-kill hazard). fuser when available, else ss+kill.
  OLD_PIDS="$(port_pids || true)"
  if [ -n "$OLD_PIDS" ]; then
    echo "  killing listener(s) on :${PORT}: $(echo "$OLD_PIDS" | tr '\n' ' ')"
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    else
      for p in $OLD_PIDS; do kill "$p" 2>/dev/null || true; done
    fi
  fi
  # 2. VERIFY the port actually frees (up to ~5s; SIGKILL escalation at 3s).
  for i in $(seq 1 10); do
    [ -z "$(port_pids || true)" ] && break
    if [ "$i" = 6 ]; then
      for p in $(port_pids || true); do kill -9 "$p" 2>/dev/null || true; done
    fi
    sleep 0.5
  done
  SURVIVORS="$(port_pids || true)"
  if [ -n "$SURVIVORS" ]; then
    echo "RESTART FAILED: old PID(s) still hold :${PORT} after kill: $(echo "$SURVIVORS" | tr '\n' ' ')" >&2
    exit 1
  fi
  # 3. Relaunch detached.
  launch_bg
  # 4. FAIL LOUDLY if the new process dies within 5s or never binds the port.
  #    NOTE: $! after `setsid … &` can be the setsid wrapper (it forks when made a
  #    process-group leader), so the ground truth is the PORT's listener — the port
  #    was verified free above, so any listener now IS the new server.
  sleep 5
  LISTENER="$(port_pids || true)"
  if [ -z "$LISTENER" ]; then
    echo "RESTART FAILED: no listener on :${PORT} after 5s (new process died or never bound) — tail of ${LOGFILE}:" >&2
    tail -5 "$LOGFILE" >&2 || true
    exit 1
  fi
  if [ "$(echo "$LISTENER" | wc -l)" != "1" ]; then
    echo "RESTART FAILED: multiple listeners on :${PORT}: $(echo "$LISTENER" | tr '\n' ' ')" >&2
    exit 1
  fi
  echo "$LISTENER" > "$PIDFILE"
  echo "  restart VERIFIED: pid ${LISTENER} is the sole :${PORT} listener (pidfile updated)"
elif [ "$MODE" = "--bg" ]; then
  launch_bg
else
  exec "${COMMON[@]}" node server/index.js
fi
