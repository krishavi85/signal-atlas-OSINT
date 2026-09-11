#!/usr/bin/env node
/**
 * Migration integrity check (§49 "migration tests").
 *
 * Applies every migration in prisma/migrations to a brand-new, throwaway
 * SQLite file with `prisma migrate deploy` (the same command used in
 * production) and fails loudly if anything errors — catching a migration that
 * only "works" against a developer's already-patched local database.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const tmpDir = mkdtempSync(join(tmpdir(), 'osint-migrate-verify-'));
const dbFile = join(tmpDir, 'verify.db');
const dbUrl = `file:${dbFile}`;

console.log(`[verify-migrations] applying migrations to a fresh database: ${dbFile}`);

try {
  // `shell: true` is required on Windows to resolve the npx.cmd shim; the
  // argument list is a fixed, hardcoded array (no user input reaches it), so
  // the shell-injection concern the shell:true+args combo normally raises
  // does not apply here.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('[verify-migrations] OK — all migrations applied cleanly to a fresh database.');
} catch (err) {
  console.error('[verify-migrations] FAILED — a migration does not apply cleanly from scratch.');
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
