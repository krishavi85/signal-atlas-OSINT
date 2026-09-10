# Roadmap

Phase order follows spec §54. Each feature is **DONE** only when it satisfies
§52: frontend + backend + DB + API contract + validation + error handling +
permissions + loading state + empty state + tests + logging + docs + a verified
real-data path.

Legend: ✅ done · 🟡 partial (usable, gaps noted) · ⚪ scaffolded (interface/tests only) · ❌ not started

---

## Phase 1 — Foundation

| Item | State | Notes |
|---|---|---|
| Monorepo + TS build | ✅ | npm workspaces, project refs |
| Prisma schema (all 21 tables of §36) | ✅ | SQLite; Postgres-portable |
| Migrations + seed | ✅ | `npm run db:migrate && npm run db:seed` |
| Auth (register/login/refresh/logout, Argon2id, JWT) | ✅ | |
| Project CRUD + RBAC + pause/resume | 🟡 | CRUD+RBAC done; membership invite UI pending |
| Connector SDK (`search/fetch/parse/normalize/healthCheck/rateLimitStatus/capabilities`) | ✅ | `packages/connectors/src/sdk` |
| Connector registry + capability registry (§31) | ✅ | |
| Connector health system (§32) | 🟡 | health probe + storage done; latency history chart pending |
| Job system (states, progress, per-step retry) (§37) | 🟡 | in-process driver done; Redis driver interface only |
| Evidence model + immutable IDs + content hash (§9) | ✅ | `EVIDENCE-YYYY-NNNNNN` |
| Audit log (§29) | ✅ | append-only, covers all mutations |
| SSRF guard / outbound fetch policy (§40) | ✅ | |
| Structured logging (§50) | ✅ | pino, request IDs, job diagnostics |
| Health/metrics endpoints | 🟡 | `/healthz`, `/readyz` done; Prometheus `/metrics` pending |

## Phase 2 — Search

| Item | State | Notes |
|---|---|---|
| Web search connectors: RSS, Wikipedia, HN, generic-fetch | ✅ | key-free, real |
| Web search connectors: Google CSE, Bing, Brave, SearXNG, SerpAPI | 🟡 | implemented; inactive without key → `NOT_CONFIGURED` |
| Universal search interface + Boolean parser (§4) | 🟡 | parser + AND/OR/NOT/quote/site:/-domain/date done; advanced builder UI pending |
| Query expansion engine (§5), original vs. generated kept separate | 🟡 | heuristic expansions done; AI expansion needs provider |
| Result normalization | ✅ | per-connector `normalize()` |
| Deduplication (URL canon, content hash, near-dup simhash) (§18) | 🟡 | exact + canonical + simhash done; semantic needs embeddings |
| Source storage + search history | ✅ | |
| Caching (search responses, fetched pages) (§39) | 🟡 | response cache w/ TTL done; page cache pending |
| Rate limiting (per-provider, backoff, jitter, budgets) (§38) | 🟡 | token bucket + backoff done; budget enforcement partial |

## Phase 3 — Intelligence

| Item | State |
|---|---|
| Entity extraction (18 types, confidence, context) (§6) | 🟡 heuristic (regex/gazetteer); AI adapter wired, off by default |
| Entity resolution (blocking, scored, reversible merge) (§7) | ⚪ interface + match scorer + tests |
| Relationship graph model + evidence-traceable edges (§8) | ⚪ schema done; builder + API partial |
| Claim engine (subject/predicate/object, multi-evidence) (§10) | ⚪ schema + extractor stub |
| Corroboration (single/multi/independent/contradicted) (§11) | ⚪ interface + independence heuristic |
| Source quality scoring, explainable (§12) | ⚪ rubric defined |
| Confidence model (factor-based, exposed) (§44) | 🟡 factor computation done; UI surfacing partial |
| Contradiction engine (§45) | ⚪ interface |
| Timeline engine (§15) | ⚪ schema + aggregation stub |

## Phase 4 — Social connectors (official APIs only)

| Item | State |
|---|---|
| Meta Graph (Facebook Pages/Posts/Events — public, permitted) | ⚪ client + capability registry + setup docs; **requires app review + tokens** |
| Instagram Graph (business/creator public data) | ⚪ same |
| YouTube Data API v3 | 🟡 implemented; needs `YOUTUBE_DATA_API_KEY` |
| Reddit (OAuth script app) | 🟡 implemented; needs client id/secret |
| GitHub REST | 🟡 implemented; anonymous works, token raises limits |
| **Explicitly NOT built:** scraping, auth bypass, private data, CAPTCHA solving | ✅ by policy |

## Phase 5 — AI

| Item | State |
|---|---|
| Provider abstraction (none/ollama/anthropic/openai) | 🟡 chat + embeddings interface; ollama + anthropic + openai adapters |
| Evidence-grounded summarization + anti-hallucination (§13, §14) | ⚪ prompt contracts + citation validator designed |
| Query expansion via AI | ⚪ |
| Semantic search (pgvector / local) (§23) | ⚪ needs embeddings + vector store |
| Report generation (§28) | ⚪ |
| Explainability ("WHY?") (§47) | ⚪ evidence-trace assembler stub |

## Phase 6 — Visual intelligence

Knowledge graph (Cytoscape/Sigma), timeline (vis-timeline), source explorer,
entity explorer, evidence viewer. ❌ not started (API endpoints partially exist).

## Phase 7 — Monitoring

Monitoring jobs (query/sources/schedule/state), change detection with
duplicate suppression, alerts, new-evidence detection. ❌ schema done, engine not started.

## Phase 8 — Export

PDF / DOCX / HTML / Markdown / JSON / CSV reports; evidence package zip with
checksums (§48). ❌ not started; report structure (§28) documented.

## Phase 9 — Hardening

Security tests, load/perf, tracing, error reporting, backup/restore scripts,
rate-limit tuning. 🟡 ongoing.

## Phase 10 — God Mode orchestrator (§55, §56)

`GodModeResearchOrchestrator` composing every engine into one autonomous
workflow with the §56 result layout. ❌ not started — depends on Phases 3, 5, 7, 8.

---

## Known blockers (environment)

| Blocker | Impact | Resolution |
|---|---|---|
| No PostgreSQL installed | Using SQLite; no pgvector/semantic search | Install Postgres 16 + pgvector, flip `schema.prisma` provider, set `DATABASE_URL` |
| No Redis | In-process job driver only (no multi-worker) | Install Redis, set `JOB_DRIVER=redis` (BullMQ adapter TODO) |
| No AI provider keys / local model | Heuristic extraction only; no synthesis/semantic | Run Ollama locally or set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` |
| No search API keys | Only RSS/Wikipedia/HN/generic-fetch active | Set any of `GOOGLE_CSE_*`, `BING_SEARCH_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `SEARXNG_BASE_URL` |
| Meta/Instagram require app review | Social connectors inert | Complete Meta app review, obtain page/IG tokens |
