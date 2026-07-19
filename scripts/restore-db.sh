#!/usr/bin/env bash
set -euo pipefail

# Restore the ACTIVE SQLite store from a .sqlite backup made by backup-db.sh.
# Path resolution mirrors repository.js (and backup-db.sh).
SOURCE="${1:-}"
DB_PATH="${INKBORNE_DB_PATH:-${NOTDND_DB_PATH:-server/db/notdnd.sqlite}}"

if [[ -z "$SOURCE" ]]; then
  echo "Usage: scripts/restore-db.sh <backup-file.sqlite>" >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Backup file not found: $SOURCE" >&2
  exit 1
fi

# STOP the server first — overwriting an open WAL-mode DB corrupts it. A .backup
# snapshot is a single self-contained file, so drop any stale -wal/-shm sitting
# next to the live DB or SQLite would replay the old WAL over the restored file.
mkdir -p "$(dirname "$DB_PATH")"
cp "$SOURCE" "$DB_PATH"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"

echo "Database restored from $SOURCE to $DB_PATH"
echo "(cleared stale $DB_PATH-wal / -shm — restart the server)"
