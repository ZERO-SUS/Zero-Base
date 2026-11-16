#!/usr/bin/env bash
set -euo pipefail

# ZERO BASE — PostgreSQL Restore Script
# IMPORTANT: Always test restoring into a separate staging database first!
# Never overwrite production data without explicit confirmation.
# Usage: TARGET_DB_URL="postgresql://..." ./scripts/restore-db.sh ./backups/postgres/<timestamp>/zero-base.dump

DUMP_FILE="${1:?Usage: $0 <path-to-zero-base.dump>}"
: "${TARGET_DB_URL:?TARGET_DB_URL must be set to the target PostgreSQL connection string}"

if [[ ! -f "${DUMP_FILE}" ]]; then
  echo "ERROR: Dump file not found: ${DUMP_FILE}"
  exit 1
fi

if [[ -f "${DUMP_FILE}.sha256" ]]; then
  echo "Verifying SHA-256 checksum..."
  (cd "$(dirname "${DUMP_FILE}")" && sha256sum -c "$(basename "${DUMP_FILE}").sha256")
fi

echo "Verifying archive table of contents..."
pg_restore --list "${DUMP_FILE}" > /dev/null

read -r -p "WARNING: This will overwrite tables in TARGET_DB_URL. Type RESTORE to continue: " CONFIRM
if [[ "${CONFIRM}" != "RESTORE" ]]; then
  echo "Restore cancelled."
  exit 1
fi

pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --dbname="${TARGET_DB_URL}" \
  "${DUMP_FILE}"

echo "Restore completed successfully."
