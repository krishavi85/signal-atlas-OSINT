import { loadEnv } from '../env.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { providerFetch } from '../lib/providerFetch.js';

/**
 * Chat-model abstraction (§42) for the AI research analyst (§13).
 *
 * Providers: `ollama` (local, §35), `anthropic`, `openai`. When AI_PROVIDER=none
 * every AI feature is genuinely unavailable and callers surface that honestly
 * (§51) — nothing is fabricated.
 *
 * Two model roles (§43 cost control): `extract` (small/cheap) and `synth`
 * (large/capable). If only one is set it is used for both.
 */

export type ModelRole = 'extract' | 'synth';

export interface ChatImage {
  mediaType: string; // "image/png" | "image/jpeg" | ...
  dataBase64: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** attach images to a user message (requires a multimodal model) */
  images?: ChatImage[];
}

export interface ChatRequest {
  role: ModelRole;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** ask the provider for strict JSON */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number;
}

export interface ChatStatus {
  available: boolean;
  provider: string;
  models: { extract: string | null; synth: string | null };
  reason?: string;
  setup?: string;
}

// rough public pricing (USD per 1K tokens) — used only for the cost meter
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 0.003, out: 0.015 },
  'claude-haiku-4-5': { in: 0.0008, out: 0.004 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
};
function priceFor(model: string): { in: number; out: number } {
  for (const [k, v] of Object.entries(PRICING)) if (model.includes(k)) return v;
  return { in: 0, out: 0 }; // local models: no marginal cost
}

export function chatStatus(): ChatStatus {
  const env = loadEnv();
  const provider = env.AI_PROVIDER;
  const models = { extract: env.AI_MODEL_EXTRACT ?? env.AI_MODEL_SYNTH ?? null, synth: env.AI_MODEL_SYNTH ?? env.AI_MODEL_EXTRACT ?? null };
  if (provider === 'none') {
    return {
      available: false,
      provider,
      models,
      reason: 'No AI provider configured.',
      setup:
        'Set AI_PROVIDER=ollama (local, with AI_MODEL_SYNTH e.g. llama3.1:8b), or AI_PROVIDER=anthropic (ANTHROPIC_API_KEY + AI_MODEL_SYNTH=claude-sonnet-5), or AI_PROVIDER=openai (OPENAI_API_KEY + AI_MODEL_SYNTH=gpt-4o).',
    };
  }
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY)
    return { available: false, provider, models, reason: 'ANTHROPIC_API_KEY not set.', setup: 'Set ANTHROPIC_API_KEY.' };
  if (provider === 'openai' && !env.OPENAI_API_KEY)
    return { available: false, provider, models, reason: 'OPENAI_API_KEY not set.', setup: 'Set OPENAI_API_KEY.' };
  if (!models.synth) return { available: false, provider, models, reason: 'AI_MODEL_SYNTH (or AI_MODEL_EXTRACT) not set.', setup: 'Set AI_MODEL_SYNTH.' };
  return { available: true, provider, models };
}

// ── budget guard (§43) ──────────────────────────────────────────────────────

export async function assertWithinBudget(): Promise<void> {
  const env = loadEnv();
  if (env.BUDGET_MONTHLY_USD > 0) {
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const agg = await prisma.aiUsage.aggregate({ _sum: { estimatedCostUsd: true }, where: { createdAt: { gte: since } } });
    const spent = agg._sum.estimatedCostUsd ?? 0;
    if (spent >= env.BUDGET_MONTHLY_USD) {
      throw new Error(`Monthly AI budget reached ($${spent.toFixed(2)} / $${env.BUDGET_MONTHLY_USD}). Raise BUDGET_MONTHLY_USD or wait for the next month.`);
    }
  }
  if (env.BUDGET_LLM_TOKENS_DAY > 0) {
    const since = new Date(Date.now() - 86_400_000);
    const agg = await prisma.aiUsage.aggregate({ _sum: { inputTokens: true, outputTokens: true }, where: { createdAt: { gte: since } } });
    const tokens = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
    if (tokens >= env.BUDGET_LLM_TOKENS_DAY) {
      throw new Error(`Daily LLM token budget reached (${tokens} / ${env.BUDGET_LLM_TOKENS_DAY}).`);
    }
  }
}

