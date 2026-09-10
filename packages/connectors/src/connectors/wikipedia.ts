import type { NormalizedResult } from '@osint/core';
import { BaseConnector } from '../sdk/base.js';
import { TokenBucketLimiter } from '../sdk/rate-limit.js';
import type { CapabilityGap } from '../sdk/capabilities.js';
import type {
  ConnectorContext,
  ConnectorHealth,
  FetchParams,
  RawDocument,
  RawHit,
  SearchOutcome,
  SearchParams,
} from '../sdk/types.js';
import { normalizeDate } from '../lib/markup.js';

/**
 * Wikipedia connector — MediaWiki Action API (opensearch + query/extracts) and
 * the REST summary endpoint. No key required. Public, documented, rate-limit
 * friendly. Configurable language edition via scope.lang or params.language.
 */
export class WikipediaConnector extends BaseConnector {
  constructor() {
    super({
      id: 'wikipedia',
      displayName: 'Wikipedia',
      category: 'reference',
      declared: {
        SEARCH_SUPPORTED: true,
        FETCH_SUPPORTED: true,
        PUBLIC_PROFILE_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: false,
        MEDIA_SUPPORTED: true,
        LANGUAGE_FILTER_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: false,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      // Wikimedia asks for <= 200 req/s with a UA; we stay far below.
      limiter: new TokenBucketLimiter(10, 5, 2),
    });
  }

  protected configGaps(): CapabilityGap[] {
    return []; // never needs configuration
  }

  private apiBase(lang: string | null | undefined): string {
    const l = (lang || 'en').replace(/[^a-z-]/gi, '').slice(0, 12) || 'en';
    return `https://${l}.wikipedia.org`;
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const notices: string[] = [];
    if (params.dateAfter || params.dateBefore) notices.push('Wikipedia search does not support date filtering; filter applied post-hoc on page timestamps.');

    const base = this.apiBase(params.language ?? params.scope?.lang);
    const url = new URL(`${base}/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', params.query);
    url.searchParams.set('srlimit', String(Math.min(params.limit, 50)));
    url.searchParams.set('srprop', 'snippet|timestamp');
    url.searchParams.set('sroffset', String((params.page ?? 0) * Math.min(params.limit, 50)));

    const data = await this.getJson<{
      query?: { search?: Array<{ pageid: number; title: string; snippet: string; timestamp: string }>; searchinfo?: { totalhits?: number } };
      continue?: unknown;
    }>(ctx, url.toString());

    const hits: RawHit[] = (data.query?.search ?? []).map((s) => ({
      externalId: `${base}#${s.pageid}`,
      url: `${base}/?curid=${s.pageid}`,
      raw: { ...s, base },
    }));

    return {
      hits,
      totalAvailable: data.query?.searchinfo?.totalhits ?? null,
      hasMore: Boolean(data.continue),
      notices,
    };
  }

  override async fetch(params: FetchParams, ctx: ConnectorContext): Promise<RawDocument> {
    const res = await this.getText(ctx, params.url);
    return {
      url: params.url,
      status: res.status,
      contentType: res.contentType,
      body: res.body,
      headers: res.headers,
      fetchedAt: new Date().toISOString(),
    };
  }

  override async parse(input: RawHit | RawDocument, ctx: ConnectorContext): Promise<unknown> {
    if (!('raw' in input)) return input;
    const raw = input.raw as { pageid: number; title: string; snippet: string; timestamp: string; base: string };
    // Enrich with REST summary for a clean extract + canonical URL + thumbnail.
    const summaryUrl = `${raw.base}/api/rest_v1/page/summary/${encodeURIComponent(raw.title.replace(/ /g, '_'))}`;
    let summary: Record<string, unknown> = {};
    try {
      summary = await this.getJson<Record<string, unknown>>(ctx, summaryUrl);
    } catch (err) {
      ctx.log('debug', `wikipedia summary fetch failed for ${raw.title}: ${(err as Error).message}`);
    }
    return { ...raw, summary };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const p = parsed as {
      pageid?: number;
      title: string;
      snippet?: string;
      timestamp?: string;
      base: string;
      summary?: Record<string, any>;
    };
    const s = p.summary ?? {};
    const url: string =
      s.content_urls?.desktop?.page ?? `${p.base}/wiki/${encodeURIComponent((p.title ?? '').replace(/ /g, '_'))}`;
    const base = this.baseNormalized(params.discoveryQuery, url);
    return {
      ...base,
      sourcePlatform: 'wikipedia',
      title: s.title ?? p.title ?? null,
      author: null,
      publishedAt: normalizeDate(p.timestamp ?? null),
      excerpt: (s.extract as string | undefined) ?? stripWikiSnippet(p.snippet ?? '') ?? null,
      fullText: (s.extract as string | undefined) ?? null,
      language: (s.lang as string | undefined) ?? null,
      media: s.thumbnail?.source ? [{ type: 'image', url: s.thumbnail.source as string }] : [],
      rawMetadata: {
        pageid: p.pageid ?? s.pageid,
        description: s.description ?? null,
        type: s.type ?? null,
        wikibase_item: s.wikibase_item ?? null,
        edition: p.base,
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, 'https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json');
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'MediaWiki API reachable');
    return this.health('OFFLINE', probe.latencyMs, 'MediaWiki API probe failed', probe.error);
  }
}

function stripWikiSnippet(snippet: string): string | null {
  const t = snippet.replace(/<[^>]+>/g, '').trim();
  return t || null;
}
