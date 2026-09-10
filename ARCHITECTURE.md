# Architecture

## Guiding principles

1. **Evidence-first.** Every persisted finding links to one or more immutable
   evidence records with provenance (source URL, connector, query, timestamps,
   content hash). Reports cite evidence IDs.
2. **Provenance boundary.** The system always distinguishes:
   `WHAT THE SOURCE SAID` · `WHAT THE SYSTEM EXTRACTED` ·
   `WHAT MULTIPLE SOURCES CONFIRM` · `WHAT THE AI INFERRED` · `WHAT IS UNKNOWN`.
3. **No fake features.** A capability that cannot run (missing key, unsupported
   by a source, blocked by ToS) is surfaced as unavailable with the missing
   dependency named. Never fabricated output.
4. **Modularity.** Connectors, AI providers, storage, job queue, and search
   backend are all behind interfaces and swappable.
5. **Local-first option.** Runs fully on SQLite + local files + heuristic
   extractors with zero third-party calls. Cloud AI/search are opt-in.

## Component map

```
┌──────────────┐     HTTP/SSE      ┌───────────────────────────────────────────┐
│  apps/web     │ ───────────────▶ │  services/api  (Fastify)                    │
│  Next.js      │ ◀─────────────── │                                            │
└──────────────┘                   │  ┌─────────────────────────────────────┐   │
                                   │  │ HTTP routes (REST) + SSE stream      │   │
                                   │  ├─────────────────────────────────────┤   │
                                   │  │ AuthService  ProjectService          │   │
                                   │  │ EvidenceManager   AuditLog           │   │
                                   │  ├─────────────────────────────────────┤   │
                                   │  │ SearchOrchestrator                   │   │
                                   │  │  ├ QueryPlanner                      │   │
                                   │  │  ├ ConnectorRegistry ───────────────┼───┼──▶ packages/connectors
                                   │  │  ├ SearchScheduler (rate/budget)     │   │
                                   │  │  ├ ResultNormalizer                  │   │
                                   │  │  ├ DeduplicationEngine ──────────────┼───┼──▶ packages/core
                                   │  │  ├ EntityExtractor (heuristic|AI)    │   │
                                   │  │  ├ EntityResolver                    │   │
                                   │  │  ├ ClaimExtractor                    │   │
                                   │  │  ├ CorroborationEngine               │   │
                                   │  │  └ RankingEngine                     │   │
                                   │  ├─────────────────────────────────────┤   │
                                   │  │ JobRunner (DB-backed queue)          │   │
                                   │  │ AIProviderRegistry (none|ollama|...) │   │
                                   │  └─────────────────────────────────────┘   │
                                   │        │                    │               │
                                   │        ▼                    ▼               │
                                   │  Prisma / SQLite      Storage (local|S3)    │
                                   └───────────────────────────────────────────┘
```

## Request → intelligence pipeline (§2)

`Query → Plan → Search → Collect → Parse → Normalize → Deduplicate →
Extract Entities → Resolve Entities → Correlate → Verify → Score → Analyze →
Timeline → Visualize → Report → Monitor`

Implemented as a **job graph**. A `RESEARCH_RUN` job spawns child steps; each
step is retryable in isolation (§37). Progress is streamed to the client over
SSE and persisted on the `Job` row.

| Step | Module | Phase |
|------|--------|-------|
| Plan | `QueryPlanner` | 2 |
| Search / Collect | `SearchOrchestrator` + `ConnectorRegistry` | 2 |
| Parse / Normalize | `ResultNormalizer` (per connector) | 2 |
| Deduplicate | `DeduplicationEngine` (URL canon, content hash, near-dup) | 2 |
| Extract Entities | `EntityExtractor` (regex heuristics now; AI adapter) | 3 |
| Resolve Entities | `EntityResolver` (blocking + scored match) | 3 |
| Correlate | `RelationshipBuilder` | 3 |
| Verify / Score | `CorroborationEngine` + `ConfidenceModel` | 3 |
| Analyze / Timeline | `TimelineEngine`, `ContradictionEngine` | 3 |
| Report | `ReportEngine` | 8 |
| Monitor | `MonitoringEngine` | 7 |

## Technology choices & swap points

| Concern | Now | Production target | Swap point |
|---|---|---|---|
| DB | SQLite | PostgreSQL (+ pgvector) | `prisma/schema.prisma` datasource + `DATABASE_URL` |
| Full-text | SQLite FTS5 | Postgres FTS → OpenSearch | `SearchIndex` interface in `core` |
| Queue | in-process DB poller | BullMQ + Redis | `JobDriver` interface |
| Object storage | local FS | S3-compatible | `StorageDriver` interface |
| Embeddings | none / Ollama | pgvector | `EmbeddingProvider` interface |
| Realtime | SSE | SSE or WS | `services/api/src/realtime` |

## Security model (§40)

- Argon2id password hashing, JWT access + rotating refresh tokens.
- Per-project RBAC (`OWNER` / `EDITOR` / `VIEWER`).
- Connector credentials encrypted at rest (AES-256-GCM, `CREDENTIAL_ENC_KEY`),
  never returned to the client, never bundled into frontend.
- SSRF guard on all outbound fetches (blocks RFC1918 / link-local / metadata IPs,
  scheme allowlist, redirect re-validation).
- Zod validation on every route; parameterized queries via Prisma.
- Full audit log (§29) — append-only `AuditLog` table.

## What is NOT built yet

See `ROADMAP.md`. The API and DB schema are designed for the full model; many
services are interface + partial implementation + tests, explicitly marked.
