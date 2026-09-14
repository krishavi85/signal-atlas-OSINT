import { safeFetch } from '../lib/safeFetch.js';
import { logger } from '../logger.js';
import type { LookupAvailability } from '../lib/lookupTypes.js';
import { resolveConnectorConfig } from '../connectors/runtime.js';

/**
 * GitHub code search (§31 Phase 11 dork toolkit) — GitHub's own official
 * REST API, reusing the exact same `GITHUB_TOKEN` resolution the GitHub
 * connector uses (env var or the encrypted per-connector credential vault —
 * `resolveConnectorConfig` checks both, so a token set via either path in
 * the Connectors UI works here too). Unauthenticated code search is heavily
 * restricted (and frequently refused outright), so without a token this is
 * a named capability gap rather than an unreliable best-effort call.
 *
 * `grep.app` was evaluated as the spec's other suggested code-search source
 * and dropped: a live test request to its public-looking search API came
 * back as a Vercel bot-detection challenge page, not results — exactly the
 * anti-bot surface this platform won't try to defeat (§30).
 */

export interface CodeSearchHit {
  repo: string;
  path: string;
  url: string;
}

export async function githubCodeSearch(query: string): Promise<LookupAvailability<CodeSearchHit[]>> {
  const config = await resolveConnectorConfig('github');
  const token = config.GITHUB_TOKEN;
  if (!token) {
    return { available: false, reason: 'GITHUB_TOKEN not configured — code search needs an authenticated request (free personal access token, no scopes required for public code).' };
  }
  try {
    const res = await safeFetch(`https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=10`, {
      timeoutMs: 12_000,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { available: false, reason: body.message ?? `GitHub HTTP ${res.status}` };
    }
    const body = (await res.json()) as { items?: Array<{ repository: { full_name: string }; path: string; html_url: string }> };
    return {
      available: true,
      data: (body.items ?? []).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })),
    };
  } catch (err) {
    logger.warn({ err }, 'GitHub code search failed');
    return { available: false, reason: (err as Error).message };
  }
}
