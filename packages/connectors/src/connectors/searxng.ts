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
 * SearXNG connector — points at a self-hosted SearXNG instance (SEARXNG_BASE_URL).
 * No API key; ideal for the local-first deployment mode (§35). The instance
 * must have the JSON format enabled (`search.formats: [json]` in settings.yml).
 */
interface SearxResult {
  url: string;
  title: string;
  content?: string;
  engine?: string;
  publishedDate?: string | null;
  score?: number;
  category?: string;
}

export class SearxngConnector extends BaseConnector {
  constructor() {
    super({
      id: 'searxng',
      displayName: 'SearXNG (self-hosted metasearch)',
      category: 'web-search',
      declared: {
        SEARCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        LANGUAGE_FILTER_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: true, // passes through to upstream engines
        MONITORING_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(3, 1, 2),
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    if (!ctx?.config.SEARXNG_BASE_URL) {
      return [
        {
          capability: 'ALL',
          code: 'DISABLED_BY_CONFIG',
          message:
            'SearXNG base URL not set. Run a SearXNG instance (docker) with JSON output enabled and set SEARXNG_BASE_URL.',
          requiredConfig: ['SEARXNG_BASE_URL'],
          docs: 'docs/CONNECTORS.md#searxng',
        },
      ];
    }
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const baseUrl = ctx.config.SEARXNG_BASE_URL;
    if (!baseUrl) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: ['SearXNG not configured (SEARXNG_BASE_URL missing).'] };
    }
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', params.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', String((params.page ?? 0) + 1));
    if (params.language) url.searchParams.set('language', params.language);
    const notices: string[] = [];
    if (params.dateAfter || params.dateBefore) {
      // SearXNG supports time_range: day/week/month/year only.
      const spanDays = params.dateAfter
        ? (Date.now() - Date.parse(params.dateAfter)) / 86_400_000
        : Infinity;
      const range = spanDays <= 1 ? 'day' : spanDays <= 7 ? 'week' : spanDays <= 31 ? 'month' : spanDays <= 366 ? 'year' : null;
      if (range) url.searchParams.set('time_range', range);
      else notices.push('Date range wider than 1 year; SearXNG time_range not applied. Filtered post-hoc.');
    }

    const data = await this.getJson<{ results?: SearxResult[]; number_of_results?: number }>(ctx, url.toString());
    let results = data.results ?? [];
    if (params.dateAfter) {
      const after = Date.parse(params.dateAfter);
      results = results.filter((r) => !r.publishedDate || Date.parse(r.publishedDate) >= after);
    }
    const hits: RawHit[] = results.slice(0, params.limit).map((r) => ({ externalId: r.url, url: r.url, raw: r }));
    return { hits, totalAvailable: data.number_of_results ?? null, hasMore: results.length >= params.limit, notices };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const r = parsed as SearxResult;
    const base = this.baseNormalized(params.discoveryQuery, r.url);
    return {
      ...base,
      sourcePlatform: 'web',
      title: r.title ?? null,
      publishedAt: r.publishedDate && !Number.isNaN(Date.parse(r.publishedDate)) ? new Date(Date.parse(r.publishedDate)).toISOString() : null,
      excerpt: r.content ?? null,
      fullText: null,
      rawMetadata: { upstreamEngine: r.engine ?? null, category: r.category ?? null, score: r.score ?? null, provider: 'searxng' },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const baseUrl = ctx.config.SEARXNG_BASE_URL;
    if (!baseUrl) return this.health('NOT_CONFIGURED', null, 'SEARXNG_BASE_URL not set.');
    const probe = await this.timedProbe(async () => {
      const u = new URL('/search', baseUrl);
      u.searchParams.set('q', 'test');
      u.searchParams.set('format', 'json');
      await this.getJson(ctx, u.toString());
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, `SearXNG instance reachable at ${baseUrl}`);
    if (probe.error?.includes('403'))
      return this.health('MISCONFIGURED', probe.latencyMs, 'SearXNG reachable but JSON format is disabled (enable search.formats: [json]).', probe.error);
    return this.health('OFFLINE', probe.latencyMs, 'SearXNG instance not reachable', probe.error);
  }
}
