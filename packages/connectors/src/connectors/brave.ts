import type { NormalizedResult } from '@osint/core';
import { BaseConnector } from '../sdk/base.js';
import { TokenBucketLimiter } from '../sdk/rate-limit.js';
import type { CapabilityGap } from '../sdk/capabilities.js';
import type {
  ConnectorContext,
  ConnectorHealth,
  RawHit,
  SearchOutcome,
  SearchParams,
} from '../sdk/types.js';

/**
 * Brave Search API connector. Requires BRAVE_SEARCH_API_KEY. Without it the
 * connector reports NOT_CONFIGURED and every capability is effectively off —
 * no fake results (§51).
 */
interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
  language?: string;
  profile?: { name?: string };
  meta_url?: { hostname?: string };
}

export class BraveSearchConnector extends BaseConnector {
  constructor() {
    super({
      id: 'brave-search',
      displayName: 'Brave Search',
      category: 'web-search',
      declared: {
        SEARCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        LANGUAGE_FILTER_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: false,
        MONITORING_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(1, 1, 1), // free tier: ~1 rps
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    const key = ctx?.config.BRAVE_SEARCH_API_KEY;
    if (!key) {
      return [
        {
          capability: 'ALL',
          code: 'MISSING_API_KEY',
          message:
            'Brave Search is not configured. Set BRAVE_SEARCH_API_KEY to enable it. No results are produced until then.',
          requiredConfig: ['BRAVE_SEARCH_API_KEY'],
          docs: 'docs/CONNECTORS.md#brave-search',
        },
      ];
    }
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const key = ctx.config.BRAVE_SEARCH_API_KEY;
    if (!key) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: ['Brave Search not configured (BRAVE_SEARCH_API_KEY missing).'] };
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', params.query);
    url.searchParams.set('count', String(Math.min(params.limit, 20)));
    url.searchParams.set('offset', String(params.page ?? 0));
    if (params.language) url.searchParams.set('search_lang', params.language);
    if (params.dateAfter || params.dateBefore) {
      // Brave freshness: pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD
      const from = params.dateAfter?.slice(0, 10);
      const to = params.dateBefore?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      if (from) url.searchParams.set('freshness', `${from}to${to}`);
    }

    const data = await this.getJson<{ web?: { results?: BraveResult[] }; query?: { more_results_available?: boolean } }>(
      ctx,
      url.toString(),
      { headers: { 'X-Subscription-Token': key, accept: 'application/json' } },
    );

    const results = data.web?.results ?? [];
    const hits: RawHit[] = results.map((r) => ({ externalId: r.url, url: r.url, raw: r }));
    return {
      hits,
      totalAvailable: null,
      hasMore: Boolean(data.query?.more_results_available),
      notices: [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const r = parsed as BraveResult;
    const base = this.baseNormalized(params.discoveryQuery, r.url);
    const ageIso = r.page_age ?? r.age ?? null;
    return {
      ...base,
      sourcePlatform: 'web',
      title: r.title ?? null,
      author: r.profile?.name ?? null,
      publishedAt: ageIso && !Number.isNaN(Date.parse(ageIso)) ? new Date(Date.parse(ageIso)).toISOString() : null,
      excerpt: r.description ? stripTags(r.description) : null,
      fullText: null,
      language: r.language ?? null,
      rawMetadata: { hostname: r.meta_url?.hostname ?? null, ageLabel: r.age ?? null, provider: 'brave' },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (!ctx.config.BRAVE_SEARCH_API_KEY) {
      return this.health('NOT_CONFIGURED', null, 'BRAVE_SEARCH_API_KEY not set.');
    }
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, 'https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
        headers: { 'X-Subscription-Token': ctx.config.BRAVE_SEARCH_API_KEY!, accept: 'application/json' },
      });
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'Brave Search API authenticated and reachable');
    if (probe.error?.includes('401') || probe.error?.includes('403')) {
      return this.health('AUTH_REQUIRED', probe.latencyMs, 'Brave Search rejected the API key', probe.error);
    }
    if (probe.error?.includes('429')) {
      return this.health('RATE_LIMITED', probe.latencyMs, 'Brave Search rate limit hit', probe.error);
    }
    return this.health('OFFLINE', probe.latencyMs, 'Brave Search probe failed', probe.error);
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}
