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
 * Facebook (Meta Graph API) connector.
 *
 * IMPORTANT (§4, §30, §51): This connector uses ONLY the official Meta Graph
 * API. It does NOT scrape facebook.com, does NOT bypass login or privacy
 * controls, and does NOT access non-public data.
 *
 * What the Graph API actually allows for a third party (as of build):
 *  - Reading a Facebook **Page** you (or your app's user) manage/own:
 *    page metadata, published posts, events — requires a Page access token and
 *    the `pages_read_engagement` / `pages_read_user_content` permissions, which
 *    require Meta App Review.
 *  - There is **no public "search all Facebook posts" endpoint** for third
 *    parties. The old `/search?type=page` endpoint was deprecated. So
 *    SEARCH_SUPPORTED is declared but effectively limited to "look up a Page by
 *    its known id/username", surfaced honestly.
 *
 * Provide META_GRAPH_ACCESS_TOKEN (a Page or user token with the reviewed
 * permissions). Without it the connector is NOT_CONFIGURED.
 */
export class MetaGraphConnector extends BaseConnector {
  private readonly graphVersion = 'v21.0';

  constructor() {
    super({
      id: 'facebook-graph',
      displayName: 'Facebook (Meta Graph API)',
      category: 'social',
      declared: {
        SEARCH_SUPPORTED: true, // limited: Page lookup by id/username
        PUBLIC_PROFILE_SUPPORTED: true,
        POST_SEARCH_SUPPORTED: true, // only for Pages the token can read
        MEDIA_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: false,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(3, 1, 2),
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    const gaps: CapabilityGap[] = [];
    if (!ctx?.config.META_GRAPH_ACCESS_TOKEN) {
      gaps.push({
        capability: 'ALL',
        code: 'MISSING_OAUTH',
        message:
          'Facebook connector is not configured. It requires a Meta Graph API access token (Page or user token) with App-Review-approved permissions. Set META_GRAPH_ACCESS_TOKEN.',
        requiredConfig: ['META_GRAPH_APP_ID', 'META_GRAPH_APP_SECRET', 'META_GRAPH_ACCESS_TOKEN'],
        docs: 'docs/CONNECTORS.md#facebook-meta-graph',
      });
      return gaps;
    }
    // Even configured, be explicit about platform restrictions.
    gaps.push({
      capability: 'HISTORICAL_SEARCH_SUPPORTED',
      code: 'PLATFORM_RESTRICTION',
      message:
        'Meta does not expose a public cross-Facebook post search to third parties. Only Pages readable by this token are available; content is limited to what the approved permissions and the Page owner allow.',
      docs: 'docs/CONNECTORS.md#facebook-meta-graph',
    });
    return gaps;
  }

  private base(path: string, ctx: ConnectorContext): URL {
    const u = new URL(`https://graph.facebook.com/${this.graphVersion}/${path}`);
    u.searchParams.set('access_token', ctx.config.META_GRAPH_ACCESS_TOKEN ?? '');
    return u;
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    if (!ctx.config.META_GRAPH_ACCESS_TOKEN) {
      return {
        hits: [],
        totalAvailable: null,
        hasMore: false,
        notices: ['Facebook connector not configured (META_GRAPH_ACCESS_TOKEN missing). No data returned.'],
      };
    }
    // Interpret the query as a Page id or username (vanity URL slug).
    const pageRef = (params.scope?.pageId ?? params.query).trim().replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/$/, '');
    const notices = [
      'Facebook: treating the query as a Page id/username. Meta does not permit third-party full-text search of Facebook.',
    ];

    try {
      const pageUrl = this.base(encodeURIComponent(pageRef), ctx);
      pageUrl.searchParams.set('fields', 'id,name,username,link,about,description,category,fan_count,verification_status,website,location');
      const page = await this.getJson<any>(ctx, pageUrl.toString());

      const hits: RawHit[] = [{ externalId: `fb-page-${page.id}`, url: page.link ?? `https://www.facebook.com/${page.id}`, raw: { kind: 'page', page } }];

      // Recent posts + events, best-effort (permission dependent).
      for (const edge of ['posts', 'events'] as const) {
        try {
          const eu = this.base(`${page.id}/${edge}`, ctx);
          eu.searchParams.set(
            'fields',
            edge === 'posts'
              ? 'id,message,created_time,permalink_url,full_picture,shares'
              : 'id,name,description,start_time,end_time,place,cover',
          );
          eu.searchParams.set('limit', String(Math.min(params.limit, 25)));
          if (params.dateAfter) eu.searchParams.set('since', String(Math.floor(Date.parse(params.dateAfter) / 1000)));
          if (params.dateBefore) eu.searchParams.set('until', String(Math.floor(Date.parse(params.dateBefore) / 1000)));
          const res = await this.getJson<{ data?: any[] }>(ctx, eu.toString());
          for (const row of res.data ?? []) {
            hits.push({
              externalId: `fb-${edge}-${row.id}`,
              url: row.permalink_url ?? `https://www.facebook.com/${row.id}`,
              raw: { kind: edge === 'posts' ? 'post' : 'event', row, pageName: page.name, pageId: page.id },
            });
          }
        } catch (err) {
          notices.push(`Facebook ${edge}: ${(err as Error).message} (likely a permissions limitation)`);
        }
      }
      return { hits, totalAvailable: null, hasMore: false, notices };
    } catch (err) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: [...notices, `Facebook lookup failed: ${(err as Error).message}`] };
    }
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const p = parsed as any;
    if (p.kind === 'page') {
      const page = p.page;
      const url = page.link ?? `https://www.facebook.com/${page.id}`;
      const base = this.baseNormalized(params.discoveryQuery, url);
      return {
        ...base,
        sourcePlatform: 'facebook',
        title: page.name ?? null,
        author: page.name ?? null,
        publishedAt: null,
        excerpt: page.about ?? page.description ?? null,
        fullText: page.description ?? page.about ?? null,
        rawMetadata: {
          kind: 'page',
          pageId: page.id,
          username: page.username ?? null,
          category: page.category ?? null,
          fanCount: page.fan_count ?? null,
          verification: page.verification_status ?? null,
          website: page.website ?? null,
          location: page.location ?? null,
          provider: 'meta-graph',
        },
      };
    }
    const row = p.row;
    const url = row.permalink_url ?? `https://www.facebook.com/${row.id}`;
    const base = this.baseNormalized(params.discoveryQuery, url);
    if (p.kind === 'event') {
      return {
        ...base,
        sourcePlatform: 'facebook',
        title: row.name ?? null,
        author: p.pageName ?? null,
        publishedAt: row.start_time ?? null,
        excerpt: row.description ?? null,
        fullText: row.description ?? null,
        media: row.cover?.source ? [{ type: 'image', url: row.cover.source }] : [],
        rawMetadata: { kind: 'event', pageId: p.pageId, startTime: row.start_time, endTime: row.end_time, place: row.place ?? null, provider: 'meta-graph' },
      };
    }
    return {
      ...base,
      sourcePlatform: 'facebook',
      title: row.message ? String(row.message).slice(0, 120) : `Post ${row.id}`,
      author: p.pageName ?? null,
      publishedAt: row.created_time ?? null,
      excerpt: row.message ?? null,
      fullText: row.message ?? null,
      media: row.full_picture ? [{ type: 'image', url: row.full_picture }] : [],
      rawMetadata: { kind: 'post', pageId: p.pageId, shares: row.shares?.count ?? null, provider: 'meta-graph' },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (!ctx.config.META_GRAPH_ACCESS_TOKEN) {
      return this.health('NOT_CONFIGURED', null, 'META_GRAPH_ACCESS_TOKEN not set. Facebook connector inert (no scraping fallback by design).');
    }
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, this.base('me', ctx).toString());
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'Meta Graph token valid');
    if (probe.error?.includes('190') || probe.error?.includes('401')) {
      return this.health('AUTH_REQUIRED', probe.latencyMs, 'Meta Graph token invalid or expired', probe.error);
    }
    return this.health('DEGRADED', probe.latencyMs, 'Meta Graph reachable but probe errored', probe.error);
  }
}
