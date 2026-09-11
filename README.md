# OSINT Platform

**Public Intelligence, OSINT, Search & Investigation Platform.**

Discover, collect, normalize, correlate, verify, monitor, and report on
**lawfully accessible public information**. Evidence-first: every finding keeps
its provenance, and AI inferences are never presented as verified fact.

> ⚠️ **Legal & ethical scope.** This tool is for legitimate research using
> lawfully accessible information. It does **not** bypass authentication,
> privacy settings, CAPTCHAs, anti-bot systems, or platform access controls;
> it does not perform covert biometric identification or ingest illegally
> obtained data. See [`docs/LEGAL.md`](docs/LEGAL.md) and §30 of the spec.

---

## Status

This repository is under active construction against a 10-phase roadmap
([`ROADMAP.md`](ROADMAP.md)). Current state:

| Phase | Area | State |
|------:|------|-------|
| 1 | Foundation — monorepo, DB, auth, projects, connector SDK, job system, evidence, audit | ✅ done |
| 2 | Search — web search, query planning, normalization, dedup, history, rate limiting, caching | ✅ done |
| 3 | Intelligence — entity extraction/resolution, claims, relationships, timeline, corroboration, contradictions, document ingestion, semantic search | ✅ done |
| 4 | Social connectors (official APIs only) + Wayback + per-project source scoping | ✅ built (Meta/IG/YouTube/Reddit gated on operator credentials) |
| 5 | AI research analyst — evidence-grounded Q&A + citation validator, AI query expansion, report generation (MD/HTML/JSON) | ✅ done (degrades honestly with no AI provider) |
| 6 | Visual intelligence — timeline, connection graph, explorers, media intelligence (metadata/EXIF-GPS/perceptual-dedup, vision-model OCR) | ✅ done (video/audio transcription not bundled; no facial ID by policy) |
| 7 | Monitoring — scheduled search jobs, change detection vs. the existing evidence corpus, alerting state | ✅ done |
| 8 | Export — PDF/DOCX/MD/HTML/JSON reports, CSV exports, zipped evidence package with sha256 manifest | ✅ done |
| 6 | Visual intelligence — graph, timeline, explorers | ⚪ not started |
| 7 | Monitoring — scheduled search, change detection, alerts | ⚪ not started |
| 8 | Export — PDF/DOCX/CSV/JSON/MD + evidence packages | ⚪ not started |
| 9 | Hardening — security, perf, observability, backups | ⚪ ongoing |
| 10 | God Mode orchestrator | ⚪ not started |

The **capability registry** (§31) and **connector health** (§32) surfaces in the
UI show exactly which operations are live vs. blocked-by-missing-dependency.
Nothing renders fabricated results.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md). In short:

```
apps/web            Next.js dashboard (App Router, Tailwind)
services/api         Fastify API + orchestrator + job runner + Prisma
packages/core        Domain model: evidence, confidence, dedup, heuristic extractors
packages/connectors  Connector SDK + built-in connectors + registry
```

## Quick start

```bash
# 1. install
npm install

# 2. configure (all keys optional — missing keys => connector shows NOT_CONFIGURED)
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # paste into AUTH_JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # paste into CREDENTIAL_ENC_KEY

# 3. database (SQLite, zero external deps)
npm run db:migrate
npm run db:seed        # creates an admin user printed to console

# 4. run
npm run dev            # api on :4000, web on :3000
```

Open http://localhost:3000.

## Working connectors out of the box (no API key)

- **Wikipedia** — MediaWiki + REST APIs
- **Hacker News** — Algolia HN Search API
- **RSS / Atom** — any feed URL (configure per project under *Search → Configure sources*)
- **Wayback Machine** — Internet Archive capture history for a domain/URL
- **Generic web fetch** — a user-supplied URL, robots-respecting, content-hashed
- **GitHub** — works anonymously (a token just raises rate limits)
- **Document upload** — PDF / DOCX / TXT / CSV / JSON / HTML

Configure keys in `.env` to enable Google CSE, Brave, SearXNG, YouTube,
Reddit, and the Meta (Facebook/Instagram) Graph connectors. Optional embedding
provider (Ollama/OpenAI) unlocks semantic search. See
[`docs/CONNECTORS.md`](docs/CONNECTORS.md) and [`docs/AI.md`](docs/AI.md).

## Tests

```bash
npm test                          # unit + connector-contract + api unit tests
npm run db:verify -w @osint/api   # migration integrity: fresh DB + prisma migrate deploy
```

## Backup & restore

```bash
npm run backup -w @osint/api                 # -> services/api/backups/<timestamp>/
npm run restore -w @osint/api -- <dir> --yes  # stop the API first
```

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full hardening posture
(§40 checklist, dependency audit triage, §49 failure-scenario coverage, §50
observability).

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — services, data flow, orchestrator
- [`ROADMAP.md`](ROADMAP.md) — phase plan & definition of done
- [`docs/CONNECTORS.md`](docs/CONNECTORS.md) — connector SDK + per-connector setup
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — schema reference
- [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — evidence IDs, provenance, confidence model
- [`docs/LEGAL.md`](docs/LEGAL.md) — legal & privacy safeguards, retention
- [`docs/AI.md`](docs/AI.md) — provider abstraction, anti-hallucination, cost control
- [`docs/SECURITY.md`](docs/SECURITY.md) — §40 checklist, test coverage, observability, backup/restore
