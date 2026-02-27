#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${NOTDND_DB_PATH:-server/db/notdnd.db.json}"
BACKUP_DIR="${1:-backups}"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database file not found: $DB_PATH" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET="$BACKUP_DIR/notdnd_db_${STAMP}.json"
cp "$DB_PATH" "$TARGET"

echo "Backup written: $TARGET"
