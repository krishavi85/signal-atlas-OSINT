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
 * Hacker News connector via the Algolia HN Search API (public, no key).
 * Supports keyword search, date filtering (numericFilters on created_at_i),
 * and pagination. Good for tech/startup/company mentions and discussions.
 */
interface AlgoliaHit {
  objectID: string;
  title: string | null;
  story_title: string | null;
  url: string | null;
  story_url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string;
  created_at_i: number;
  comment_text: string | null;
  story_text: string | null;
  _tags: string[];
}

export class HackerNewsConnector extends BaseConnector {
  constructor() {
    super({
      id: 'hackernews',
      displayName: 'Hacker News (Algolia Search)',
      category: 'news',
      declared: {
        SEARCH_SUPPORTED: true,
        FETCH_SUPPORTED: false,
        POST_SEARCH_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: false,
        MONITORING_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(10, 3, 2),
    });
  }

  protected configGaps(): CapabilityGap[] {
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
    url.searchParams.set('query', params.query);
    url.searchParams.set('tags', params.scope?.tags ?? '(story,comment)');
    url.searchParams.set('hitsPerPage', String(Math.min(params.limit, 100)));
    url.searchParams.set('page', String(params.page ?? 0));

    const numeric: string[] = [];
    if (params.dateAfter) numeric.push(`created_at_i>${Math.floor(Date.parse(params.dateAfter) / 1000)}`);
    if (params.dateBefore) numeric.push(`created_at_i<${Math.floor(Date.parse(params.dateBefore) / 1000)}`);
    if (numeric.length) url.searchParams.set('numericFilters', numeric.join(','));

    const data = await this.getJson<{ hits: AlgoliaHit[]; nbHits: number; nbPages: number; page: number }>(
      ctx,
      url.toString(),
    );

    const hits: RawHit[] = data.hits.map((h) => ({
      externalId: `hn-${h.objectID}`,
      url: h.url ?? h.story_url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      raw: h,
    }));

    return {
      hits,
      totalAvailable: data.nbHits ?? null,
      hasMore: data.page + 1 < data.nbPages,
      notices: [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const h = parsed as AlgoliaHit;
    const isComment = h._tags?.includes('comment');
    const hnItemUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const externalUrl = h.url ?? h.story_url ?? null;
    const primaryUrl = isComment ? hnItemUrl : externalUrl ?? hnItemUrl;
    const base = this.baseNormalized(params.discoveryQuery, primaryUrl);
    const text = h.comment_text ?? h.story_text ?? null;
    return {
      ...base,
      sourcePlatform: 'hackernews',
      title: h.title ?? h.story_title ?? (isComment ? `Comment by ${h.author ?? 'unknown'}` : null),
      author: h.author,
      publishedAt: h.created_at ?? null,
      excerpt: text ? stripHtml(text).slice(0, 500) : null,
      fullText: text ? stripHtml(text) : null,
      language: null,
      rawMetadata: {
        hnId: h.objectID,
        hnItemUrl,
        externalUrl,
        kind: isComment ? 'comment' : 'story',
        points: h.points,
        numComments: h.num_comments,
        tags: h._tags,
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, 'https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1');
    });
    return probe.ok
      ? this.health('ONLINE', probe.latencyMs, 'Algolia HN Search API reachable')
      : this.health('OFFLINE', probe.latencyMs, 'Algolia HN Search API probe failed', probe.error);
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').trim();
}
