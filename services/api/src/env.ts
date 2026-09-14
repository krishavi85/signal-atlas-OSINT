import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load .env (Node >=20.6 has process.loadEnvFile). Explicit env vars win.
for (const file of ['.env', '../../.env']) {
  if (existsSync(file)) {
    try {
      (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile?.(file);
    } catch {
      /* ignore */
    }
    break;
  }
}

/**
 * Validated environment. Missing optional keys are fine — the relevant
 * connector/provider degrades to an honest "not configured" state.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  // No AUTH_JWT_SECRET / TTLs — single-user local-first has no login, so
  // there are no tokens to sign (see auth/plugin.ts, auth/localUser.ts).
  CREDENTIAL_ENC_KEY: z.string().min(32, 'CREDENTIAL_ENC_KEY must be >= 32 chars (base64url of 32 bytes)'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),

  JOB_DRIVER: z.enum(['inprocess', 'redis']).default('inprocess'),
  REDIS_URL: z.string().optional(),

  HTTP_USER_AGENT: z.string().default('osint-platform/0.1 (+research use)'),
  HTTP_CONTACT_EMAIL: z.string().optional(),

  AI_PROVIDER: z.enum(['none', 'ollama', 'anthropic', 'openai']).default('none'),
  AI_MODEL_EXTRACT: z.string().optional(),
  AI_MODEL_SYNTH: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AI_EMBEDDINGS_PROVIDER: z.enum(['none', 'ollama', 'openai']).default('none'),
  AI_EMBEDDINGS_MODEL: z.string().optional(),

  BUDGET_MONTHLY_USD: z.coerce.number().nonnegative().default(0),
  BUDGET_LLM_TOKENS_DAY: z.coerce.number().nonnegative().default(0),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** raw process.env passthrough for connector-specific keys */
  raw: NodeJS.ProcessEnv;
};

let cached: Env | null = null;

/**
 * `.env.example` ships every optional key as `KEY=` (empty) so operators can
 * see what exists to fill in. An empty string is not `undefined` though, so
 * left as-is it silently defeats every `env.X ?? fallback` in the codebase
 * (a real bug this surfaced: AI_MODEL_EXTRACT="" made the extract role
 * resolve to an empty model string instead of falling back to
 * AI_MODEL_SYNTH). Treat blank values as unset everywhere, including in
 * `raw` so connector config reads the same way.
 */
function withEmptyAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (out[key] === '') delete out[key];
  }
  return out;
}

export function loadEnv(): Env {
  if (cached) return cached;
  const cleaned = withEmptyAsUnset(process.env);
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  cached = { ...parsed.data, raw: cleaned };
  return cached;
}

/** Connector credential keys we know how to pull from process.env by default. */
export const KNOWN_CONNECTOR_ENV_KEYS = [
  'GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_CX', 'BING_SEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY',
  'SERPAPI_KEY', 'SEARXNG_BASE_URL', 'META_GRAPH_APP_ID', 'META_GRAPH_APP_SECRET',
  'META_GRAPH_ACCESS_TOKEN', 'INSTAGRAM_GRAPH_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_USER_ID',
  'YOUTUBE_DATA_API_KEY', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'GITHUB_TOKEN',
] as const;
