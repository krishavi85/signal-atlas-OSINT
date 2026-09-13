import { loadEnv } from '../env.js';
import { providerFetch } from '../lib/providerFetch.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Embedding provider abstraction (§42) for semantic retrieval (§23).
 *
 * Providers: `ollama` (local, §35), `openai`. When AI_EMBEDDINGS_PROVIDER=none
 * the feature is genuinely unavailable — callers surface that honestly rather
 * than returning lexical results dressed up as semantic (§51).
 */
export interface EmbeddingProvider {
  id: string;
  model: string;
  dim: number | null; // null until first call reveals it
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingStatus {
  available: boolean;
  provider: string;
  model: string | null;
  reason?: string;
  setup?: string;
}

export function embeddingStatus(): EmbeddingStatus {
  const env = loadEnv();
  const provider = env.AI_EMBEDDINGS_PROVIDER;
  if (provider === 'none') {
    return {
      available: false,
      provider,
      model: null,
      reason: 'No embedding provider configured.',
      setup:
        'Set AI_EMBEDDINGS_PROVIDER=ollama (with a local Ollama running AI_EMBEDDINGS_MODEL, e.g. nomic-embed-text) or AI_EMBEDDINGS_PROVIDER=openai (with OPENAI_API_KEY and AI_EMBEDDINGS_MODEL=text-embedding-3-small).',
    };
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    return { available: false, provider, model: env.AI_EMBEDDINGS_MODEL ?? null, reason: 'OPENAI_API_KEY not set.', setup: 'Set OPENAI_API_KEY.' };
  }
  if (!env.AI_EMBEDDINGS_MODEL) {
    return { available: false, provider, model: null, reason: 'AI_EMBEDDINGS_MODEL not set.', setup: 'Set AI_EMBEDDINGS_MODEL.' };
  }
  return { available: true, provider, model: env.AI_EMBEDDINGS_MODEL };
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const status = embeddingStatus();
  if (!status.available) return null;
  const env = loadEnv();
  const model = env.AI_EMBEDDINGS_MODEL!;

  if (env.AI_EMBEDDINGS_PROVIDER === 'ollama') {
    return {
      id: 'ollama',
      model,
      dim: null,
      async embed(texts) {
        const out: number[][] = [];
        for (const input of texts) {
          const res = await providerFetch(`${env.OLLAMA_BASE_URL}/api/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, prompt: input }),
            timeoutMs: 60_000,
          });
          if (!res.ok) throw new Error(`Ollama embeddings HTTP ${res.status}`);
          const json = (await res.json()) as { embedding: number[] };
          out.push(json.embedding);
        }
        return out;
      },
    };
  }

  // openai
  return {
    id: 'openai',
    model,
    dim: null,
    async embed(texts) {
      const res = await providerFetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model, input: texts }),
        timeoutMs: 60_000,
      });
      if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage?: { prompt_tokens: number } };
      if (json.usage) {
        await prisma.aiUsage
          .create({ data: { provider: 'openai', model, operation: 'EMBED', inputTokens: json.usage.prompt_tokens, estimatedCostUsd: (json.usage.prompt_tokens / 1000) * 0.00002 } })
          .catch(() => {});
      }
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

// ── vector math (in-process cosine — no pgvector on SQLite) ──────────────────

export function l2norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s) || 1;
}

export function cosine(a: number[], aNorm: number, b: number[], bNorm: number): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot / (aNorm * bNorm);
}

export function embedText(source: { title?: string | null; excerpt?: string | null; fullText?: string | null }): string {
  return [source.title, source.fullText ?? source.excerpt].filter(Boolean).join('\n\n').slice(0, 8000);
}

export { logger as embLogger };
