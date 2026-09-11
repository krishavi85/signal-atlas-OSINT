# Security, testing & operations (Phase 9 hardening)

This consolidates the §40 security checklist, §49 test coverage, and §50
observability/ops posture into one place, stated honestly — what's
implemented, how, and what's a known accepted risk rather than silently
absent.

## §40 checklist

| Control | Status | Where |
|---|---|---|
| Authentication | ✅ | scrypt password hashing (`lib/password.ts`), JWT access + rotating refresh tokens (`auth/tokens.ts`, `auth/service.ts`) |
| Authorization | ✅ | per-project RBAC (OWNER/EDITOR/VIEWER), `assertProjectAccess()` on every route |
| Secure session handling | ✅ | refresh tokens are opaque random values; only their SHA-256 hash is stored; rotated on every refresh; revocable |
| Encryption in transit | 🟡 operator responsibility | the app is protocol-agnostic; terminate TLS at a reverse proxy / load balancer in front of it (documented, not enforced by the app itself) |
| Encryption of sensitive credentials | ✅ | connector credentials AES-256-GCM (`lib/crypto.ts`), key from `CREDENTIAL_ENC_KEY`, never returned to the client |
| Secret management | ✅ | secrets only ever live in `.env` / the DB-encrypted blob; never bundled into the frontend; logs redact known secret-shaped fields (`logger.ts`) |
| Input validation | ✅ | zod schemas on every route body/query/params |
| Output encoding | ✅ | React auto-escapes in the web app; HTML report export escapes user content (`ai.routes.ts` `mdToHtml`); **CSV/spreadsheet formula-injection** neutralized — a cell starting with `= + - @` gets a leading `'` before RFC 4180 quoting (`lib/csv.ts`), tested |
| CSRF | N/A by design | the API is Bearer-token only (`Authorization: Bearer …`), never cookie-based auth, and CORS is restricted to `CORS_ORIGINS`; there is no ambient credential a cross-site form/script could ride, so classic CSRF does not apply. If cookie-based auth is ever added, CSRF tokens must be added at the same time |
| SSRF protection | ✅ | scheme allowlist + private/loopback/link-local/CGNAT/metadata-IP blocks + **DNS-rebind re-check after resolution** + redirect re-validation on every hop (`packages/core/src/ssrf.ts`, `lib/safeFetch.ts`) |
| SQL injection | ✅ | Prisma parameterizes everything; the only raw SQL is a static `SELECT 1` health probe |
| XSS | ✅ | no `dangerouslySetInnerHTML` / `eval` / `new Function` anywhere in the web app (verified) |
| Secure file uploads | 🟡 | size caps (25MB docs, 12MB images), content-type checks, path-traversal-hardened storage keys (below); file **content** is never executed, only parsed for text/metadata |
| Dependency scanning | ✅ | `npm audit` run and triaged (below); no CI gate configured yet |
| Audit logs | ✅ | append-only `audit_logs`, covers every mutation (§29) |

## Fixes made during this hardening pass

1. **Path-traversal in local object storage** (`lib/storage.ts`). The original
   guard was `full.startsWith(resolve(root))`, which is a classic
   prefix-matching bug: a sibling directory like `…/storage-evil` also starts
   with the string `…/storage` and would have passed. Fixed to require an
   exact match or a real path-separator boundary (`root + sep`). A regression
   test (`unit.test.ts`) creates exactly that sibling-prefix directory and
   confirms both a relative (`../../etc/passwd`) and absolute-path escape are
   rejected, and normal reads/writes still work.
2. **CSV/spreadsheet formula injection** (`lib/csv.ts`). Exported cell values
   originate from third-party scraped content. A cell opening with `= + - @`
   is now prefixed with `'` before quoting, so Excel/Sheets/LibreOffice opens
   it as text instead of executing it as a formula. Unit tested.
3. **Auth brute-force throttling.** `/auth/login` and `/auth/register` now
   carry a route-level rate limit (10/min) tighter than the global default
   (300/min); login is additionally keyed by `ip:email` so one IP can't
   exhaust the budget for every account.

## Known accepted risk

