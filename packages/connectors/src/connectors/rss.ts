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
import { parseFeed, stripTags, type FeedItem } from '../lib/markup.js';

/**
 * RSS / Atom connector.
 *
 * `search()` requires one or more feed URLs supplied via `scope.feeds`
 * (comma-separated) or a single `scope.feed`. It fetches each feed, then
 * filters items by the query terms (case-insensitive substring over
 * title + description + content) and by the date range. If no query is given
 * it returns the latest items. This is genuine retrieval — nothing synthetic.
 *
 * For "news search" the orchestrator can point this at aggregator feeds
 * (e.g. Google News RSS, a publication's feed) configured per project.
 */
export class RssConnector extends BaseConnector {
  constructor() {
    super({
      id: 'rss',
      displayName: 'RSS / Atom feeds',
      category: 'news',
      declared: {
        SEARCH_SUPPORTED: true,
        FETCH_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: false,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(8, 2, 3),
    });
  }

  protected configGaps(): CapabilityGap[] {
    return [];
  }

  private feedsFrom(params: SearchParams): string[] {
    const raw = params.scope?.feeds ?? params.scope?.feed ?? '';
    return raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const feeds = this.feedsFrom(params);
    if (feeds.length === 0) {
      return {
        hits: [],
        totalAvailable: 0,
        hasMore: false,
        notices: [
          'No feed URL supplied. Provide scope.feeds (comma-separated feed URLs) — this connector does not crawl for feeds.',
        ],
      };
    }

    const terms = params.query
      .toLowerCase()
      .replace(/["()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !['and', 'or', 'not'].includes(t));
    const after = params.dateAfter ? Date.parse(params.dateAfter) : null;
    const before = params.dateBefore ? Date.parse(params.dateBefore) : null;

    const hits: RawHit[] = [];
    const notices: string[] = [];

    for (const feedUrl of feeds) {
      try {
        const res = await this.getText(ctx, feedUrl);
        if (res.status >= 400) {
          notices.push(`Feed ${feedUrl} returned HTTP ${res.status}`);
          continue;
        }
        const feed = parseFeed(res.body);
        for (const item of feed.items) {
          const haystack = `${item.title ?? ''} ${item.description ?? ''} ${item.content ?? ''}`.toLowerCase();
          const matches = terms.length === 0 || terms.every((t) => haystack.includes(t));
          if (!matches) continue;
          const ts = item.publishedAt ? Date.parse(item.publishedAt) : null;
          if (after && ts && ts < after) continue;
          if (before && ts && ts > before) continue;
          hits.push({
            externalId: item.guid ?? item.link ?? `${feedUrl}#${hits.length}`,
            url: item.link,
            raw: { item, feedTitle: feed.feedTitle, feedUrl },
          });
          if (hits.length >= params.limit) break;
        }
      } catch (err) {
        notices.push(`Feed ${feedUrl} failed: ${(err as Error).message}`);
      }
      if (hits.length >= params.limit) break;
    }

    return { hits, totalAvailable: hits.length, hasMore: false, notices };
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

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const p = parsed as { item: FeedItem; feedTitle: string | null; feedUrl: string };
    const item = p.item;
    const bodyHtml = item.content ?? item.description ?? '';
    const text = bodyHtml ? stripTags(bodyHtml) : null;
    const base = this.baseNormalized(params.discoveryQuery, item.link ?? null);
    return {
      ...base,
      sourcePlatform: 'rss',
      title: item.title,
      author: item.author,
      publishedAt: item.publishedAt,
      excerpt: text ? text.slice(0, 500) : null,
      fullText: text,
      language: null,
      rawMetadata: {
        feedTitle: p.feedTitle,
        feedUrl: p.feedUrl,
        guid: item.guid,
      },
    };
  }

  async healthCheck(): Promise<ConnectorHealth> {
    // No fixed endpoint — the connector is only as healthy as the feeds given.
    return this.health(
      'ONLINE',
      null,
      'RSS connector ready. Health per-feed is reported at search time.',
    );
  }
}
