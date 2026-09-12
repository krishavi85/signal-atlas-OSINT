#!/usr/bin/env node
/**
 * Load/performance test harness (Phase 9 hardening, §49).
 *
 * Dependency-free: Node's built-in fetch + a simple concurrent-worker loop.
 * Exercises the platform's OWN request-handling path (auth, dashboard,
 * connectors, projects) — deliberately not the search/God-Mode endpoints,
 * which call third-party providers and would measure their rate limits and
 * network latency, not this API's performance.
 *
 * Usage:
 *   node scripts/loadtest.mjs [options]
 *
 * Options:
 *   --base-url=<url>     API base URL (default http://127.0.0.1:4000/api/v1)
 *   --concurrency=<n>    concurrent workers (default 10)
 *   --duration=<sec>     how long to run (default 15)
 *   --email=<email>      account to log in as (default: registers a throwaway one)
 *   --password=<pw>      password for --email
 *   --out=<path>         also write a JSON report to this path
 *
 * Note: the API's own abuse protections (@fastify/rate-limit, 300 req/min per
 * IP; auth endpoints at 10/min) will start returning 429s once concurrency ×
 * duration crosses that ceiling — the harness reports 429s in their own
 * bucket rather than lumping them in with real errors, since that's the
 * platform working as designed, not a fault under test.
 */

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args['base-url'] ?? 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');
// /healthz, /readyz, /metrics live at the API root, outside the /api/v1 prefix.
const apiRoot = baseUrl.replace(/\/api\/v\d+$/, '');
const concurrency = Number(args.concurrency ?? 10);
const durationSec = Number(args.duration ?? 15);
const outPath = args.out ?? null;

async function jsonFetch(path, init = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${init.root ?? baseUrl}${path}`, {
      ...init,
      // Only send content-type on requests with a body — Fastify's JSON body
      // parser tries (and fails) to parse an empty body when the header
      // claims JSON on a bodyless GET, turning every GET into a 400.
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - started, error: String(err) };
  }
  const ms = performance.now() - started;
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON or empty body — fine for e.g. /healthz */
  }
  return { ok: res.ok, status: res.status, ms, body };
}

async function bootstrapAuth() {
  const email = args.email ?? `loadtest+${Date.now()}@osint.local`;
  const password = args.password ?? 'load-test-password-1234';

  if (args.email) {
    const login = await jsonFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (login.ok) return login.body.accessToken;
    throw new Error(`Login failed for ${email}: HTTP ${login.status} ${JSON.stringify(login.body)}`);
  }

  const reg = await jsonFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName: 'Load Test' }),
  });
  if (!reg.ok) throw new Error(`Registration failed: HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
  return reg.body.accessToken;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log(`Load test: ${baseUrl}  concurrency=${concurrency}  duration=${durationSec}s\n`);

  const token = await bootstrapAuth();
  const authHeader = { authorization: `Bearer ${token}` };

  const scenarios = [
    { name: 'GET /healthz', path: '/healthz', auth: false, root: apiRoot },
    { name: 'GET /auth/me', path: '/auth/me', auth: true },
    { name: 'GET /connectors', path: '/connectors', auth: true },
    { name: 'GET /projects', path: '/projects', auth: true },
    { name: 'GET /dashboard', path: '/dashboard', auth: true },
  ];

  /** @type {Record<string, Array<{ms:number, status:number}>>} */
  const results = Object.fromEntries(scenarios.map((s) => [s.name, []]));

  const deadline = Date.now() + durationSec * 1000;
  let stop = false;
  setTimeout(() => (stop = true), durationSec * 1000);

  async function worker() {
    while (!stop && Date.now() < deadline) {
      const s = scenarios[Math.floor(Math.random() * scenarios.length)];
      const r = await jsonFetch(s.path, { headers: s.auth ? authHeader : {}, root: s.root });
      results[s.name].push({ ms: r.ms, status: r.status });
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - start;

  const report = { baseUrl, concurrency, durationSec, wallMs, scenarios: {} };
  let totalRequests = 0;
  let totalErrors = 0;
  let totalRateLimited = 0;

  console.log(
    `${'Scenario'.padEnd(20)} ${'reqs'.padStart(6)} ${'rps'.padStart(7)} ${'errs'.padStart(5)} ${'429s'.padStart(5)} ${'p50ms'.padStart(7)} ${'p90ms'.padStart(7)} ${'p99ms'.padStart(7)}`,
  );
  for (const s of scenarios) {
    const rows = results[s.name];
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const errors = rows.filter((r) => r.status !== 0 && r.status >= 400 && r.status !== 429).length;
    const rateLimited = rows.filter((r) => r.status === 429).length;
    const rps = rows.length / (wallMs / 1000);
    totalRequests += rows.length;
    totalErrors += errors;
    totalRateLimited += rateLimited;

    report.scenarios[s.name] = {
      requests: rows.length,
      rps: Number(rps.toFixed(2)),
      errors,
      rateLimited,
      p50Ms: Math.round(percentile(ms, 50)),
      p90Ms: Math.round(percentile(ms, 90)),
      p99Ms: Math.round(percentile(ms, 99)),
    };

    console.log(
      `${s.name.padEnd(20)} ${String(rows.length).padStart(6)} ${rps.toFixed(1).padStart(7)} ${String(errors).padStart(5)} ${String(rateLimited).padStart(5)} ${String(Math.round(percentile(ms, 50))).padStart(7)} ${String(Math.round(percentile(ms, 90))).padStart(7)} ${String(Math.round(percentile(ms, 99))).padStart(7)}`,
    );
  }

  console.log(`\nTotal: ${totalRequests} requests in ${(wallMs / 1000).toFixed(1)}s, ${totalErrors} error(s), ${totalRateLimited} rate-limited (429).`);
  if (totalRateLimited > 0) {
    console.log('Rate-limited responses are the platform\'s own abuse protection (@fastify/rate-limit) engaging — expected at this concurrency, not a defect.');
  }

  if (outPath) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nWrote report to ${outPath}`);
  }

  if (totalErrors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
