#!/usr/bin/env node
// Recursively finds *.test.ts files under ./src (relative to the invoking
// package's cwd) and runs Node's test runner against the resolved file
// list — deliberately not a glob pattern handed to the shell or to
// `node --test` itself.
//
// Why: npm runs package.json scripts via cmd.exe on Windows (which never
// touches globs — any glob syntax reaches the command completely literally)
// but via sh (dash) on Linux, which has no globstar support, so a
// double-star segment silently degrades to a single star and either drops
// nested files or matches nothing. Quoting the glob so the shell can't
// touch it is not enough either: passing it as a literal argument to
// `node --test` on Node 24 (this repo's CI runner) fails outright with
// "Could not find" the literal pattern string — it does not fall back to
// treating an unmatched literal as a glob. Resolving the file list
// ourselves with plain fs.readdirSync sidesteps both problems on every
// platform.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = 'src';
const files = readdirSync(srcDir, { recursive: true })
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(srcDir, f).replace(/\\/g, '/'))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.ts files found under ${srcDir}/`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
