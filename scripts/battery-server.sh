#!/usr/bin/env bash
# Isolated battery server launcher — the ONLY supported way to stand up a server
# for scripts/selfplay.mjs. Exists because of the 2026-07-05 push-receipt finding:
# a grading flag in the repo .env (INKBORNE_SCENARIO=the_shipment) silently
# converted every plain battery run into a scenario run and red-flagged movement's
# geo-fog assert. A battery server must NEVER inherit scenario-forcing operator
# env — this script clears it explicitly, uses a scratch DB (never the play DB),
# and keeps the paid/testing cloud chains off (quota discipline; the battery is
# expected to exercise the local fallback model).
#
# Usage:
#   scripts/battery-server.sh [PORT] [DB_DIR]
#     PORT   default 4996
#     DB_DIR default a fresh dir under $TMPDIR (printed on start)
# Then:
#   SELFPLAY_BASE=http://127.0.0.1:<PORT> node scripts/selfplay.mjs
#
# Scenario tests (e.g. SELFPLAY_SCENARIO=location_source) still work — they pass
# an explicit per-run scenarioId, which beats the (cleared) env flag by design.
set -euo pipefail

PORT="${1:-4996}"
DB_DIR="${2:-$(mktemp -d "${TMPDIR:-/tmp}/inkborne-battery-XXXXXX")}"
mkdir -p "$DB_DIR"

echo "battery server: port ${PORT}, scratch db ${DB_DIR}/battery.sqlite"
echo "  INKBORNE_SCENARIO cleared · cloud provider chain off · scratch DB (not the play DB)"

# INKBORNE_SCENARIO= (empty) reads as scenario-off (scenarioLoader.js: `scenarioId
# || process.env.INKBORNE_SCENARIO` — empty string is falsy). Same for the legacy
# NOTDND_* spellings, cleared defensively.
exec env \
  INKBORNE_SCENARIO= \
  NOTDND_SCENARIO= \
  NOTDND_CLOUD_PROVIDER_CHAIN=off \
  INKBORNE_CLOUD_PROVIDER_CHAIN=off \
  INKBORNE_DB_PATH="${DB_DIR}/battery.sqlite" \
  PORT="$PORT" \
  node server/index.js
