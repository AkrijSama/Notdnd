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
# Usage:
#   scripts/play-server.sh [PORT]              # foreground, PORT default 4173
#   scripts/play-server.sh 4173 --bg           # detached, logs to LOGFILE below
#
# To ALLOW the local 8b (accepting the GPU risk), export it before launch:
#   INKBORNE_GM_LOCAL_FALLBACK=true scripts/play-server.sh
set -euo pipefail

PORT="${1:-4173}"
BG=""
[ "${2:-}" = "--bg" ] && BG=1

cd "$(dirname "$0")/.."

# GPU-safe default: only set if the operator hasn't explicitly chosen.
if [ -z "${INKBORNE_GM_LOCAL_FALLBACK:-}" ] && [ -z "${NOTDND_GM_LOCAL_FALLBACK:-}" ]; then
  export INKBORNE_GM_LOCAL_FALLBACK=false
fi

echo "play server: port ${PORT} · local-8b GM fallback=${INKBORNE_GM_LOCAL_FALLBACK:-${NOTDND_GM_LOCAL_FALLBACK}} (GPU-safe when false)"

# Clear scenario-forcing operator env so a plain launch is never silently a
# scenario run (see scripts/battery-server.sh for the original finding).
COMMON=(env -u NODE_ENV INKBORNE_SCENARIO= NOTDND_SCENARIO= PORT="$PORT")

if [ -n "$BG" ]; then
  LOGFILE="${NOTDND_PLAY_LOG:-/tmp/inkborne-play-${PORT}.log}"
  echo "  detached; logs -> ${LOGFILE}"
  setsid nohup "${COMMON[@]}" node server/index.js > "$LOGFILE" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "  pid $!"
else
  exec "${COMMON[@]}" node server/index.js
fi
