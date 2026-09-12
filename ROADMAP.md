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
| Connector health system (§32) | ✅ | health probe + storage + per-connector latency-history sparkline/state-strip in the Connectors UI |
| Job system (states, progress, per-step retry) (§37) | ✅ | in-process DB-backed runner: optimistic lock, stale-lock recovery, SSE progress, retry-failed-connectors-only. Redis/BullMQ = interface only |
| Evidence model + immutable IDs + content hash (§9) | ✅ | `EVIDENCE-YYYY-NNNNNN` |
| Audit log (§29) | ✅ | append-only, covers all mutations |
| SSRF guard / outbound fetch policy (§40) | ✅ | |
| Structured logging (§50) | ✅ | pino, request IDs, job diagnostics |
| Health/metrics endpoints | ✅ | `/healthz`, `/readyz`, Prometheus `/metrics` (added Phase 9) |

## Phase 2 — Search

| Item | State | Notes |
|---|---|---|
| Web search connectors: RSS, Wikipedia, HN, generic-fetch | ✅ | key-free, real |
| Web search connectors: Google CSE, Bing, Brave, SearXNG, SerpAPI | 🟡 | implemented; inactive without key → `NOT_CONFIGURED` |
| Universal search interface + Boolean parser (§4) | ✅ | parser + AND/OR/NOT/quote/site:/-domain/date done; visual query builder (Simple/Builder toggle, round-trips through the real parser, live parsed-query preview) in Universal Search and per-investigation Search tab |
| Query expansion engine (§5), original vs. generated kept separate | 🟡 | heuristic expansions done; AI expansion needs provider |
| Result normalization | ✅ | per-connector `normalize()` |
| Deduplication (URL canon, content hash, near-dup simhash) (§18) | 🟡 | exact + canonical + simhash done; semantic needs embeddings |
| Source storage + search history | ✅ | |
| Caching (search responses, fetched pages) (§39) | ✅ | DB-backed TTL cache (`lib/cache.ts`) is now actually wired into `BaseConnector.getJson`/`getText` — generic web-page fetches cache 1h, robots.txt lookups 24h; cache hits skip the rate limiter and budget entirely |
| Rate limiting (per-provider, backoff, jitter, budgets) (§38) | ✅ | token bucket + backoff done; persistent per-connector daily request budget (survives restarts, DB-backed) enforced for Google CSE against its documented 100/day free-tier cap; health-probe pings are exempted so they don't compete with real searches for the quota |

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

## Phase 5 — AI  ✅

| Item | State |
|---|---|
| Provider abstraction — chat (none/ollama/anthropic/openai) + embeddings | ✅ `src/ai/chat.ts`, `src/ai/embeddings.ts`; per-call `ai_usage` accounting; budget guard (§43); honest `chatStatus()` / `embeddingStatus()` |
| Evidence-grounded summarization + anti-hallucination (§13, §14) | ✅ numbered evidence blocks + strict citation contract + **citation validator** (`validateCitations`) that flags every factual sentence with no valid `[E<n>]`; stored in `ai_analyses` with `ungroundedStatements`; "Ask the evidence" UI |
| Query expansion via AI (§5) | ✅ `expandQueriesAI` — JSON output, deduped against executed queries, **not auto-run**; "AI-suggested queries" panel in Search tab |
| Semantic search (§23) | ✅ (Phase 3) |
| Report generation (§28) | ✅ `generateReport` — deterministic assembly of Scope/Methodology/Coverage/Entities/Timeline/Claims/Contradictions/Source-Assessment/Evidence/Limitations from the DB + AI narrative for Exec-Summary/Key-Findings/Conclusion **when a provider is configured** (marked unavailable otherwise, never faked); Markdown / HTML / JSON export with sha256 checksum; Analyst-tab UI |
| Explainability "WHY?" (§47) | ✅ claim WHY panel (Phase 3) + report ungrounded-statement callouts + `citedEvidenceIds` on every AI output |
| PDF / DOCX report export | ✅ Phase 8 |

## Phase 6 — Visual intelligence  ✅

