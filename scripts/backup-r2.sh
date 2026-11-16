#!/usr/bin/env bash
set -euo pipefail

# ZERO BASE — Cloudflare R2 Private Bucket Backup Script
# Syncs all objects from private R2 bucket to external off-site storage directory
# Requires: AWS CLI v2 configured or R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID must be set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID must be set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY must be set}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME must be set}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
R2_MIRROR_DIR="${BACKUP_DIR}/r2/latest"
R2_MANIFEST_DIR="${BACKUP_DIR}/r2/manifests"
LOG_FILE="${BACKUP_DIR}/backup.log"

mkdir -p "${R2_MIRROR_DIR}" "${R2_MANIFEST_DIR}"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="auto"

ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [R2-BACKUP] $*" | tee -a "${LOG_FILE}"
}

log "Syncing R2 bucket '${R2_BUCKET_NAME}' from ${ENDPOINT} to ${R2_MIRROR_DIR}"

if ! aws s3 sync "s3://${R2_BUCKET_NAME}/" "${R2_MIRROR_DIR}/" --endpoint-url "${ENDPOINT}" --no-progress; then
  log "ERROR: R2 sync failed"
  exit 1
fi

# Build verified checksum inventory of synced files
MANIFEST_FILE="${R2_MANIFEST_DIR}/r2-inventory-${TIMESTAMP}.sha256"
(cd "${R2_MIRROR_DIR}" && find . -type f | sort | xargs -r sha256sum) > "${MANIFEST_FILE}"

FILE_COUNT=$(wc -l < "${MANIFEST_FILE}")
log "SUCCESS: Synced and inventoried ${FILE_COUNT} files in ${MANIFEST_FILE}"
