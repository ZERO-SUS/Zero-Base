#!/usr/bin/env node
/**
 * ZERO BASE — Backup Integrity & Supabase Storage Parity Verifier
 * Verifies:
 * 1. Latest PostgreSQL backup manifest exists and dump SHA-256 matches
 * 2. Latest Storage inventory manifest exists and mirrored files match SHA-256
 * 3. Every `service_files` storage_path in a JSON snapshot exists in the Storage mirror
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const backupDir = path.resolve(getArg('--backup-dir', './backups'));
const snapshotPath = getArg('--snapshot', null);

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyPostgresBackups() {
  const pgDir = path.join(backupDir, 'postgres');
  if (!fs.existsSync(pgDir)) {
    throw new Error(`Missing PostgreSQL backup directory: ${pgDir}`);
  }
  const generations = fs.readdirSync(pgDir).sort().reverse();
  if (generations.length === 0) {
    throw new Error('No PostgreSQL backup generations found');
  }

  const latestDir = path.join(pgDir, generations[0]);
  const dumpPath = path.join(latestDir, 'zero-base.dump');
  const shaPath = `${dumpPath}.sha256`;
  const manifestPath = path.join(latestDir, 'manifest.json');

  if (!fs.existsSync(dumpPath) || !fs.existsSync(shaPath) || !fs.existsSync(manifestPath)) {
    throw new Error(`Incomplete backup generation at ${latestDir}`);
  }

  const expectedHash = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  const actualHash = sha256File(dumpPath);
  if (expectedHash !== actualHash) {
    throw new Error(`PostgreSQL dump SHA-256 mismatch! Expected ${expectedHash}, got ${actualHash}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.verified) {
    throw new Error('Backup manifest is not marked verified');
  }

  console.log(`OK: PostgreSQL backup ${generations[0]} verified (${manifest.size_bytes} bytes)`);
}

function verifyStorageMirror() {
  const storageMirror = path.join(backupDir, 'storage', 'latest');
  const manifestsDir = path.join(backupDir, 'storage', 'manifests');
  if (!fs.existsSync(storageMirror) || !fs.existsSync(manifestsDir)) {
    throw new Error('Supabase Storage backup mirror or manifests directory missing');
  }

  const manifests = fs.readdirSync(manifestsDir).filter((f) => f.endsWith('.sha256')).sort().reverse();
  if (manifests.length === 0) {
    throw new Error('No Storage inventory manifest found');
  }

  const latestManifest = path.join(manifestsDir, manifests[0]);
  const lines = fs
    .readFileSync(latestManifest, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?\.?\/?(.*)$/i);
    if (!match) continue;
    const [, expectedHash, relPath] = match;
    const fullPath = path.join(storageMirror, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing Storage mirrored file: ${relPath}`);
    }
    const actualHash = sha256File(fullPath);
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`Checksum mismatch for Storage file ${relPath}`);
    }
  }

  console.log(`OK: Supabase Storage mirror verified (${lines.length} objects matched ${manifests[0]})`);

  if (snapshotPath) {
    const snap = JSON.parse(fs.readFileSync(path.resolve(snapshotPath), 'utf8'));
    const files = snap?.tables?.service_files ?? [];
    const missing = files.filter(
      (f) => !fs.existsSync(path.join(storageMirror, f.storage_path))
    );
    if (missing.length > 0) {
      throw new Error(
        `Snapshot parity failure: ${missing.length} DB service_files keys missing from Storage mirror`
      );
    }
    console.log(`OK: All ${files.length} DB service_files keys verified in Storage mirror`);
  }
}

try {
  verifyPostgresBackups();
  verifyStorageMirror();
  console.log('ALL BACKUP VERIFICATION CHECKS PASSED');
} catch (err) {
  console.error('BACKUP VERIFICATION FAILED:', err.message);
  process.exit(1);
}
