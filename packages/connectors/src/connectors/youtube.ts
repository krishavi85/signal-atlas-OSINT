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
 * YouTube Data API v3 connector. Requires YOUTUBE_DATA_API_KEY.
 * Public data only: video search, channel/video metadata, public stats.
 * Quota: 10,000 units/day; search.list costs 100 units.
 */
export class YouTubeConnector extends BaseConnector {
  constructor() {
    super({
      id: 'youtube',
      displayName: 'YouTube',
      category: 'social',
      declared: {
        SEARCH_SUPPORTED: true,
        PUBLIC_PROFILE_SUPPORTED: true,
        POST_SEARCH_SUPPORTED: true,
        MEDIA_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        LANGUAGE_FILTER_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: true,
      },
      limiter: new TokenBucketLimiter(2, 0.5, 2),
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    if (!ctx?.config.YOUTUBE_DATA_API_KEY) {
      return [
        {
          capability: 'ALL',
          code: 'MISSING_API_KEY',
          message: 'YouTube Data API not configured. Set YOUTUBE_DATA_API_KEY (Google Cloud → YouTube Data API v3).',
          requiredConfig: ['YOUTUBE_DATA_API_KEY'],
          docs: 'docs/CONNECTORS.md#youtube',
        },
      ];
    }
    return [];
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const key = ctx.config.YOUTUBE_DATA_API_KEY;
    if (!key) return { hits: [], totalAvailable: null, hasMore: false, notices: ['YouTube not configured.'] };

    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('key', key);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('q', params.query);
    url.searchParams.set('type', params.scope?.type ?? 'video');
    url.searchParams.set('maxResults', String(Math.min(params.limit, 50)));
    if (params.page && params.scope?.pageToken) url.searchParams.set('pageToken', params.scope.pageToken);
    if (params.dateAfter) url.searchParams.set('publishedAfter', new Date(params.dateAfter).toISOString());
    if (params.dateBefore) url.searchParams.set('publishedBefore', new Date(params.dateBefore).toISOString());
    if (params.language) url.searchParams.set('relevanceLanguage', params.language);

    const data = await this.getJson<{
      items?: any[];
      nextPageToken?: string;
      pageInfo?: { totalResults?: number };
    }>(ctx, url.toString());

    const hits: RawHit[] = (data.items ?? []).map((it) => {
      const id = it.id?.videoId ?? it.id?.channelId ?? it.id?.playlistId ?? JSON.stringify(it.id);
      const link = it.id?.videoId
        ? `https://www.youtube.com/watch?v=${it.id.videoId}`
        : it.id?.channelId
          ? `https://www.youtube.com/channel/${it.id.channelId}`
          : null;
      return { externalId: `yt-${id}`, url: link, raw: it };
    });

    return {
      hits,
      totalAvailable: data.pageInfo?.totalResults ?? null,
      hasMore: Boolean(data.nextPageToken),
      notices: data.nextPageToken ? [`nextPageToken=${data.nextPageToken}`] : [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const it = parsed as any;
    const sn = it.snippet ?? {};
    const videoId = it.id?.videoId;
    const url = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : it.id?.channelId
        ? `https://www.youtube.com/channel/${it.id.channelId}`
        : null;
    const base = this.baseNormalized(params.discoveryQuery, url);
    const thumb = sn.thumbnails?.high?.url ?? sn.thumbnails?.default?.url;
    return {
      ...base,
      sourcePlatform: 'youtube',
      title: sn.title ?? null,
      author: sn.channelTitle ?? null,
      publishedAt: sn.publishedAt ?? null,
      excerpt: sn.description ?? null,
      fullText: sn.description ?? null,
      language: null,
      media: [
        ...(videoId ? [{ type: 'video' as const, url: `https://www.youtube.com/watch?v=${videoId}` }] : []),
        ...(thumb ? [{ type: 'image' as const, url: thumb }] : []),
      ],
      rawMetadata: {
        kind: it.id?.kind ?? null,
        channelId: sn.channelId ?? null,
        channelTitle: sn.channelTitle ?? null,
        liveBroadcastContent: sn.liveBroadcastContent ?? null,
        provider: 'youtube-data-v3',
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (!ctx.config.YOUTUBE_DATA_API_KEY) return this.health('NOT_CONFIGURED', null, 'YOUTUBE_DATA_API_KEY not set.');
    const probe = await this.timedProbe(async () => {
      await this.getJson(
        ctx,
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1&type=video&key=${ctx.config.YOUTUBE_DATA_API_KEY}`,
      );
    });
    if (probe.ok) return this.health('ONLINE', probe.latencyMs, 'YouTube Data API authenticated and reachable');
    if (probe.error?.includes('403')) return this.health('AUTH_REQUIRED', probe.latencyMs, 'YouTube API key rejected or quota exceeded', probe.error);
    return this.health('OFFLINE', probe.latencyMs, 'YouTube API probe failed', probe.error);
  }
}
