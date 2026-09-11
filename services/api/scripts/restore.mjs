#!/usr/bin/env node
/**
 * Restore (Phase 9 hardening) — the inverse of scripts/backup.mjs.
 *
 * Copies a backup folder's database file and storage directory back into
 * place. REFUSES to run while it looks like the API might be using the
 * current database (no automatic process check is possible cross-platform,
 * so this just requires an explicit --yes flag as a deliberate confirmation
 * step) and always makes a `.before-restore` safety copy of what it's about
 * to overwrite.
 *
 * Usage:  node scripts/restore.mjs <backup-dir> --yes
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const backupDir = process.argv[2];
const confirmed = process.argv.includes('--yes');

if (!backupDir) {
  console.error('Usage: node scripts/restore.mjs <backup-dir> --yes');
  process.exit(1);
}
const src = resolve(backupDir);
if (!existsSync(src)) {
  console.error(`[restore] backup directory not found: ${src}`);
  process.exit(1);
}
if (!confirmed) {
  console.error('[restore] this OVERWRITES the current database and storage directory.');
  console.error('Re-run with --yes to confirm, after stopping the API process:');
  console.error(`  node scripts/restore.mjs "${backupDir}" --yes`);
  process.exit(1);
}

function readEnvFile() {
  const path = join(apiRoot, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

const envFile = readEnvFile();
const dbUrl = process.env.DATABASE_URL ?? envFile.DATABASE_URL ?? 'file:./prisma/dev.db';
const storageDir = process.env.STORAGE_LOCAL_DIR ?? envFile.STORAGE_LOCAL_DIR ?? './storage';

const safetyDir = resolve(apiRoot, '.before-restore', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(safetyDir, { recursive: true });

if (dbUrl.startsWith('file:')) {
  // see the matching comment in backup.mjs: relative sqlite paths are resolved
  // by Prisma relative to prisma/, not the package root.
  const dbPath = resolve(apiRoot, 'prisma', dbUrl.slice('file:'.length));
  const backedUpDb = readdirSync(src).find((f) => f.endsWith('.db'));
  if (!backedUpDb) {
    console.error(`[restore] no .db file found in ${src}`);
    process.exit(1);
  }
  if (existsSync(dbPath)) cpSync(dbPath, join(safetyDir, 'previous.db'));
  cpSync(join(src, backedUpDb), dbPath);
  console.log(`[restore] restored database -> ${dbPath}`);
} else {
  console.warn(`[restore] DATABASE_URL is not a local sqlite file (${dbUrl}); restore it via your database engine's tools.`);
}

const srcStorage = join(src, 'storage');
if (existsSync(srcStorage)) {
  const storagePath = resolve(apiRoot, storageDir);
  if (existsSync(storagePath)) {
    cpSync(storagePath, join(safetyDir, 'storage'), { recursive: true });
    rmSync(storagePath, { recursive: true, force: true });
  }
  cpSync(srcStorage, storagePath, { recursive: true });
  console.log(`[restore] restored storage -> ${storagePath}`);
}

console.log(`\n[restore] done. Pre-restore state saved to ${safetyDir} in case this needs to be undone.`);
console.log('Run `npm run db:migrate` (or db:deploy) afterward if the restored DB predates a newer migration.');
