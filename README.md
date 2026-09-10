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
| 1 | Foundation — monorepo, DB, auth, projects, connector SDK, job system, evidence, audit | 🟡 in progress |
| 2 | Search — web search, query planning, normalization, dedup, history | 🟡 in progress |
| 3 | Intelligence — entity extraction/resolution, claims, relationships, timeline, corroboration, contradictions | ⚪ scaffolded |
| 4 | Social connectors (official APIs only) | ⚪ registry + docs only |
| 5 | AI research analyst + semantic search + reports | ⚪ abstraction only |
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

- **RSS / Atom** — any feed URL, news search via feed aggregators
- **Wikipedia** — REST + OpenSearch APIs
- **Hacker News** — Algolia HN Search API
- **Generic web fetch** — a user-supplied URL, robots-respecting, with content hashing

Configure keys in `.env` to enable Google CSE, Bing, Brave, SearXNG, YouTube,
Reddit, GitHub, and the Meta Graph connectors. See [`docs/CONNECTORS.md`](docs/CONNECTORS.md).

## Tests

```bash
npm test               # unit + connector-contract + api integration
```

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — services, data flow, orchestrator
- [`ROADMAP.md`](ROADMAP.md) — phase plan & definition of done
- [`docs/CONNECTORS.md`](docs/CONNECTORS.md) — connector SDK + per-connector setup
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — schema reference
- [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — evidence IDs, provenance, confidence model
- [`docs/LEGAL.md`](docs/LEGAL.md) — legal & privacy safeguards, retention
- [`docs/AI.md`](docs/AI.md) — provider abstraction, anti-hallucination, cost control
