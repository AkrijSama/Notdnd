#!/usr/bin/env bash
set -euo pipefail

# Back up the ACTIVE SQLite store (server/db/notdnd.sqlite) — NOT the retired JSON
# store (server/db/notdnd.db.json) the engine stopped writing after the SQLite
# migration. Path resolution mirrors repository.js: INKBORNE_DB_PATH, then the
# legacy NOTDND_DB_PATH, then the default.
DB_PATH="${INKBORNE_DB_PATH:-${NOTDND_DB_PATH:-server/db/notdnd.sqlite}}"
BACKUP_DIR="${1:-backups}"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "SQLite store not found: $DB_PATH" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET="$BACKUP_DIR/notdnd_${STAMP}.sqlite"

# Prefer SQLite's online-backup API: it writes a CONSISTENT single-file snapshot
# even while the server holds the DB open in WAL mode. A plain `cp` of the .sqlite
# alone would miss an un-checkpointed -wal (currently tens of MB) and restore stale.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$TARGET'"
else
  # Fallback: copy the DB plus its WAL/SHM sidecars so the set stays consistent.
  cp "$DB_PATH" "$TARGET"
  [[ -f "$DB_PATH-wal" ]] && cp "$DB_PATH-wal" "$TARGET-wal"
  [[ -f "$DB_PATH-shm" ]] && cp "$DB_PATH-shm" "$TARGET-shm"
  echo "warning: sqlite3 CLI not found — copied raw DB + WAL/SHM (restore all together)" >&2
fi

echo "Backup written: $TARGET"