| Item | State |
|---|---|
| Timeline view (§15) | ✅ zoomable, type-filtered |
| Connection graph (§8) | ✅ dependency-free SVG force layout, evidence-backed edges |
| Evidence viewer / entity explorer / source explorer | ✅ |
| Media intelligence (§19) — image format + dimensions, EXIF incl. GPS, perceptual-hash (dHash) duplicate detection + clustering | ✅ `MediaEngine`, auto-collected from evidence media refs + direct upload, `MEDIA_PROCESS` job, Media tab |
| Media OCR / description | ✅ via a configured **multimodal** model (claude-*, gpt-4o, or an Ollama vision model); vision prompt forbids identifying people; honest unavailable otherwise |
| Video / audio transcription | ✅ ffmpeg (audio extraction/normalization to 16kHz mono mp3) + OpenAI Whisper (`OPENAI_API_KEY`, independent of `AI_PROVIDER`); opt-in `transcribe:true` on media processing; honestly SKIPPED naming the exact missing piece (ffmpeg not on PATH, and/or no key) when unavailable |
| Reverse image search | ⚪ needs a provider API key (TinEye / Vision) |
| **Facial identification / biometric matching** | ❌ **never built, by policy (§19, §30)** — no face code anywhere |

## Phase 7 — Monitoring  ✅

| Item | State |
|---|---|
| Monitoring jobs (query, connectors, cron schedule, enabled state) | ✅ CRUD API + Monitoring tab; cron presets (hourly/6h/12h/daily/weekly) or raw cron, validated (`cron-parser`) |
| Scheduler | ✅ 60s ticker finds jobs whose `nextRunAt` has passed and enqueues a `MONITORING_RUN` job (de-duplicated against an in-flight run); manual "run now" uses the same path |
| Change detection (§16) | ✅ every candidate result is checked against the **existing** evidence corpus (URL / canonical URL / content hash) — identical → suppressed (never re-alerted); same URL, different content → **CHANGED** (new evidence row + `TimelineEvent`, references the prior capture); no match → **NEW** |
| Per-run state | ✅ `MonitoringResult` records new/changed/suppressed counts, a plain-English summary, per-connector notices, and any error; `MonitoringJob` tracks `lastRunAt`/`lastSuccessAt`/`nextRunAt`/`lastError`/`rateLimitState` |
| UI | ✅ create/pause/resume/run-now/delete, run history per job, real data on the Home dashboard's Monitoring panel |

Verified E2E: a "Rust programming language" monitor's first run found 40 new
items; an immediate second run correctly suppressed all 40 as already-known,
finding 0 new/changed.

## Phase 8 — Export  ✅

| Item | State |
|---|---|
| Report export: Markdown / HTML / JSON | ✅ (Phase 5) |
| Report export: PDF | ✅ `pdfkit` (pure JS, no headless browser) — renders the same structured sections (headings/paragraphs/lists/tables/blockquotes) via a shared Markdown-block parser; page numbers, ungrounded-statement callouts |
| Report export: DOCX | ✅ `docx` (pure JS OOXML writer) — same shared block parser; verified as a genuinely valid Word document (`word/document.xml` present and populated) |
| CSV exports | ✅ `sources.csv`, `entities.csv`, `relationships.csv`, `timeline.csv`, `claims.csv`, `audit-log.csv` — dependency-free RFC 4180 writer, unit-tested |
| `evidence.json` | ✅ full evidence rows incl. provenance |
| Evidence package (`.zip`) | ✅ `jszip` bundles every CSV + `evidence.json` + the latest report as PDF & DOCX + `manifest.json` with a **sha256 checksum and byte count per file** (§48) |
| UI | ✅ Analyst-tab Export section (package + individual files) and per-report format links |

Verified E2E: generated report → downloaded as PDF (valid `%PDF` header) and
DOCX (valid OOXML zip, `word/document.xml` contains the report title) →
downloaded the full evidence package and confirmed all 10 files + a correct
manifest.

## Phase 9 — Hardening  🟡 core items done; see `docs/SECURITY.md`

