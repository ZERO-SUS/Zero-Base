#!/usr/bin/env bash
set -euo pipefail

# ZERO BASE — PostgreSQL Backup Script (with checksum & pg_restore verification)
# Usage: SUPABASE_DB_URL="postgresql://..." ./scripts/backup-db.sh

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL must be set}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR}/postgres/${TIMESTAMP}"
DUMP_FILE="${OUT_DIR}/zero-base.dump"
LOG_FILE="${BACKUP_DIR}/backup.log"

mkdir -p "${OUT_DIR}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [DB-BACKUP] $*" | tee -a "${LOG_FILE}"
}

log "Starting PostgreSQL backup to ${DUMP_FILE}"

if ! pg_dump --format=custom --no-owner --no-privileges --file="${DUMP_FILE}" "${SUPABASE_DB_URL}"; then
  log "ERROR: pg_dump failed"
  exit 1
fi

# Verify archive readability BEFORE declaring success
if ! pg_restore --list "${DUMP_FILE}" > "${OUT_DIR}/toc.txt"; then
  log "ERROR: Backup verification failed (pg_restore --list could not read ${DUMP_FILE})"
  exit 1
fi

sha256sum "${DUMP_FILE}" > "${DUMP_FILE}.sha256"
if ! sha256sum -c "${DUMP_FILE}.sha256" > /dev/null; then
  log "ERROR: Checksum verification failed for ${DUMP_FILE}"
  exit 1
fi

SIZE_BYTES=$(wc -c < "${DUMP_FILE}")
TABLE_COUNT=$(grep -c "TABLE DATA" "${OUT_DIR}/toc.txt" || true)

cat > "${OUT_DIR}/manifest.json" <<EOF
{
  "timestamp_utc": "${TIMESTAMP}",
  "dump_file": "zero-base.dump",
  "size_bytes": ${SIZE_BYTES},
  "table_data_entries": ${TABLE_COUNT},
  "verified": true
}
EOF

# Prune old generations beyond retention policy
find "${BACKUP_DIR}/postgres" -mindepth 1 -maxdepth 1 -type d -mtime +"${RETENTION_DAYS}" -exec rm -rf {} +

log "SUCCESS: Verified PostgreSQL backup (${SIZE_BYTES} bytes, ${TABLE_COUNT} table data entries)"
