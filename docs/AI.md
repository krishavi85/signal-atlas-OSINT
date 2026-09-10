# AI layer (§13, §14, §42, §43)

## Status

The AI **provider abstraction** and the **anti-hallucination contract** are
designed and partially wired. Concrete synthesis features (evidence-grounded
summarisation, AI query expansion, report generation, semantic search) are
**not implemented yet** — see `ROADMAP.md` Phase 5. With `AI_PROVIDER=none`
(the default in this deployment) the platform runs entirely on **deterministic
heuristic extractors** and never calls a third-party model.

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

## Anti-hallucination contract (§14)

Every AI call that produces factual output MUST:

1. receive the candidate evidence as numbered context blocks;
2. return, for each statement, the evidence ids it is grounded in;
3. be passed through a **citation validator** that rejects any factual sentence
   with no evidence reference — such sentences are dropped or re-labelled
   `Unverified` / `Insufficient evidence` / `Not found in the searched sources`.

`assertFactHasEvidence()` (`packages/core`) is the runtime guard: anything tagged
`FACT` with zero evidence throws.

Reports keep the provenance boundary visible: `FACT` · `SOURCE` · `CLAIM` ·
`INFERENCE` · `HYPOTHESIS` · `UNKNOWN`, and human vs AI conclusions are stored
separately (`notes.origin`, §22).

## Cost control (§43)

- `ai_usage` table records provider/model/operation/tokens/estimated-cost per call.
- `BUDGET_MONTHLY_USD`, `BUDGET_LLM_TOKENS_DAY` — 0 means "warn only".
- Strategy: deterministic processing first (dedup, regex extraction, date parsing);
  small model for extraction; large model only for final synthesis; batch
  embeddings; cache AI analyses keyed by evidence-set hash.
