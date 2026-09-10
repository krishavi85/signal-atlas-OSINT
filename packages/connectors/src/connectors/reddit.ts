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
 * Reddit connector via the official OAuth API (script-app, client-credentials).
 * Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET. Public listings/search only.
 * Reddit requires OAuth even for public reads and a descriptive User-Agent.
 */
export class RedditConnector extends BaseConnector {
  private token: { value: string; expiresAt: number } | null = null;

  constructor() {
    super({
      id: 'reddit',
      displayName: 'Reddit',
      category: 'social',
      declared: {
        SEARCH_SUPPORTED: true,
        POST_SEARCH_SUPPORTED: true,
        PUBLIC_PROFILE_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: false,
        BOOLEAN_QUERY_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(10, 1, 2), // Reddit: 100 req / 10 min for OAuth
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    const missing: string[] = [];
    if (!ctx?.config.REDDIT_CLIENT_ID) missing.push('REDDIT_CLIENT_ID');
    if (!ctx?.config.REDDIT_CLIENT_SECRET) missing.push('REDDIT_CLIENT_SECRET');
    if (missing.length) {
      return [
        {
          capability: 'ALL',
          code: 'MISSING_OAUTH',
          message: `Reddit not configured. Create a "script" app at reddit.com/prefs/apps and set ${missing.join(', ')}.`,
          requiredConfig: missing,
          docs: 'docs/CONNECTORS.md#reddit',
        },
      ];
    }
    return [];
  }

  private async getToken(ctx: ConnectorContext): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const id = ctx.config.REDDIT_CLIENT_ID!;
    const secret = ctx.config.REDDIT_CLIENT_SECRET!;
    await this.limiter.acquire(ctx.signal);
    const res = await ctx.safeFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': ctx.userAgent,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Reddit token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    if (!ctx.config.REDDIT_CLIENT_ID || !ctx.config.REDDIT_CLIENT_SECRET) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: ['Reddit not configured.'] };
    }
    const token = await this.getToken(ctx);
    const sub = params.scope?.subreddit;
    const path = sub ? `/r/${encodeURIComponent(sub)}/search` : '/search';
    const url = new URL(`https://oauth.reddit.com${path}`);
    url.searchParams.set('q', params.query);
    url.searchParams.set('limit', String(Math.min(params.limit, 100)));
    url.searchParams.set('sort', params.scope?.sort ?? 'new');
    url.searchParams.set('type', 'link');
    if (sub) url.searchParams.set('restrict_sr', 'true');
    if (params.scope?.after) url.searchParams.set('after', params.scope.after);

    const data = await this.getJson<{ data?: { children?: Array<{ data: any }>; after?: string | null } }>(
      ctx,
      url.toString(),
      { headers: { authorization: `Bearer ${token}`, 'user-agent': ctx.userAgent } },
    );

    let children = data.data?.children ?? [];
    if (params.dateAfter) {
      const after = Date.parse(params.dateAfter) / 1000;
      children = children.filter((c) => (c.data.created_utc ?? 0) >= after);
    }
    if (params.dateBefore) {
      const before = Date.parse(params.dateBefore) / 1000;
      children = children.filter((c) => (c.data.created_utc ?? Infinity) <= before);
    }

    const hits: RawHit[] = children.map((c) => ({
      externalId: `reddit-${c.data.name}`,
      url: `https://www.reddit.com${c.data.permalink}`,
      raw: c.data,
    }));
    return {
      hits,
      totalAvailable: null,
      hasMore: Boolean(data.data?.after),
      notices: data.data?.after ? [`after=${data.data.after}`] : [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const p = parsed as any;
    const permalink = `https://www.reddit.com${p.permalink}`;
    const base = this.baseNormalized(params.discoveryQuery, permalink);
    return {
      ...base,
      sourcePlatform: 'reddit',
      title: p.title ?? null,
      author: p.author ? `u/${p.author}` : null,
      publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
      excerpt: p.selftext ? String(p.selftext).slice(0, 500) : (p.url ?? null),
      fullText: p.selftext || null,
      language: null,
      media: p.url && /\.(jpg|png|gif|mp4)$/i.test(p.url) ? [{ type: /\.mp4$/i.test(p.url) ? 'video' : 'image', url: p.url }] : [],
      rawMetadata: {
        subreddit: p.subreddit,
        score: p.score,
        numComments: p.num_comments,
        upvoteRatio: p.upvote_ratio,
        externalUrl: p.url ?? null,
        over18: p.over_18 ?? false,
        provider: 'reddit-oauth',
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (!ctx.config.REDDIT_CLIENT_ID || !ctx.config.REDDIT_CLIENT_SECRET) {
      return this.health('NOT_CONFIGURED', null, 'REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set.');
    }
    const probe = await this.timedProbe(async () => {
      const token = await this.getToken(ctx);
      await this.getJson(ctx, 'https://oauth.reddit.com/api/v1/me', {
        headers: { authorization: `Bearer ${token}`, 'user-agent': ctx.userAgent },
      });
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'Reddit OAuth token acquired, API reachable');
    if (probe.error?.includes('401') || probe.error?.includes('403')) {
      return this.health('AUTH_REQUIRED', probe.latencyMs, 'Reddit rejected client credentials', probe.error);
    }
    return this.health('OFFLINE', probe.latencyMs, 'Reddit API probe failed', probe.error);
  }
}
