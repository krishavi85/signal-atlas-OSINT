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
 * GitHub connector via the public REST API. Works anonymously (60 req/h);
 * GITHUB_TOKEN raises the limit to 5000 req/h and is strongly recommended.
 * Searches repositories and users (public data only).
 */
export class GitHubConnector extends BaseConnector {
  constructor() {
    super({
      id: 'github',
      displayName: 'GitHub',
      category: 'code',
      declared: {
        SEARCH_SUPPORTED: true,
        PUBLIC_PROFILE_SUPPORTED: true,
        FETCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(5, 0.4, 2),
    });
  }

  protected configGaps(ctx: ConnectorContext | null): CapabilityGap[] {
    if (!ctx?.config.GITHUB_TOKEN) {
      return [
        {
          capability: 'RATE_LIMITED',
          code: 'DISABLED_BY_CONFIG',
          message:
            'Running unauthenticated (60 requests/hour). Set GITHUB_TOKEN for 5000/hour and more reliable search.',
          requiredConfig: ['GITHUB_TOKEN'],
          docs: 'docs/CONNECTORS.md#github',
        },
      ];
    }
    return [];
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': ctx.userAgent,
    };
    if (ctx.config.GITHUB_TOKEN) h.authorization = `Bearer ${ctx.config.GITHUB_TOKEN}`;
    return h;
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const target = params.scope?.type === 'users' ? 'users' : 'repositories';
    let q = params.query;
    if (params.dateAfter && target === 'repositories') q += ` pushed:>=${params.dateAfter.slice(0, 10)}`;
    const url = new URL(`https://api.github.com/search/${target}`);
    url.searchParams.set('q', q);
    url.searchParams.set('per_page', String(Math.min(params.limit, 50)));
    url.searchParams.set('page', String((params.page ?? 0) + 1));

    const data = await this.getJson<{ total_count: number; incomplete_results: boolean; items: any[] }>(
      ctx,
      url.toString(),
      { headers: this.headers(ctx) },
    );
    const hits: RawHit[] = (data.items ?? []).map((it) => ({
      externalId: `github-${target}-${it.id}`,
      url: it.html_url,
      raw: { ...it, __target: target },
    }));
    return {
      hits,
      totalAvailable: data.total_count ?? null,
      hasMore: (data.items?.length ?? 0) >= Math.min(params.limit, 50),
      notices: data.incomplete_results ? ['GitHub returned incomplete results (search timed out server-side).'] : [],
    };
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const it = parsed as any;
    const base = this.baseNormalized(params.discoveryQuery, it.html_url);
    if (it.__target === 'users') {
      return {
        ...base,
        sourcePlatform: 'github',
        title: it.login,
        author: it.login,
        publishedAt: null,
        excerpt: `GitHub ${it.type} profile: ${it.login}`,
        fullText: null,
        media: it.avatar_url ? [{ type: 'image', url: it.avatar_url }] : [],
        rawMetadata: { kind: 'user', login: it.login, id: it.id, profileUrl: it.html_url },
      };
    }
    return {
      ...base,
      sourcePlatform: 'github',
      title: it.full_name,
      author: it.owner?.login ?? null,
      publishedAt: it.created_at ?? null,
      excerpt: it.description ?? null,
      fullText: it.description ?? null,
      language: null,
      rawMetadata: {
        kind: 'repository',
        stars: it.stargazers_count,
        forks: it.forks_count,
        openIssues: it.open_issues_count,
        primaryLanguage: it.language,
        topics: it.topics ?? [],
        homepage: it.homepage ?? null,
        pushedAt: it.pushed_at,
        updatedAt: it.updated_at,
        license: it.license?.spdx_id ?? null,
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, 'https://api.github.com/rate_limit', { headers: this.headers(ctx) });
    });
    if (!probe.ok) return this.health('OFFLINE', probe.latencyMs, 'GitHub API probe failed', probe.error);
    const auth = ctx.config.GITHUB_TOKEN ? 'authenticated (5000/h)' : 'anonymous (60/h)';
    return this.health('ONLINE', probe.latencyMs, `GitHub API reachable, ${auth}`);
  }
}