// ── the call ────────────────────────────────────────────────────────────────

export async function chat(req: ChatRequest, meta: { projectId?: string; operation: string }): Promise<ChatResult> {
  const status = chatStatus();
  if (!status.available) throw new Error(`AI unavailable: ${status.reason} ${status.setup ?? ''}`.trim());
  await assertWithinBudget();

  const env = loadEnv();
  const model = (req.role === 'synth' ? status.models.synth : status.models.extract) ?? status.models.synth!;
  const temperature = req.temperature ?? 0.2;
  const maxTokens = req.maxTokens ?? 2000;

  let result: ChatResult;
  if (env.AI_PROVIDER === 'ollama') result = await callOllama(env.OLLAMA_BASE_URL, model, req, temperature, maxTokens);
  else if (env.AI_PROVIDER === 'anthropic') result = await callAnthropic(env.ANTHROPIC_API_KEY!, model, req, temperature, maxTokens);
  else result = await callOpenAI(env.OPENAI_API_KEY!, model, req, temperature, maxTokens);

  await prisma.aiUsage
    .create({
      data: {
        projectId: meta.projectId ?? null,
        provider: result.provider,
        model: result.model,
        operation: meta.operation,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
      },
    })
    .catch((err) => logger.warn({ err }, 'ai usage record failed'));

  return result;
}

async function callOllama(baseUrl: string, model: string, req: ChatRequest, temperature: number, maxTokens: number): Promise<ChatResult> {
  const res = await providerFetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature, num_predict: maxTokens },
      format: req.json ? 'json' : undefined,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images?.length ? { images: m.images.map((img) => img.dataBase64) } : {}),
        })),
      ],
    }),
    // Unlike the hosted providers below, this is a local, CPU-bound model the
    // operator chose to run themselves — a large evidence-grounded prompt can
    // legitimately take several minutes to generate on CPU. 180s cut off a
    // real (non-hung) request during testing; there's no cost/quota reason to
    // enforce a short deadline against infrastructure the operator controls.
    timeoutMs: 600_000,
  });
  if (!res.ok) throw new Error(`Ollama chat HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { message?: { content: string }; prompt_eval_count?: number; eval_count?: number };
  return {
    text: json.message?.content ?? '',
    model,
    provider: 'ollama',
    usage: { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 },
    estimatedCostUsd: 0,
  };
}

async function callAnthropic(apiKey: string, model: string, req: ChatRequest, temperature: number, maxTokens: number): Promise<ChatResult> {
  const res = await providerFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: req.system + (req.json ? '\n\nRespond with a single valid JSON object and nothing else.' : ''),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [
              ...m.images.map((img) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType, data: img.dataBase64 },
              })),
              { type: 'text' as const, text: m.content },
            ]
          : m.content,
      })),
    }),
    timeoutMs: 180_000,
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content: Array<{ text?: string }>; usage: { input_tokens: number; output_tokens: number } };
  const price = priceFor(model);
  return {
    text: json.content.map((c) => c.text ?? '').join(''),
    model,
    provider: 'anthropic',
    usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
    estimatedCostUsd: (json.usage.input_tokens / 1000) * price.in + (json.usage.output_tokens / 1000) * price.out,
  };
}

async function callOpenAI(apiKey: string, model: string, req: ChatRequest, temperature: number, maxTokens: number): Promise<ChatResult> {
  const res = await providerFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      response_format: req.json ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content: m.images?.length
            ? [
                { type: 'text' as const, text: m.content },
                ...m.images.map((img) => ({
                  type: 'image_url' as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
                })),
              ]
            : m.content,
        })),
      ],
    }),
    timeoutMs: 180_000,
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  const price = priceFor(model);
  return {
    text: json.choices[0]?.message.content ?? '',
    model,
    provider: 'openai',
    usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens },
    estimatedCostUsd: (json.usage.prompt_tokens / 1000) * price.in + (json.usage.completion_tokens / 1000) * price.out,
  };
}

export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}
