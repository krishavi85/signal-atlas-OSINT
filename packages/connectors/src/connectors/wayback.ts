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
  RawHit,
  SearchOutcome,
  SearchParams,
} from '../sdk/types.js';
import { extractHtmlMeta, stripTags } from '../lib/markup.js';

/**
 * Internet Archive Wayback Machine connector (§3 "Archive sources where lawful",
 * §19). No API key.
 *
 * The Wayback Machine has no public full-text search of archived page content,
 * so `search()` interprets the query as a domain or URL and lists its captures
 * over time via the CDX API. A non-URL query returns an empty result set with
 * an explanatory notice — it never fabricates hits.
 *
 * `fetch()` retrieves a specific archived snapshot (id_ raw capture).
 */
interface CdxRow {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
}

export class WaybackConnector extends BaseConnector {
  constructor() {
    super({
      id: 'wayback',
      displayName: 'Internet Archive — Wayback Machine',
      category: 'reference',
      declared: {
        SEARCH_SUPPORTED: true, // query = domain/URL -> capture history
        FETCH_SUPPORTED: true,
        HISTORICAL_SEARCH_SUPPORTED: true,
        DATE_FILTER_SUPPORTED: true,
        MONITORING_SUPPORTED: true,
        BOOLEAN_QUERY_SUPPORTED: false,
        RATE_LIMITED: true,
        AUTH_REQUIRED: false,
      },
      limiter: new TokenBucketLimiter(5, 1, 2),
    });
  }

  protected configGaps(): CapabilityGap[] {
    return [];
  }

  private extractHost(query: string): { host: string; isPrefix: boolean } | null {
    const q = query.trim().replace(/^["']|["']$/g, '');
    const canon = canonicalizeUrl(q.includes('://') ? q : `https://${q}`);
    if (!canon) return null;
    // a bare domain -> match the whole domain (prefix); a full URL -> exact-ish
    const isBareDomain = !/\//.test(q.replace(/^https?:\/\//, ''));
    return { host: isBareDomain ? canon.host : canon.canonical.replace(/^https?:\/\//, ''), isPrefix: isBareDomain };
  }

  override async search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome> {
    const target = this.extractHost(params.query);
    if (!target || !target.host.includes('.')) {
      return {
        hits: [],
        totalAvailable: 0,
        hasMore: false,
        notices: [
          'Wayback Machine has no full-text search; provide a domain or URL as the query to list its archived captures.',
        ],
      };
    }
    const url = new URL('https://web.archive.org/cdx/search/cdx');
    url.searchParams.set('url', target.isPrefix ? `${target.host}/*` : target.host);
    url.searchParams.set('output', 'json');
    url.searchParams.set('fl', 'timestamp,original,mimetype,statuscode,digest');
    url.searchParams.set('collapse', 'digest');
    url.searchParams.set('filter', 'statuscode:200');
    url.searchParams.set('limit', String(Math.min(params.limit, 50)));
    if (params.dateAfter) url.searchParams.set('from', params.dateAfter.slice(0, 10).replace(/-/g, ''));
    if (params.dateBefore) url.searchParams.set('to', params.dateBefore.slice(0, 10).replace(/-/g, ''));

    const raw = await this.getJson<string[][]>(ctx, url.toString());
    if (!Array.isArray(raw) || raw.length <= 1) {
      return { hits: [], totalAvailable: 0, hasMore: false, notices: [`No archived captures found for ${target.host}`] };
    }
    const [header, ...rows] = raw;
    const idx = Object.fromEntries((header ?? []).map((h, i) => [h, i]));
    const hits: RawHit[] = rows.map((r) => {
      const rec: CdxRow = {
        timestamp: r[idx.timestamp!] ?? '',
        original: r[idx.original!] ?? '',
        mimetype: r[idx.mimetype!] ?? '',
        statuscode: r[idx.statuscode!] ?? '',
        digest: r[idx.digest!] ?? '',
      };
      const snapshotUrl = `https://web.archive.org/web/${rec.timestamp}/${rec.original}`;
      return { externalId: `wayback-${rec.digest}-${rec.timestamp}`, url: snapshotUrl, raw: rec };
    });
    return { hits, totalAvailable: rows.length, hasMore: rows.length >= Math.min(params.limit, 50), notices: [] };
  }

  override async fetch(params: FetchParams, ctx: ConnectorContext): Promise<RawDocument> {
    // request the raw archived bytes (id_ suffix) to avoid the Wayback chrome
    const url = params.url.replace(/(\/web\/\d+)(\/)/, '$1id_$2');
    const res = await this.getText(ctx, url, { timeoutMs: 20_000 });
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
    // parsed is a CdxRow (from search) or a RawDocument (from fetch)
    if (parsed && typeof parsed === 'object' && 'body' in parsed) {
      const doc = parsed as RawDocument;
      const meta = extractHtmlMeta(doc.body);
      const base = this.baseNormalized(params.discoveryQuery, doc.url);
      return {
        ...base,
        sourcePlatform: 'wayback',
        title: meta.title,
        author: meta.author,
        publishedAt: meta.publishedAt ? new Date(Date.parse(meta.publishedAt)).toISOString() : null,
        excerpt: (meta.description ?? stripTags(doc.body)).slice(0, 500) || null,
        fullText: stripTags(doc.body) || null,
        language: meta.language,
        rawMetadata: { archived: true, snapshotUrl: doc.url, contentType: doc.contentType },
      };
    }
    const rec = parsed as CdxRow;
    const captureIso = waybackTsToIso(rec.timestamp);
    const snapshotUrl = `https://web.archive.org/web/${rec.timestamp}/${rec.original}`;
    const base = this.baseNormalized(params.discoveryQuery, snapshotUrl);
    return {
      ...base,
      sourcePlatform: 'wayback',
      title: `Archived: ${rec.original}`,
      author: 'Internet Archive',
      publishedAt: captureIso,
      excerpt: `Wayback Machine capture of ${rec.original} on ${captureIso?.slice(0, 10)} (HTTP ${rec.statuscode}, ${rec.mimetype}).`,
      fullText: null,
      rawMetadata: {
        archived: true,
        originalUrl: rec.original,
        captureTimestamp: rec.timestamp,
        digest: rec.digest,
        mimetype: rec.mimetype,
        statuscode: rec.statuscode,
        snapshotUrl,
      },
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const probe = await this.timedProbe(async () => {
      await this.getJson(ctx, 'https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=1');
    });
    return probe.ok
      ? this.health('ONLINE', probe.latencyMs, 'Wayback CDX API reachable')
      : this.health('OFFLINE', probe.latencyMs, 'Wayback CDX API probe failed', probe.error);
  }
}

function waybackTsToIso(ts: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(ts);
  if (!m) return null;
  return new Date(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? '0'), +(m[5] ?? '0'), +(m[6] ?? '0')),
  ).toISOString();
}