- **`image-size` (transitive, no upstream fix).** `npm audit` flags a
  denial-of-service in `image-size`'s ICNS/JXL/HEIF parsers (infinite loop on
  a malformed file). It's used in `lib/mediaExtract.ts` to read image
  dimensions. Mitigations in place: the request path requires an
  authenticated **EDITOR**-role user (direct upload) or content already
  fetched by our own SSRF-guarded connector (not an anonymous public upload
  endpoint), and every fetched image is capped at 12MB. Accepted rather than
  removing image-dimension support entirely; revisit if an upstream fix ships
  or swap to a maintained alternative.
- **`postcss` (transitive, via Next.js's build toolchain).** Several
  sourcemap/stringifier advisories. This is a **build-time** dependency that
  processes our own authored Tailwind CSS, not attacker-controlled input at
  runtime — the app never lets a user submit CSS. A fix requires a Next.js
  major-version upgrade (breaking); tracked, not applied reflexively.
- **`deepmerge-ts` (transitive, via the `prisma` CLI devDependency).** A
  recursion-based DoS in a dev-only tool that never runs in the deployed app.

Run `npm audit` yourself to see current findings; this file will drift from
reality if a new advisory lands without being triaged here.

## §49 test coverage

`npm test` runs `node --test` across all three packages (no mocks in
`packages/core` — it's pure logic exercised directly).

| Scenario (§49 explicitly requires these) | Covered by |
|---|---|
| Connector timeout / rate limit | `packages/connectors/src/sdk/rate-limit.test.ts` — burst exhaustion, exponential backoff + jitter growth, `Retry-After` header handling, non-retryable failures don't back off |
| Malformed / duplicate results | `packages/core/src/core.test.ts` (`deduplicate`), `connectors.contract.test.ts` (normalize() schema validation) |
| Database outage | `GET /readyz` returns 503 with the error when `SELECT 1` fails, rather than a generic 500 |
| AI provider failure / not configured | `services/api/src/unit.test.ts` — every AI route path (`/ai/ask`, `/ai/expand-queries`, embeddings, report AI sections) has an explicit unconfigured-provider branch, verified live in earlier phases |
| Invalid credentials | `auth: crypto/password/token` tests; wrong password / tampered JWT rejected |
| Partial investigation / cancelled job | Job states include `PARTIAL`/`CANCELLED`; `buildJobDiagnostics` tests assert the right WHY/DATA-LOST/RETRY text for each |
| Conflicting evidence | `packages/core/src/claims.test.ts` (`detectClaimConflict`) |
| Migration integrity | `npm run db:verify -w @osint/api` — applies every migration to a **brand-new** SQLite file with `prisma migrate deploy`, catching a migration that only works against an already-patched dev database |
| Path traversal / injection | see "Fixes made" above |

## Observability (§50)

- **Structured logs**: pino, with request IDs and secret redaction (`logger.ts`).
- **Health**: `GET /healthz` (liveness), `GET /readyz` (DB reachability).
- **Metrics**: `GET /metrics` — real Prometheus text exposition computed from
  live counts (jobs by status, evidence by duplicate flag, projects by status,
  per-connector health, user/monitoring counts, process uptime/memory). No
  external metrics library; unauthenticated like the other health endpoints
  (scrapers can't carry a bearer token), and it exposes only aggregate counts,
  never investigation content.
- **Job diagnostics**: `GET /jobs/:id/diagnostics` answers §50's explicit
  requirement — WHAT failed, WHERE, WHY, WHETHER DATA WAS LOST, HOW TO RETRY —
  derived from the job's actual recorded status/error/attempts, never invented.
- **Tracing**: not implemented (would need an OpenTelemetry exporter + a
  collector to send to; the request-id-tagged structured logs are the
  practical substitute at this scale).

## Backup & recovery

```bash
npm run backup -w @osint/api                 # -> services/api/backups/<timestamp>/
npm run restore -w @osint/api -- <dir> --yes # stop the API first
```

`scripts/backup.mjs` copies the SQLite file and the local object-storage
directory. `scripts/restore.mjs` requires the explicit `--yes` flag and always
saves whatever it's about to overwrite into `.before-restore/` first, so a bad
restore is itself reversible. **Verified**: this pass ran the full loop —
backed up a live database (326 evidence records, 1 user), deleted it to
simulate loss, restored, and confirmed identical counts afterward.

For PostgreSQL deployments, use `pg_dump`/`pg_restore` instead — these scripts
are SQLite-specific and say so when `DATABASE_URL` isn't a `file:` URL.
