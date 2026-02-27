#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-}"
DB_PATH="${NOTDND_DB_PATH:-server/db/notdnd.db.json}"

if [[ -z "$SOURCE" ]]; then
  echo "Usage: scripts/restore-db.sh <backup-file>" >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Backup file not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$(dirname "$DB_PATH")"
cp "$SOURCE" "$DB_PATH"

echo "Database restored from $SOURCE to $DB_PATH"