| Item | State |
|---|---|
| Security fixes found + fixed this pass | ✅ path-traversal bug in local storage (prefix-matching, not boundary-checked — real bug, now regression-tested), CSV/spreadsheet formula injection, auth-endpoint brute-force rate limiting |
| Dependency scanning | ✅ `npm audit` triaged in `docs/SECURITY.md` — 1 devDependency-only issue, 1 build-time-only issue, 1 accepted-with-mitigation runtime issue (`image-size`), none silently ignored |
| §49 failure-scenario tests | ✅ connector timeout/backoff, malformed/duplicate results, DB-outage `/readyz` behavior, invalid credentials, partial/cancelled job diagnostics, conflicting evidence — see the table in `docs/SECURITY.md` |
| Migration tests | ✅ `npm run db:verify` applies every migration to a brand-new SQLite file |
| Backup / restore | ✅ `scripts/backup.mjs` + `scripts/restore.mjs`, **verified**: backed up a live DB, deleted it, restored, confirmed identical row counts |
| Observability: `/metrics` | ✅ real Prometheus exposition (job/evidence/project/connector-health counts, process stats) — closes the "Prometheus /metrics pending" gap from Phase 1 |
| Observability: job diagnostics | ✅ `GET /jobs/:id/diagnostics` — WHAT/WHERE/WHY/DATA-LOST/RETRY per §50, rule-based from the job's real recorded state |
| Load/performance testing | ⚪ not done — no load-test harness or benchmarks yet |
| Tracing | ⚪ not implemented (would need an OTel collector); structured request-id-tagged logs are the practical substitute today |
| TLS termination | 🟡 operator responsibility (reverse proxy), documented in `docs/SECURITY.md` |

## Phase 10 — God Mode orchestrator (§55, §56)  ✅ verified end-to-end

| Item | State |
|---|---|
| Single TARGET/OBJECTIVE/DATE RANGE/SOURCES/DEPTH/LANGUAGES entry point | ✅ `POST /projects/:id/god-mode` + a `/god-mode` launcher page |
| Composes every engine (§55) | ✅ `GodModeOrchestrator.ts` runs `runResearchRun` (QueryPlanner + SearchOrchestrator + ConnectorRegistry + EvidenceEngine + EntityEngine + ResolutionEngine + CorrelationEngine + ClaimEngine + ContradictionEngine + TimelineEngine, all from Phases 2–3) for the primary target, then — DEEP mode with AI configured — a bounded round of AI-suggested follow-up searches, then ReportEngine (`generateReport`), assembled into one `GodModeRun` row |
| Full §56 15-section result | ✅ Executive Summary, Key Findings, Verified/Unverified Findings, Important Entities, Connection Graph, Timeline, Claims, Contradictions, Source Coverage, Evidence, Information Gaps, Confidence Assessment, Recommended Next Searches, Monitoring Recommendations — every section reads from what actually ran, never invented |
| Uncertainty never hidden | ✅ Information Gaps names the exact missing connector config (e.g. `META_GRAPH_ACCESS_TOKEN`) and zero-count entity types; Executive Summary is explicitly labelled non-AI when no provider is configured |
| Monitoring recommendations are suggestions, not standing config | ✅ `POST /god-mode/:runId/create-monitoring` creates a real `MonitoringJob` only on explicit user action |
| Depth actually changes behavior | ✅ fixed a pre-existing cap while building this: the per-connector query limit was hardcoded to 4 regardless of `depth`; now QUICK=1/STANDARD=4/DEEP=8 |

Verified E2E in-browser: launched a DEEP run for "Linux Foundation" (auto-created
investigation) → watched it progress through the pipeline → landed on a
completed result with 196 evidence records across 5 sources, 5 entity-anchored
claims (SINGLE_SOURCE/MEDIUM, honestly not overclaimed), a connection graph,
timeline, an Information-Gaps section naming the exact unconfigured connectors,
and clicked a Monitoring Recommendation's "create" button — confirmed via the
API that it created a real, enabled daily `MonitoringJob`.

---

## Known blockers (environment)

| Blocker | Impact | Resolution |
|---|---|---|
| No PostgreSQL installed | Using SQLite; no pgvector/semantic search | Install Postgres 16 + pgvector, flip `schema.prisma` provider, set `DATABASE_URL` |
| No Redis | In-process job driver only (no multi-worker) | Install Redis, set `JOB_DRIVER=redis` (BullMQ adapter TODO) |
| No AI provider keys / local model | Heuristic extraction only; no synthesis/semantic | Run Ollama locally or set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` |
| No search API keys | Only RSS/Wikipedia/HN/generic-fetch active | Set any of `GOOGLE_CSE_*`, `BING_SEARCH_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `SEARXNG_BASE_URL` |
| Meta/Instagram require app review | Social connectors inert | Complete Meta app review, obtain page/IG tokens |
| No ffmpeg installed | Video/audio transcription unavailable | Install ffmpeg and put it on `PATH` |
