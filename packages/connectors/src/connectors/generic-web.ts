import type { NormalizedResult } from '@osint/core';
import { canonicalizeUrl } from '@osint/core';
import { BaseConnector } from '../sdk/base.js';
import { TokenBucketLimiter } from '../sdk/rate-limit.js';
import type { CapabilityGap } from '../sdk/capabilities.js';
import type {
  ConnectorContext,
  ConnectorHealth,
  FetchParams,
  RawDocument,
  SearchOutcome,
  SearchParams,
} from '../sdk/types.js';
import { extractHtmlMeta, stripTags } from '../lib/markup.js';

/**
 * Generic web fetch connector — retrieves a single user-supplied URL (§3
 * "User-provided URLs"). Honours robots.txt for the fetch path, respects the
 * SSRF guard in ctx.safeFetch, hashes content for evidence, and extracts
 * readable text + metadata. Does NOT crawl or follow links.
 */
export class GenericWebConnector extends BaseConnector {
  constructor() {
    super({
      id: 'web-generic',
      displayName: 'Generic web page fetch',
      category: 'user-input',
      declared: {
        SEARCH_SUPPORTED: false,
        FETCH_SUPPORTED: true,
        MEDIA_SUPPORTED: true,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(6, 2, 3),
    });
  }

  protected configGaps(): CapabilityGap[] {
    return [];
  }

  override async search(_params: SearchParams): Promise<SearchOutcome> {
    return {
      hits: [],
      totalAvailable: 0,
      hasMore: false,
      notices: ['web-generic does not perform search; use it to fetch a specific URL you provide.'],
    };
  }

  private async robotsAllows(ctx: ConnectorContext, target: URL): Promise<boolean> {
    try {
      const robotsUrl = `${target.protocol}//${target.host}/robots.txt`;
      const res = await this.getText(ctx, robotsUrl, { timeoutMs: 5000 });
      if (res.status >= 400) return true; // no robots => allowed
      return isPathAllowed(res.body, target.pathname, ctx.userAgent);
    } catch {
      return true;
    }
  }

  override async fetch(params: FetchParams, ctx: ConnectorContext): Promise<RawDocument> {
    const target = new URL(params.url);
    const allowed = await this.robotsAllows(ctx, target);
    if (!allowed) {
      throw new Error(
        `robots.txt for ${target.host} disallows automated retrieval of ${target.pathname}. Not fetched.`,
      );
    }
    const res = await this.getText(ctx, params.url, { timeoutMs: 15_000 });
    return {
      url: params.url,
      status: res.status,
      contentType: res.contentType,
      body: res.body,
      headers: res.headers,
      fetchedAt: new Date().toISOString(),
    };
  }

  override async parse(input: RawDocument | { raw: unknown }): Promise<unknown> {
    return input;
  }

  async normalize(parsed: unknown, params: { discoveryQuery: string }): Promise<NormalizedResult> {
    const doc = parsed as RawDocument;
    const ct = doc.contentType ?? '';
    const isHtml = ct.includes('html') || /^\s*<(!doctype|html)/i.test(doc.body);
    const base = this.baseNormalized(params.discoveryQuery, doc.url);
    const canon = canonicalizeUrl(doc.url);

    if (!isHtml) {
      const text = ct.includes('json') || ct.includes('text') ? doc.body : null;
      return {
        ...base,
        sourcePlatform: 'web',
        title: doc.url,
        excerpt: text ? text.slice(0, 500) : null,
        fullText: text,
        rawMetadata: { contentType: ct, status: doc.status, registrableDomain: canon?.registrableDomain },
      };
    }

    const meta = extractHtmlMeta(doc.body);
    const text = stripTags(doc.body);
    return {
      ...base,
      sourcePlatform: 'web',
      title: meta.title,
      author: meta.author,
      publishedAt: meta.publishedAt ? new Date(Date.parse(meta.publishedAt)).toISOString() : null,
      excerpt: (meta.description ?? text).slice(0, 500) || null,
      fullText: text || null,
      language: meta.language,
      canonicalUrl: meta.canonical
        ? canonicalizeUrl(new URL(meta.canonical, doc.url).toString())?.canonical ?? base.canonicalUrl
        : base.canonicalUrl,
      media: meta.ogImage ? [{ type: 'image', url: new URL(meta.ogImage, doc.url).toString() }] : [],
      rawMetadata: {
        contentType: ct,
        status: doc.status,
        registrableDomain: canon?.registrableDomain,
        ogDescription: meta.description,
      },
    };
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return this.health('ONLINE', null, 'Ready to fetch user-provided URLs (SSRF-guarded, robots-aware).');
  }
}

/** Minimal robots.txt evaluation: honours Disallow for '*' and our UA token. */
function isPathAllowed(robotsTxt: string, path: string, ua: string): boolean {
  const uaToken = ua.split('/')[0]?.toLowerCase() ?? 'osint-platform';
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let applies = false;
  let sawAnyGroup = false;
  const disallows: string[] = [];
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      sawAnyGroup = true;
      applies = value === '*' || value.toLowerCase() === uaToken;
    } else if (key === 'disallow' && applies) {
      if (value) disallows.push(value);
    }
  }
  if (!sawAnyGroup) return true;
  return !disallows.some((d) => path.startsWith(d));
}
