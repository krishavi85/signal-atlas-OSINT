# Evidence, provenance & confidence

## Evidence records (§9)

Every result the platform keeps becomes an **Evidence** row with an immutable,
human-quotable id:

```
EVIDENCE-2026-000042
```

(`EVIDENCE-<UTC year>-<6-digit sequence>`, allocated atomically from the
`counters` table.)

Each record retains, where available:

| field | meaning |
|-------|---------|
| `url`, `canonicalUrl` | original + canonicalised (tracking params stripped, params sorted) |
| `sourcePlatform`, `connectorId` | what fetched it |
| `discoveryQuery` | the exact query string that surfaced it |
| `searchId` | the search run it belongs to |
| `title`, `author`, `publishedAt`, `retrievedAt` | bibliographic |
| `excerpt`, `fullText`, `language` | content |
| `rawMetadata` | connector-specific JSON, kept verbatim |
| `contentHash` | SHA-256 of normalised `{url,title,body}` — integrity + exact-dup key |
| `simhash` | 64-bit SimHash for near-duplicate detection |
| `isDuplicate`, `duplicateOfId`, `duplicateReason`, `clusterId` | dedup outcome |
| `analysisStatus`, `verificationStatus` | pipeline + corroboration state |

Deleting an evidence record is audit-logged with its id and content hash, so the
fact that it existed is never lost (§29, §30).

## Deduplication (§18)

Tiers, strongest first: **exact URL → canonical URL → content hash → SimHash
near-duplicate**. Copies of one story on different domains are tagged
`SYNDICATED` and grouped by `clusterId`. Corroboration counting uses
`countIndependentSources()` — distinct registrable domain **and** distinct
cluster — so ten syndicated reprints count as **one** independent source.

## Provenance boundary (§13, §57)

Every stored assertion carries an epistemic tag and an origin:

| tag | when |
|-----|------|
| `FACT` | observed in a primary/authoritative source **and** corroborated |
| `SOURCE` | a source asserts it; not independently verified |
| `CLAIM` | an extracted subject-predicate-object assertion, pending verification |
| `INFERENCE` | derived by the system/AI from other records |
| `HYPOTHESIS` | a tentative explanation (analyst or AI) |
| `UNKNOWN` | an information gap — *"Not found in the searched sources"* |

| origin | |
|--------|--|
| `SOURCE_CONTENT` | verbatim from a source |
| `DETERMINISTIC_EXTRACTION` | regex / parser / gazetteer — **labelled heuristic, never "ML"** |
| `AI_EXTRACTION` / `AI_SYNTHESIS` | produced by an LLM |
| `HUMAN_ANALYST` | an analyst wrote it |
| `SYSTEM_CORRELATION` | computed by a correlation engine |

`assertFactHasEvidence()` throws if anything tagged `FACT` has zero evidence
references — the anti-hallucination guard (§14).

## Confidence model (§44)

Confidence is **computed from explicit factors**, not emitted by a model:

```
source_reliability · independent_corroboration · entity_resolution_certainty ·
date_consistency · evidence_directness · contradiction_penalty · evidence_completeness
```

Each factor has a value in `[-1, 1]`, a weight, and a plain-text explanation.
`scoreConfidence()` returns `{ score, level, factors }`. Rules:

- a strong `contradiction_penalty` caps the level at `LOW`
- `VERIFIED` requires genuine `independent_corroboration ≥ 0.75`, not just a high mean

The factor list is what the **"WHY?"** panel (§47) shows — no hidden chain-of-thought.

## Source quality (§12)

`assessSourceQuality()` assigns a tier (`PRIMARY_OFFICIAL` … `ANONYMOUS_OR_USER_GENERATED`)
and a score, each with reasons. Popularity alone never lifts an unknown source to
"authoritative"; independent corroboration nudges the effective score by at most
+0.15.
