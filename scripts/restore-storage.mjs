#!/usr/bin/env node
/**
 * ZERO BASE — Supabase Storage Restore Script
 * Uploads backed-up files from ./backups/storage/latest back into private bucket `zero-base-files`
 * preserving exact storage_path keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fskcdtpdkjgjaksqwjaf.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BUCKET = process.env.STORAGE_BUCKET || 'zero-base-files';
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || './backups');
const SOURCE_DIR = path.join(BACKUP_DIR, 'storage', 'latest');

if (!SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_ANON_KEY is required.');
  process.exit(1);
}
if (!fs.existsSync(SOURCE_DIR)) {
  console.error(`ERROR: Backup source directory not found: ${SOURCE_DIR}`);
  process.exit(1);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

async function main() {
  const token = process.env.BACKUP_ACCESS_TOKEN;
  const email = process.env.BACKUP_OWNER_EMAIL;
  const password = process.env.BACKUP_OWNER_PASSWORD;

  let supabase;
  if (token) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  } else if (email && password) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Auth failed: ${error.message}`);
  } else {
    throw new Error('Provide BACKUP_ACCESS_TOKEN or BACKUP_OWNER_EMAIL + BACKUP_OWNER_PASSWORD');
  }

  const files = walkFiles(SOURCE_DIR);
  let restored = 0;

  for (const relPath of files) {
    const buf = fs.readFileSync(path.join(SOURCE_DIR, relPath));
    const { error } = await supabase.storage.from(BUCKET).upload(relPath, buf, {
      upsert: false,
    });
    if (error && !String(error.message).toLowerCase().includes('already exists')) {
      throw new Error(`Failed restoring ${relPath}: ${error.message}`);
    }
    restored += 1;
  }

  console.log(`SUCCESS: Checked/restored ${restored} files into bucket '${BUCKET}'.`);
}

main().catch((err) => {
  console.error('STORAGE RESTORE FAILED:', err.message);
  process.exit(1);
});
