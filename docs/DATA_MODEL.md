# Data model

Authoritative source: `services/api/prisma/schema.prisma`. SQLite for local dev;
Postgres-portable (no SQLite-only features; enum-like values are checked strings;
`Json` maps to `jsonb` on Postgres).

## Tables (§36)

| table | purpose |
|-------|---------|
| `users`, `auth_sessions` | identity, argon-style scrypt hashes, rotating refresh tokens |
| `projects`, `project_members` | investigations (§21) + per-project RBAC (OWNER/EDITOR/VIEWER) |
| `connectors`, `connector_health` | connector config (encrypted creds) + health history (§32) |
| `searches`, `queries`, `search_runs` | search history, planned queries (original vs generated), per-connector execution records + coverage (§46) |
| `sources`, `documents` | publishers/domains with quality tiers; uploaded documents (§20) |
| `evidence` | the spine (§9) — provenance, content hash, simhash, dedup pointers, statuses |
| `entities`, `entity_aliases`, `evidence_entities`, `entity_merge_log` | extracted entities (§6), resolution + reversible merges (§7) |
| `relationships` | evidence-traceable edges (§8) |
| `claims`, `claim_evidence`, `contradictions` | subject-predicate-object claims (§10), multi-evidence support/contradiction (§11, §45) |
| `timeline_events` | chronology (§15) |
| `monitoring_jobs`, `monitoring_results` | scheduled search + change detection (§16, §17) |
| `media` | image/video/OCR/transcript records + perceptual hash (§19) |
| `notes` | analyst notebook (§22) — human vs AI origin kept distinct |
| `reports` | generated reports + checksums (§28, §48) |
| `jobs` | background job queue with progress + per-step state (§37) |
| `audit_logs` | append-only record of every consequential action (§29) |
| `response_cache` | connector response cache with TTL (§39) |
| `ai_usage` | per-call token/cost accounting (§43) |
| `counters` | atomic sequence for evidence ids |

## Key relationships

```
Project 1─* Search 1─* Query
Project 1─* Search 1─* SearchRun *─1 Connector
Project 1─* Evidence *─1 Connector,  Evidence *─1 Source,  Evidence *─0..1 Document
Evidence *─* Entity   (via EvidenceEntity, carries offset/confidence/method/origin)
Evidence 1─* Evidence (duplicateOf self-relation, + clusterId grouping)
Entity  *─0..1 Entity (mergedInto self-relation; EntityMergeLog records + reverses)
Entity  1─* Relationship *─1 Entity  (edge.evidenceIds → Evidence[])
Claim   *─* Evidence  (via ClaimEvidence, stance SUPPORTS|CONTRADICTS|CONTEXT)
Claim   1─* Contradiction *─1 Claim
```

## Migrations

```bash
npm run db:migrate     # dev: create + apply a migration
npm run db:deploy       # prod: apply pending migrations
npm run db:seed         # connectors + first admin + sample project
npm run db:studio       # Prisma Studio browser
```

## Switching to PostgreSQL

1. `schema.prisma` → `datasource db { provider = "postgresql" }`
2. `DATABASE_URL="postgresql://user:pass@host:5432/osint?schema=public"`
3. `npm run db:migrate`
4. (optional) add `pgvector` + an `embedding` column on `evidence` for semantic search.
