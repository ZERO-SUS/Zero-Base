# ZERO BASE — Windows PowerShell Full Backup & Verification Runner (Free Plan)
$ErrorActionPreference = "Stop"

$BackupDir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { ".\backups" }
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$LogFile = Join-Path $BackupDir "backup.log"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

function Write-BackupLog($Message) {
  $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

if (-not $env:SUPABASE_DB_URL) { throw "SUPABASE_DB_URL is required" }
if (-not $env:SUPABASE_ANON_KEY) { throw "SUPABASE_ANON_KEY is required" }

$PgOutDir = Join-Path $BackupDir "postgres\$Timestamp"
New-Item -ItemType Directory -Force -Path $PgOutDir | Out-Null
$DumpFile = Join-Path $PgOutDir "zero-base.dump"

Write-BackupLog "Starting PostgreSQL backup..."
pg_dump --format=custom --no-owner --no-privileges --file="$DumpFile" "$env:SUPABASE_DB_URL"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

pg_restore --list "$DumpFile" | Out-File -FilePath (Join-Path $PgOutDir "toc.txt") -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "pg_restore verification failed" }

$hash = (Get-FileHash -Path $DumpFile -Algorithm SHA256).Hash.ToLower()
"$hash  zero-base.dump" | Out-File -FilePath "$DumpFile.sha256" -Encoding ascii

$size = (Get-Item $DumpFile).Length
@{
  timestamp_utc = $Timestamp
  dump_file = "zero-base.dump"
  size_bytes = $size
  verified = $true
} | ConvertTo-Json | Out-File -FilePath (Join-Path $PgOutDir "manifest.json") -Encoding utf8

Write-BackupLog "Starting Supabase Storage backup (zero-base-files)..."
node .\scripts\backup-storage.mjs
if ($LASTEXITCODE -ne 0) { throw "Supabase Storage backup failed" }

Write-BackupLog "Running integrity verification..."
node .\scripts\verify-backup.mjs --backup-dir "$BackupDir"
if ($LASTEXITCODE -ne 0) { throw "Backup verification failed" }

Write-BackupLog "SUCCESS: Full PostgreSQL + Supabase Storage backup verified."
