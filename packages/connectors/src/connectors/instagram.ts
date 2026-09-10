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
 * Instagram connector — official Instagram Graph API only (§4, §30, §51).
 *
 * Third-party access reality:
 *  - The **Instagram Graph API** works only for Instagram **Business/Creator**
 *    accounts connected to a Facebook Page, via a token your app's user grants.
 *  - `business_discovery` lets you read **public** profile + recent media of
 *    *another* business/creator account **by username** (follower count, media
 *    count, recent posts, captions, like/comment counts). This is the one
 *    genuinely useful public-research capability and it is what this connector
 *    exposes.
 *  - There is **no** endpoint to search all of Instagram, read personal
 *    accounts, or read private content. Hashtag search is limited and
 *    quota-heavy; not enabled here by default.
 *
 * Requires INSTAGRAM_GRAPH_ACCESS_TOKEN and the IG Business user id
 * (scope.igUserId or INSTAGRAM_BUSINESS_USER_ID). Without them: NOT_CONFIGURED.
 */
export class InstagramGraphConnector extends BaseConnector {
  private readonly graphVersion = 'v21.0';

  constructor() {
    super({
      id: 'instagram-graph',
      displayName: 'Instagram (Graph API — business_discovery)',
      category: 'social',
      declared: {
        SEARCH_SUPPORTED: true, // by-username public business/creator lookup
        PUBLIC_PROFILE_SUPPORTED: true,
        POST_SEARCH_SUPPORTED: true, // recent media of a discovered account
        MEDIA_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: false,
        DATE_FILTER_SUPPORTED: false,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(2, 0.5, 1),
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    const missing: string[] = [];
    if (!ctx?.config.INSTAGRAM_GRAPH_ACCESS_TOKEN) missing.push('INSTAGRAM_GRAPH_ACCESS_TOKEN');
    if (!ctx?.config.INSTAGRAM_BUSINESS_USER_ID && !ctx?.config.META_GRAPH_ACCESS_TOKEN) {
      missing.push('INSTAGRAM_BUSINESS_USER_ID');
    }
    if (missing.length) {
      return [
        {
          capability: 'ALL',
          code: 'REQUIRES_APP_REVIEW',
          message:
            'Instagram connector is not configured. The Instagram Graph API requires a Business/Creator account, a connected Facebook Page, a granted access token, and (for business_discovery) instagram_basic + instagram_manage_insights permissions via Meta App Review. Set INSTAGRAM_GRAPH_ACCESS_TOKEN and INSTAGRAM_BUSINESS_USER_ID.',
          requiredConfig: missing,
          docs: 'docs/CONNECTORS.md#instagram-graph',
        },
      ];
    }
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const token = ctx.config.INSTAGRAM_GRAPH_ACCESS_TOKEN;
    const igUserId = params.scope?.igUserId ?? ctx.config.INSTAGRAM_BUSINESS_USER_ID;
    if (!token || !igUserId) {
      return {
        hits: [],
        totalAvailable: null,
        hasMore: false,
        notices: ['Instagram connector not configured (token / business user id missing). No data returned.'],
      };
    }
    const username = params.query.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, '');
    const url = new URL(`https://graph.facebook.com/${this.graphVersion}/${igUserId}`);
    url.searchParams.set('access_token', token);
    url.searchParams.set(
      'fields',
      `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(${Math.min(params.limit, 25)}){id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count}}`,
    );

    try {
      const data = await this.getJson<any>(ctx, url.toString());
      const bd = data.business_discovery;
      if (!bd) {
        return { hits: [], totalAvailable: null, hasMore: false, notices: [`No public business/creator account found for "@${username}".`] };
      }
      const hits: RawHit[] = [
        { externalId: `ig-profile-${bd.username}`, url: `https://www.instagram.com/${bd.username}/`, raw: { kind: 'profile', bd } },
      ];
      for (const m of bd.media?.data ?? []) {
        hits.push({ externalId: `ig-media-${m.id}`, url: m.permalink, raw: { kind: 'media', m, username: bd.username } });
      }
      return { hits, totalAvailable: bd.media_count ?? null, hasMore: Boolean(bd.media?.paging?.next), notices: [] };
    } catch (err) {
      return { hits: [], totalAvailable: null, hasMore: false, notices: [`Instagram business_discovery failed: ${(err as Error).message}`] };
    }
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const p = parsed as any;
    if (p.kind === 'profile') {
      const bd = p.bd;
      const url = `https://www.instagram.com/${bd.username}/`;
      const base = this.baseNormalized(params.discoveryQuery, url);
      return {
        ...base,
        sourcePlatform: 'instagram',
        title: bd.name ?? bd.username,
        author: `@${bd.username}`,
        publishedAt: null,
        excerpt: bd.biography ?? null,
        fullText: bd.biography ?? null,
        media: bd.profile_picture_url ? [{ type: 'image', url: bd.profile_picture_url }] : [],
        rawMetadata: {
          kind: 'profile',
          username: bd.username,
          followers: bd.followers_count ?? null,
          following: bd.follows_count ?? null,
          mediaCount: bd.media_count ?? null,
          website: bd.website ?? null,
          provider: 'instagram-graph-business-discovery',
        },
      };
    }
    const m = p.m;
    const base = this.baseNormalized(params.discoveryQuery, m.permalink);
    return {
      ...base,
      sourcePlatform: 'instagram',
      title: m.caption ? String(m.caption).slice(0, 120) : `${m.media_type} ${m.id}`,
      author: `@${p.username}`,
      publishedAt: m.timestamp ?? null,
      excerpt: m.caption ?? null,
      fullText: m.caption ?? null,
      media: m.media_url ? [{ type: m.media_type === 'VIDEO' ? 'video' : 'image', url: m.media_url }] : [],
      rawMetadata: {
        kind: 'media',
        mediaType: m.media_type,
        likeCount: m.like_count ?? null,
        commentsCount: m.comments_count ?? null,
        provider: 'instagram-graph-business-discovery',
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const token = ctx.config.INSTAGRAM_GRAPH_ACCESS_TOKEN;
    const igUserId = ctx.config.INSTAGRAM_BUSINESS_USER_ID;
    if (!token || !igUserId) {
      return this.health('NOT_CONFIGURED', null, 'INSTAGRAM_GRAPH_ACCESS_TOKEN / INSTAGRAM_BUSINESS_USER_ID not set. Connector inert (no scraping fallback by design).');
    }
    const probe = await this.timedProbe(async () => {
      await this.getJson(
        ctx,
        `https://graph.facebook.com/${this.graphVersion}/${igUserId}?fields=id,username&access_token=${token}`,
      );
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'Instagram Graph token valid');
    if (probe.error?.includes('190') || probe.error?.includes('401')) {
      return this.health('AUTH_REQUIRED', probe.latencyMs, 'Instagram Graph token invalid or expired', probe.error);
    }
    return this.health('DEGRADED', probe.latencyMs, 'Instagram Graph reachable but probe errored', probe.error);
  }
}
