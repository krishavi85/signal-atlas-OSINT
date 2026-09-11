#!/usr/bin/env node
/**
 * Backup (Phase 9 hardening).
 *
 * Copies the SQLite database file and the local object-storage directory
 * (uploaded documents, media, screenshots) into a single timestamped folder.
 * Works whether or not the API process is currently running (SQLite's file is
 * safe to copy while idle; for a live backup under write load, stop the API
 * first or switch to PostgreSQL + `pg_dump`, which is the intended path per
 * ARCHITECTURE.md's production swap points).
 *
 * Usage:  node scripts/backup.mjs [destination-dir]
 * Default destination: ./backups/<timestamp>/
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

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

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destRoot = resolve(apiRoot, process.argv[2] ?? 'backups', timestamp);
mkdirSync(destRoot, { recursive: true });

const copied = [];

if (dbUrl.startsWith('file:')) {
  // Prisma resolves a relative sqlite `file:` URL relative to schema.prisma's
  // own directory (prisma/), not the package root — match that here or the
  // backup silently misses the real database file.
  const dbPath = resolve(apiRoot, 'prisma', dbUrl.slice('file:'.length));
  if (existsSync(dbPath)) {
    const dest = join(destRoot, basename(dbPath));
    cpSync(dbPath, dest);
    copied.push({ what: 'database', to: dest, bytes: statSync(dest).size });
  } else {
    console.warn(`[backup] database file not found at ${dbPath} — skipped`);
  }
} else {
  console.warn(`[backup] DATABASE_URL is not a local sqlite file (${dbUrl}).`);
  console.warn('  Use your database engine\'s native backup tool (e.g. `pg_dump` for PostgreSQL) instead.');
}

const storagePath = resolve(apiRoot, storageDir);
if (existsSync(storagePath)) {
  const dest = join(destRoot, 'storage');
  cpSync(storagePath, dest, { recursive: true });
  copied.push({ what: 'object storage (documents/media)', to: dest });
} else {
  console.log(`[backup] no local storage directory at ${storagePath} — nothing to copy`);
}

console.log(`\n[backup] wrote ${copied.length} item(s) to ${destRoot}:`);
for (const c of copied) console.log(`  - ${c.what}: ${c.to}${c.bytes ? ` (${(c.bytes / 1024).toFixed(0)} KB)` : ''}`);
console.log(`\nRestore with: node scripts/restore.mjs "${destRoot}"`);
