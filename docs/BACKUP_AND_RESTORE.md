# ZERO BASE — Free-Plan Backup & Restore Workflow

Because the Supabase Free plan does not include automated project backups, ZERO BASE provides a zero-cost manual backup, verification, and restore workflow covering **both** PostgreSQL data and private Supabase Storage files.

> **Important**: Automated scheduled backups are NOT active unless you configure an external scheduler (such as Windows Task Scheduler or GitHub Actions) to run these scripts. Run backups manually on a regular schedule and keep copies outside primary production resources.

---

## What Is Backed Up
1. **PostgreSQL Database (`scripts/backup-db.sh` / `scripts/backup-all.ps1`)**:
   - Schema, migrations, triggers, functions, RLS policies, and all rows in `owner_allowlist`, `profiles`, `customers`, `services`, `payments`, `reminders`, `service_files`, `audit_logs`, `business_settings`.
   - Verified via `pg_restore --list` and SHA-256 checksum.
2. **Supabase Storage (`scripts/backup-storage.mjs`)**:
   - All files in private bucket `zero-base-files` with exact `customers/{customer_id}/services/{service_id}/...` paths preserved and a SHA-256 inventory manifest.
3. **JSON Snapshot Export (In-App Settings -> Export JSON Snapshot)**:
   - Portable JSON export of all business tables via `/api/backup/export`.

## What Is NOT Backed Up by These Scripts
- Supabase Auth internal password hashes (`auth.users` secrets). Keep your 3 emergency login accounts and recovery email secure.
- Cloudflare Worker secrets (`SUPABASE_ANON_KEY`, `OWNER_USER_IDS`).

---

## How to Run a Manual Backup

### Windows PowerShell
```powershell
$env:SUPABASE_DB_URL="postgresql://postgres:<DB_PASSWORD>@db.fskcdtpdkjgjaksqwjaf.supabase.co:5432/postgres"
$env:SUPABASE_ANON_KEY="<SUPABASE_PUBLISHABLE_KEY>"
$env:BACKUP_OWNER_EMAIL="<OWNER_LOGIN_EMAIL>"
$env:BACKUP_OWNER_PASSWORD="<OWNER_LOGIN_PASSWORD>"
$env:BACKUP_DIR="D:\ZeroBaseBackups"

.\scripts\backup-all.ps1
```

### Linux / macOS
```bash
export SUPABASE_DB_URL="postgresql://postgres:<DB_PASSWORD>@db.fskcdtpdkjgjaksqwjaf.supabase.co:5432/postgres"
export SUPABASE_ANON_KEY="<SUPABASE_PUBLISHABLE_KEY>"
export BACKUP_OWNER_EMAIL="<OWNER_LOGIN_EMAIL>"
export BACKUP_OWNER_PASSWORD="<OWNER_LOGIN_PASSWORD>"
export BACKUP_DIR="/path/to/offsite/backups"

./scripts/backup-db.sh
node ./scripts/backup-storage.mjs
node ./scripts/verify-backup.mjs --backup-dir "$BACKUP_DIR"
```

---

## How to Verify a Backup
```bash
node ./scripts/verify-backup.mjs --backup-dir ./backups
# Optional: verify 100% file key parity against an exported JSON snapshot:
node ./scripts/verify-backup.mjs --backup-dir ./backups --snapshot ./zero-base-snapshot.json
```

---

## How to Restore (Always Test on Staging First)
1. **Never overwrite production data without confirming.** `scripts/restore-db.sh` explicitly requires typing `RESTORE`.
2. Restore PostgreSQL into a separate test/staging database first:
   ```bash
   export TARGET_DB_URL="postgresql://postgres:<PASS>@<STAGING_HOST>:5432/postgres"
   ./scripts/restore-db.sh ./backups/postgres/<timestamp>/zero-base.dump
   ```
3. Restore files into `zero-base-files` (or staging bucket):
   ```bash
   node ./scripts/restore-storage.mjs
   ```
4. Verify customer records, balances, and signed file previews before pointing production traffic to the restored environment.
