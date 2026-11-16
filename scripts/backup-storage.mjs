#!/usr/bin/env node
/**
 * ZERO BASE — Free-Plan Supabase Storage Backup Script
 * Downloads every object from private bucket `zero-base-files` preserving paths
 * and writes a SHA-256 inventory manifest.
 *
 * Authentication (via environment variables — never commit credentials):
 *   SUPABASE_URL=https://fskcdtpdkjgjaksqwjaf.supabase.co
 *   SUPABASE_ANON_KEY=...
 *   Either BACKUP_ACCESS_TOKEN (owner JWT) OR (BACKUP_OWNER_EMAIL + BACKUP_OWNER_PASSWORD)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fskcdtpdkjgjaksqwjaf.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BUCKET = process.env.STORAGE_BUCKET || 'zero-base-files';
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || './backups');

if (!SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_ANON_KEY environment variable is required.');
  process.exit(1);
}

async function getAuthenticatedClient() {
  const token = process.env.BACKUP_ACCESS_TOKEN;
  if (token) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  const email = process.env.BACKUP_OWNER_EMAIL;
  const password = process.env.BACKUP_OWNER_PASSWORD;
  if (!email || !password) {
    console.error(
      'ERROR: Provide BACKUP_ACCESS_TOKEN or BACKUP_OWNER_EMAIL + BACKUP_OWNER_PASSWORD.'
    );
    process.exit(1);
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('ERROR: Owner authentication failed:', error.message);
    process.exit(1);
  }
  return client;
}

async function listObjectsRecursive(supabase, prefix = '') {
  const paths = [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw new Error(`Failed listing ${prefix}: ${error.message}`);

  for (const item of data ?? []) {
    const full = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) {
      const nested = await listObjectsRecursive(supabase, full);
      paths.push(...nested);
    } else {
      paths.push(full);
    }
  }
  return paths;
}

async function main() {
  const supabase = await getAuthenticatedClient();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
  const mirrorDir = path.join(BACKUP_DIR, 'storage', 'latest');
  const manifestsDir = path.join(BACKUP_DIR, 'storage', 'manifests');
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.mkdirSync(manifestsDir, { recursive: true });

  const objectPaths = await listObjectsRecursive(supabase, 'customers');
  const manifestLines = [];

  for (const storagePath of objectPaths.sort()) {
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(storagePath);
    if (error || !blob) {
      throw new Error(`Failed downloading ${storagePath}: ${error?.message ?? 'empty'}`);
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const destPath = path.join(mirrorDir, storagePath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);

    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    manifestLines.push(`${hash}  ./${storagePath}`);
  }

  const manifestFile = path.join(manifestsDir, `storage-inventory-${timestamp}.sha256`);
  fs.writeFileSync(manifestFile, manifestLines.join('\n') + (manifestLines.length ? '\n' : ''));
  console.log(`SUCCESS: Backed up ${manifestLines.length} files to ${mirrorDir}`);
}

main().catch((err) => {
  console.error('STORAGE BACKUP FAILED:', err.message);
  process.exit(1);
});
