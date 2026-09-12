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
 * Google Programmable Search Engine (Custom Search JSON API).
 * Requires GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX. Free quota: 100 queries/day.
 * This uses the official API only — it does not scrape google.com.
 */
interface CseItem {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
  pagemap?: { metatags?: Array<Record<string, string>> };
}

export class GoogleCseConnector extends BaseConnector {
  constructor() {
    super({
      id: 'google-cse',
      displayName: 'Google Programmable Search',
      category: 'web-search',
      declared: {
        SEARCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        LANGUAGE_FILTER_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(1, 0.2, 1), // conservative vs 100/day
      dailyBudget: 100, // Google CSE's documented free-tier cap (§38)
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    const missing: string[] = [];
    if (!ctx?.config.GOOGLE_CSE_API_KEY) missing.push('GOOGLE_CSE_API_KEY');
    if (!ctx?.config.GOOGLE_CSE_CX) missing.push('GOOGLE_CSE_CX');
    if (missing.length) {
      return [
        {
          capability: 'ALL',
          code: 'MISSING_API_KEY',
          message: `Google Programmable Search not configured. Missing: ${missing.join(', ')}. Create an engine at programmablesearchengine.google.com and an API key in Google Cloud.`,
          requiredConfig: missing,
          docs: 'docs/CONNECTORS.md#google-cse',
        },
      ];
    }
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const key = ctx.config.GOOGLE_CSE_API_KEY;
    const cx = ctx.config.GOOGLE_CSE_CX;
    if (!key || !cx) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: ['Google CSE not configured.'] };
    }
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', key);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', params.query);
    url.searchParams.set('num', String(Math.min(params.limit, 10)));
    url.searchParams.set('start', String((params.page ?? 0) * 10 + 1));
    if (params.language) url.searchParams.set('lr', `lang_${params.language}`);
    if (params.dateAfter || params.dateBefore) {
      const a = params.dateAfter?.slice(0, 10).replace(/-/g, '');
      const b = (params.dateBefore ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');
      if (a) url.searchParams.set('sort', `date:r:${a}:${b}`);
    }

    const data = await this.getJson<{
      items?: CseItem[];
      queries?: { nextPage?: unknown[] };
      searchInformation?: { totalResults?: string };
    }>(ctx, url.toString());

    const hits: RawHit[] = (data.items ?? []).map((i) => ({ externalId: i.link, url: i.link, raw: i }));
    return {
      hits,
      totalAvailable: data.searchInformation?.totalResults ? Number(data.searchInformation.totalResults) : null,
      hasMore: Boolean(data.queries?.nextPage),
      notices: [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const i = parsed as CseItem;
    const meta = i.pagemap?.metatags?.[0] ?? {};
    const base = this.baseNormalized(params.discoveryQuery, i.link);
    const published = meta['article:published_time'] ?? meta['og:updated_time'] ?? null;
    return {
      ...base,
      sourcePlatform: 'web',
      title: i.title ?? meta['og:title'] ?? null,
      author: meta['author'] ?? null,
      publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(Date.parse(published)).toISOString() : null,
      excerpt: i.snippet ?? meta['og:description'] ?? null,
      fullText: null,
      language: null,
      rawMetadata: { displayLink: i.displayLink, provider: 'google-cse' },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (!ctx.config.GOOGLE_CSE_API_KEY || !ctx.config.GOOGLE_CSE_CX) {
      return this.health('NOT_CONFIGURED', null, 'GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX not set.');
    }
    const probe = await this.timedProbe(async () => {
      const u = new URL('https://www.googleapis.com/customsearch/v1');
      u.searchParams.set('key', ctx.config.GOOGLE_CSE_API_KEY!);
      u.searchParams.set('cx', ctx.config.GOOGLE_CSE_CX!);
      u.searchParams.set('q', 'test');
      u.searchParams.set('num', '1');
      // A liveness probe is administrative overhead, not investigative use —
      // it must not compete with real searches for the scarce daily quota.
      await this.getJson(ctx, u.toString(), {}, 2, undefined, false);
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'Google CSE authenticated and reachable');
    if (probe.error?.includes('Daily budget')) return this.health('RATE_LIMITED', probe.latencyMs, `Local daily budget (${this.dailyBudget}) exhausted — protecting your quota, not a provider error`, probe.error);
    if (probe.error?.includes('403')) return this.health('AUTH_REQUIRED', probe.latencyMs, 'Google CSE rejected key or quota exceeded', probe.error);
    if (probe.error?.includes('429')) return this.health('RATE_LIMITED', probe.latencyMs, 'Google CSE daily quota exhausted', probe.error);
    return this.health('OFFLINE', probe.latencyMs, 'Google CSE probe failed', probe.error);
  }
}
