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
| Project CRUD + RBAC + pause/resume | ✅ | CRUD, OWNER/EDITOR/VIEWER, membership API, pause/resume all done |
| Connector SDK (`search/fetch/parse/normalize/healthCheck/rateLimitStatus/capabilities`) | ✅ | `packages/connectors/src/sdk` |
| Connector registry + capability registry (§31) | ✅ | |
| Connector health system (§32) | 🟡 | health probe + storage done; latency history chart pending |
| Job system (states, progress, per-step retry) (§37) | ✅ | in-process DB-backed runner: optimistic lock, stale-lock recovery, SSE progress, retry-failed-connectors-only. Redis/BullMQ = interface only |
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

## Phase 3 — Intelligence  🟡 mostly done, verified end-to-end

| Item | State |
|---|---|
| Entity extraction (18 types, confidence, context) (§6) | ✅ deterministic (regex/gazetteer) + TLD allowlist + prose-fragment / self-domain / platform-host filtering; runs in pipeline |
| Entity resolution (blocking, scored, reversible merge) (§7) | ✅ Jaro-Winkler + identifier/acronym factors; auto-pass merges LIKELY_SAME only (strong factor required), SYSTEM-attributed + reversible + logged; manual merge-candidate API |
| Relationship graph + evidence-traceable edges (§8) | ✅ RelationshipBuilder: co-mention (≥2 evidence) / posted-by / shares-domain, each edge stores its evidence ids; `/graph` + `/relationships` APIs; SVG graph UI |
| Claim engine (subject/predicate/object, multi-evidence) (§10) | ✅ deterministic entity-anchored patterns; ClaimEvidence links w/ stance + excerpt. Shallow parsing — labelled heuristic |
| Corroboration (single/multi/independent/contradicted) (§11) | ✅ per-claim independent-source counting (distinct domain ∧ cluster), classification, verification status |
| Source quality scoring, explainable (§12) | ✅ tier + score + reasons, recomputed per search, surfaced in Overview |
| Confidence model (factor-based, exposed) (§44) | ✅ 5–6 weighted factors per claim w/ explanations; "WHY?" panel renders them |
| Contradiction engine (§45) | ✅ pairwise conflict detection; HIGH for numeric/date/single-value; rows left OPEN, analyst resolves (never auto-picked); UI controls |
| Timeline engine (§15) | ✅ events from evidence dates + dated claims; zoom + type filter UI; idempotent rebuild, analyst events preserved |
| Document ingestion (PDF/DOCX/TXT/CSV/JSON/HTML) (§20) | ✅ upload → storage → text+metadata extract (unpdf/mammoth/native) → Evidence → entities → re-run claim/relationship/timeline passes; Documents tab UI |
| Semantic search (§23) | ✅ EmbeddingProvider abstraction (ollama/openai), `evidence_embeddings` table, in-process cosine rank, EMBED job, Evidence-tab semantic mode. **Unavailable & honest** without a configured provider (no lexical results faked as semantic) |

## Phase 4 — Social connectors (official APIs only)  🟡 built, mostly gated on operator credentials

| Item | State |
|---|---|
| Meta Graph (Facebook Pages/Posts/Events) | ✅ implemented — official Graph API only, reads a Page the token can access (metadata + posts + events), honestly declares that no cross-Facebook search exists for third parties and that it needs App Review + `META_GRAPH_ACCESS_TOKEN` |
| Instagram Graph (`business_discovery`) | ✅ implemented — public profile + recent media of a business/creator account by username; declares App Review + Business account + `INSTAGRAM_GRAPH_ACCESS_TOKEN` + `INSTAGRAM_BUSINESS_USER_ID` |
| YouTube Data API v3 | ✅ implemented; needs `YOUTUBE_DATA_API_KEY` |
| Reddit (OAuth script app) | ✅ implemented; needs client id/secret; per-project subreddit scoping |
| GitHub REST | ✅ implemented; anonymous works, `GITHUB_TOKEN` raises limits |
| Wayback Machine (Internet Archive) | ✅ **new, key-free** — query a domain/URL to list captures over time; snapshot fetch; monitoring-capable |
| Per-project connector scope config (§4, §17) | ✅ `connectorScopesJson` on Project + "Configure sources" UI (RSS feeds, subreddits, …); orchestrator passes it into `search({ scope })` |
| **Explicitly NOT built:** scraping, auth bypass, private data, CAPTCHA solving, non-public account data | ✅ by policy (§30) — connectors report `PLATFORM_RESTRICTION` gaps instead |

## Phase 5 — AI  🟡 done except deep report polish

| Item | State |
|---|---|
| Provider abstraction — chat (none/ollama/anthropic/openai) + embeddings | ✅ `src/ai/chat.ts`, `src/ai/embeddings.ts`; per-call `ai_usage` accounting; budget guard (§43); honest `chatStatus()` / `embeddingStatus()` |
| Evidence-grounded summarization + anti-hallucination (§13, §14) | ✅ numbered evidence blocks + strict citation contract + **citation validator** (`validateCitations`) that flags every factual sentence with no valid `[E<n>]`; stored in `ai_analyses` with `ungroundedStatements`; "Ask the evidence" UI |
| Query expansion via AI (§5) | ✅ `expandQueriesAI` — JSON output, deduped against executed queries, **not auto-run**; "AI-suggested queries" panel in Search tab |
| Semantic search (§23) | ✅ (Phase 3) |
| Report generation (§28) | ✅ `generateReport` — deterministic assembly of Scope/Methodology/Coverage/Entities/Timeline/Claims/Contradictions/Source-Assessment/Evidence/Limitations from the DB + AI narrative for Exec-Summary/Key-Findings/Conclusion **when a provider is configured** (marked unavailable otherwise, never faked); Markdown / HTML / JSON export with sha256 checksum; Analyst-tab UI |
| Explainability "WHY?" (§47) | ✅ claim WHY panel (Phase 3) + report ungrounded-statement callouts + `citedEvidenceIds` on every AI output |
| PDF / DOCX report export | ⚪ Phase 8 (MD/HTML/JSON done) |

## Phase 6 — Visual intelligence

Timeline view (§15) ✅ · connection graph (§8) ✅ · evidence viewer ✅ ·
entity explorer ✅ · source explorer (Overview "top sources") 🟡.
Remaining: media intelligence — image/video metadata, OCR, transcripts,
perceptual-hash dup detection (§19). ❌ not started (`media` table exists).

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
