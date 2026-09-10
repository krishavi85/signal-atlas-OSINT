# AI layer (§13, §14, §42, §43)

## Status

**Implemented** (Phase 5): chat + embedding provider abstraction, evidence-grounded
Q&A with a citation validator, AI query expansion, and report generation.

With `AI_PROVIDER=none` (the default in this deployment) the platform runs
entirely on **deterministic heuristic extractors** and never calls a model:
"Ask the evidence" and "AI-suggested queries" return an honest *unavailable*
response, and **report generation still works** — it produces the full
evidence-cited report and marks the narrative sections as unavailable rather
than fabricating them (§51).

Enable AI:

```
AI_PROVIDER=ollama            # or anthropic / openai
AI_MODEL_SYNTH=llama3.1:8b    # or claude-sonnet-5 / gpt-4o
AI_MODEL_EXTRACT=llama3.1:8b  # optional smaller model for extraction/expansion
# plus ANTHROPIC_API_KEY or OPENAI_API_KEY for the hosted providers
```

## Provider abstraction (§42)

`AI_PROVIDER` selects the chat provider: `none | ollama | anthropic | openai`.
`AI_EMBEDDINGS_PROVIDER` selects embeddings: `none | ollama | openai`.

The intended interface (to live in `services/api/src/ai/`):

```ts
interface ChatProvider {
  id: string;
  complete(req: { system: string; messages: Msg[]; jsonSchema?: object }): Promise<{ text: string; usage: TokenUsage }>;
}
interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: TokenUsage }>;
}
```

Adapters: `ollama` (local, `OLLAMA_BASE_URL`), `anthropic` (`ANTHROPIC_API_KEY`),
`openai` (`OPENAI_API_KEY`). The research engine depends only on the interface,
so the model is replaceable without touching orchestration.

Local-first (§35): run Ollama, set `AI_PROVIDER=ollama`,
`AI_MODEL_EXTRACT=llama3.1:8b`, `AI_MODEL_SYNTH=…`, and no investigation content
leaves the machine.

## Anti-hallucination contract (§14) — implemented

Every AI call that produces factual output:

1. receives the candidate evidence as numbered blocks `[E1] EVIDENCE-… "excerpt"`
   (`buildEvidenceContext`, `src/ai/grounding.ts`);
2. is instructed to cite `[E1]` / `[E2, E5]` after every factual sentence and to
   say exactly *"Not found in the searched sources."* for gaps;
3. is passed through **`validateCitations`**, which maps citations back to
   evidence ids, records `citedEvidenceIds`, and returns `ungroundedStatements`
   — every factual-looking sentence with no valid citation. Those are surfaced
   in the UI and in reports under a "not to be treated as fact" callout, never
   silently kept. Out-of-range refs (`[E99]`) are reported as `invalidRefs`.

`assertFactHasEvidence()` (`packages/core`) is the runtime guard for the claim
engine: anything tagged `FACT` with zero evidence throws.

Prompt contracts live in `src/ai/grounding.ts` (`SUMMARY_SYSTEM`,
`EXPAND_SYSTEM`, `REPORT_NARRATIVE_SYSTEM`).

Reports keep the provenance boundary visible: `FACT` · `SOURCE` · `CLAIM` ·
`INFERENCE` · `HYPOTHESIS` · `UNKNOWN`, and human vs AI conclusions are stored
separately (`notes.origin`, §22).

## Cost control (§43)

- `ai_usage` table records provider/model/operation/tokens/estimated-cost per call.
- `BUDGET_MONTHLY_USD`, `BUDGET_LLM_TOKENS_DAY` — 0 means "warn only".
- Strategy: deterministic processing first (dedup, regex extraction, date parsing);
  small model for extraction; large model only for final synthesis; batch
  embeddings; cache AI analyses keyed by evidence-set hash.
