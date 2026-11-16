# ZERO BASE — Backup & Disaster Recovery Guide

## 1. Why Separate Backup Procedures Are Required
A PostgreSQL backup (`pg_dump`) **does not contain** files stored in Cloudflare R2, and an R2 sync **does not contain** structured customer/service/payment records or attachment metadata mappings.

ZERO BASE backs up and verifies all three components together:
1. **PostgreSQL Database** (`zero-base.dump` + SHA-256 + `pg_restore --list` verification)
2. **Cloudflare R2 Private Bucket Objects** (`aws s3 sync` mirror + per-file SHA-256 inventory manifest)
3. **Metadata & Key Parity** (`scripts/verify-backup.mjs` + Admin UI JSON snapshot export)

Backup copies should be stored outside the primary production resources (e.g., encrypted external drive, secondary cloud bucket, or dedicated backup server).

---

## 2. Running Backups

### Linux / macOS / CI
```bash
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
export R2_ACCOUNT_ID="<cf-account-id>"
export R2_ACCESS_KEY_ID="<r2-s3-access-key>"
export R2_SECRET_ACCESS_KEY="<r2-s3-secret-key>"
export R2_BUCKET_NAME="zero-base-files"
export BACKUP_DIR="/secure-offsite-storage/zero-base-backups"
export BACKUP_RETENTION_DAYS=30

./scripts/backup-db.sh
./scripts/backup-r2.sh
node ./scripts/verify-backup.mjs --backup-dir "$BACKUP_DIR"
```

### Windows (PowerShell)
```powershell
$env:SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
$env:R2_ACCOUNT_ID="<cf-account-id>"
$env:R2_ACCESS_KEY_ID="<r2-s3-access-key>"
$env:R2_SECRET_ACCESS_KEY="<r2-s3-secret-key>"
$env:R2_BUCKET_NAME="zero-base-files"
$env:BACKUP_DIR="D:\ZeroBaseBackups"

.\scripts\backup-all.ps1
```

All backup runs append timestamped results and failures to `${BACKUP_DIR}/backup.log`.

---

## 3. Verification Policy
Never assume a backup succeeded without verification:
1. `backup-db.sh` runs `pg_restore --list` and `sha256sum -c` before writing `"verified": true` in `manifest.json`.
2. `backup-r2.sh` generates a SHA-256 inventory manifest of every synced file.
3. `verify-backup.mjs` re-computes checksums on both the latest PostgreSQL dump and every R2 file, and optionally checks 100% storage-key parity against a JSON snapshot (`--snapshot ./snapshot.json`).

---

## 4. Restoration Procedure (Test in Staging First!)

1. **Provision a separate staging PostgreSQL database** (never test destructive restores directly on production).
2. Restore the verified dump:
   ```bash
   export TARGET_DB_URL="postgresql://postgres:<password>@<staging-host>:5432/postgres"
   ./scripts/restore-db.sh ./backups/postgres/<timestamp>/zero-base.dump
   ```
3. Verify row counts in `customers`, `services`, `payments`, `attachments`, and `reminders`.
4. If restoring R2 files to a recovery bucket:
   ```bash
   aws s3 sync ./backups/r2/latest/ s3://zero-base-files-recovery/ \
     --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
   ```
5. Point a staging Worker + staging Pages build to the restored staging database and recovery R2 bucket, log in, open a customer record, and verify attachments open via temporary signed links.
6. Only after staging verification passes, promote the recovery database/bucket or restore into production during a scheduled maintenance window.
