# CLAUDE.md

Guidance for AI agents working in this repository.

## What this is

A production-grade **OSINT / public-intelligence investigation platform**.
Evidence-first, provenance-preserving, honest about capability gaps. Built
against the 57-section spec captured in `ROADMAP.md` (phase plan) and
`ARCHITECTURE.md`.

## Layout

```
packages/core         Pure domain logic (no I/O): evidence IDs, confidence model,
                      Boolean query parser, dedup (SimHash), entity heuristics,
                      corroboration/source-quality rubrics, SSRF URL guard.
packages/connectors   Connector SDK + registry + 12 built-in connectors.
services/api          Fastify API, Prisma (SQLite), orchestrator, job runner.
apps/web              Next.js dashboard (App Router, Tailwind, client-rendered).
```

## Non-negotiable rules (from the spec)

1. **No fake features (§51).** Never a button with no backend. Never fabricated
   results. A capability that can't run reports a typed `CapabilityGap` with the
   exact missing dependency; the UI shows it honestly.
2. **Provenance boundary (§13/§57).** Keep `SOURCE_CONTENT` /
   `DETERMINISTIC_EXTRACTION` / `AI_EXTRACTION` / `AI_SYNTHESIS` /
   `HUMAN_ANALYST` distinct. Never call the regex/gazetteer extractors "ML" or
   "NER" in UI or docs — they are `DETERMINISTIC_EXTRACTION` / "heuristic".
3. **Evidence-first (§9).** Every persisted finding links to `Evidence` rows.
   Evidence IDs (`EVIDENCE-YYYY-NNNNNN`) are immutable.
4. **Anti-hallucination (§14).** `assertFactHasEvidence()` — no evidence, no
   `FACT` tag. Missing info → `UNKNOWN` / "Not found in the searched sources".
5. **Lawful only (§30).** No scraping of auth'd surfaces, no CAPTCHA/anti-bot
   evasion, no private data, no covert biometrics. See `docs/LEGAL.md`.
6. **Confidence is computed (§44)**, not model-emitted — factor list is exposed.

## Dev commands

```bash
npm install
cp .env.example .env      # fill AUTH_JWT_SECRET + CREDENTIAL_ENC_KEY (generators in README)
npm run db:migrate -w @osint/api
npm run db:seed   -w @osint/api        # prints an admin password
npm run dev                             # api :4000, web :3000
npm test                                # core + connector-contract + api unit
```

Env blockers in the current deployment: no PostgreSQL (SQLite), no Redis
(in-process jobs), no AI keys (heuristics only), no search-provider keys
(RSS/Wikipedia/HN/web-fetch active). All degrade honestly.

## Adding a connector

Subclass `BaseConnector`, implement `configGaps()` + `normalize()` +
`healthCheck()` (+ `search`/`fetch` as supported), register in
`packages/connectors/src/index.ts`. `parse()` default already unwraps `RawHit.raw`.
Add a case to `connectors.contract.test.ts`.

## Testing

`node --test --import tsx` (Node's built-in runner). Keep `packages/core` pure
and well-covered — it has no mocks and everything downstream depends on it.
