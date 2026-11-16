# ZERO BASE — Windows PowerShell Full Backup & Verification Runner
$ErrorActionPreference = "Stop"

$BackupDir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { ".\backups" }
$RetentionDays = if ($env:BACKUP_RETENTION_DAYS) { [int]$env:BACKUP_RETENTION_DAYS } else { 30 }
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$LogFile = Join-Path $BackupDir "backup.log"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

function Write-BackupLog($Message) {
  $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

if (-not $env:SUPABASE_DB_URL) { throw "SUPABASE_DB_URL is required" }
if (-not $env:R2_ACCOUNT_ID -or -not $env:R2_ACCESS_KEY_ID -or -not $env:R2_SECRET_ACCESS_KEY -or -not $env:R2_BUCKET_NAME) {
  throw "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME are required"
}

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

Write-BackupLog "Starting R2 sync..."
$R2Mirror = Join-Path $BackupDir "r2\latest"
$R2Manifests = Join-Path $BackupDir "r2\manifests"
New-Item -ItemType Directory -Force -Path $R2Mirror, $R2Manifests | Out-Null

$env:AWS_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
$env:AWS_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
$env:AWS_DEFAULT_REGION = "auto"
$Endpoint = "https://$($env:R2_ACCOUNT_ID).r2.cloudflarestorage.com"

aws s3 sync "s3://$($env:R2_BUCKET_NAME)/" "$R2Mirror/" --endpoint-url "$Endpoint" --no-progress
if ($LASTEXITCODE -ne 0) { throw "R2 sync failed" }

$ManifestFile = Join-Path $R2Manifests "r2-inventory-$Timestamp.sha256"
Get-ChildItem -Path $R2Mirror -Recurse -File | Sort-Object FullName | ForEach-Object {
  $rel = $_.FullName.Substring($R2Mirror.Length + 1).Replace('\', '/')
  $h = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLower()
  "$h  ./$rel"
} | Out-File -FilePath $ManifestFile -Encoding ascii

Write-BackupLog "Running Node verification..."
node .\scripts\verify-backup.mjs --backup-dir "$BackupDir"
if ($LASTEXITCODE -ne 0) { throw "Backup verification failed" }

Write-BackupLog "SUCCESS: Full PostgreSQL + R2 backup verified."
