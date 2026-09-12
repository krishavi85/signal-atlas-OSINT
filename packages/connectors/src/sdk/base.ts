import type { NormalizedResult } from '@osint/core';
import { canonicalizeUrl } from '@osint/core';
import {
  effectiveFromGaps,
  type Capabilities,
  type CapabilityGap,
  type CapabilityReport,
} from './capabilities.js';
import { TokenBucketLimiter } from './rate-limit.js';
import {
  ConnectorRequestError,
  ConnectorUnsupportedError,
  type Connector,
  type ConnectorContext,
  type ConnectorHealth,
  type FetchParams,
  type RateLimitStatus,
  type RawDocument,
  type RawHit,
  type SearchOutcome,
  type SearchParams,
} from './types.js';

export interface BaseConnectorOptions {
  id: string;
  displayName: string;
  category: CapabilityReport['category'];
  declared: Capabilities;
  limiter: TokenBucketLimiter;
  /** Enforce a persistent daily request cap against a documented provider quota (§38). */
  dailyBudget?: number;
}

/**
 * Shared connector plumbing: capability gap computation, health-probe helpers,
 * rate-limit surfacing, and default "unsupported" implementations so a
 * connector only overrides what it truly implements.
 */
export abstract class BaseConnector implements Connector {
  readonly id: string;
  readonly displayName: string;
  protected readonly category: CapabilityReport['category'];
  protected readonly declared: Capabilities;
  protected readonly limiter: TokenBucketLimiter;
  protected readonly dailyBudget?: number;

  constructor(opts: BaseConnectorOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.category = opts.category;
    this.declared = opts.declared;
    this.limiter = opts.limiter;
    this.dailyBudget = opts.dailyBudget;
  }

  /** Subclasses declare what config is missing given a context. */
  protected abstract configGaps(ctx: ConnectorContext | null): CapabilityGap[];

  capabilities(ctx: ConnectorContext | null = null): CapabilityReport {
    const gaps = this.configGaps(ctx);
    return {
      connectorId: this.id,
      displayName: this.displayName,
      category: this.category,
      declared: this.declared,
      effective: effectiveFromGaps(this.declared, gaps),
      gaps,
    };
  }

  rateLimitStatus(): RateLimitStatus {
    return this.limiter.status();
  }

  // Default: unsupported. Subclasses override as appropriate.
  async search(_params: SearchParams, _ctx: ConnectorContext): Promise<SearchOutcome> {
    throw new ConnectorUnsupportedError(this.id, 'search', this.configGaps(null)[0]);
  }

  async fetch(_params: FetchParams, _ctx: ConnectorContext): Promise<RawDocument> {
    throw new ConnectorUnsupportedError(this.id, 'fetch');
  }

  async parse(input: RawHit | RawDocument, _ctx: ConnectorContext): Promise<unknown> {
    // A RawHit carries the connector-shaped payload on `.raw`; unwrap it so
    // subclasses' normalize() receive the provider object directly. A
    // RawDocument (fetch path) has no `.raw` and passes through unchanged.
    if (input && typeof input === 'object' && 'raw' in input) {
      return (input as RawHit).raw;
    }
    return input;
  }

  abstract normalize(
    parsed: unknown,
    params: { discoveryQuery: string },
    ctx: ConnectorContext,
  ): Promise<NormalizedResult>;

  abstract healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth>;

  // ── helpers for subclasses ────────────────────────────────────────────────

  protected baseNormalized(discoveryQuery: string, url: string | null): NormalizedResult {
    const canon = url ? canonicalizeUrl(url) : null;
    return {
      connectorId: this.id,
      sourcePlatform: this.id,
      url,
      canonicalUrl: canon?.canonical ?? null,
      title: null,
      author: null,
      publishedAt: null,
      retrievedAt: new Date().toISOString(),
      excerpt: null,
      fullText: null,
      language: null,
      rawMetadata: {},
      discoveryQuery,
      media: [],
    };
  }

  protected async timedProbe(fn: () => Promise<void>): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
    const start = Date.now();
    try {
      await fn();
      return { ok: true, latencyMs: Date.now() - start, error: null };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  }

  protected health(
    state: ConnectorHealth['state'],
    latencyMs: number | null,
    message: string,
    error: string | null = null,
  ): ConnectorHealth {
    const rl = this.limiter.status();
    return {
      state,
      checkedAt: new Date().toISOString(),
      latencyMs,
      lastSuccessAt: state === 'ONLINE' ? new Date().toISOString() : null,
      lastError: error,
      requestsRemaining: rl.remaining,
      message,
    };
  }

  /**
   * Throws if this connector has a daily budget and it's exhausted. No-op
   * otherwise. `countsAgainstBudget: false` is for health-probe calls — a
   * liveness ping is administrative overhead, not investigative use, and
   * shouldn't compete with real searches for a scarce daily quota.
   */
  protected async checkBudget(ctx: ConnectorContext, countsAgainstBudget: boolean): Promise<void> {
    if (!countsAgainstBudget || !this.dailyBudget || !ctx.budget) return;
    const b = await ctx.budget.consume(this.dailyBudget);
    if (!b.allowed) {
      throw new ConnectorRequestError(
        this.id,
        `Daily budget of ${this.dailyBudget} requests exhausted for "${this.id}" (protects the provider's documented quota); resets ${b.resetAt}.`,
        429,
        false,
      );
    }
  }

  /** rate-limited JSON GET with retry on retryable errors; optionally cached (§39) */
  protected async getJson<T = unknown>(
    ctx: ConnectorContext,
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
    retries = 2,
    cacheTtlSeconds?: number,
    countsAgainstBudget = true,
  ): Promise<T> {
    const cacheKey = cacheTtlSeconds && ctx.cache ? `${this.id}:GET:${url}` : null;
    if (cacheKey) {
      const cached = await ctx.cache!.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as T;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.checkBudget(ctx, countsAgainstBudget);
      await this.limiter.acquire(ctx.signal);
      try {
        const res = await ctx.safeFetch(url, {
          ...init,
          headers: { accept: 'application/json', 'user-agent': ctx.userAgent, ...(init.headers ?? {}) },
        });
        this.limiter.observeHeaders(res.headers);
        if (res.status === 429 || res.status >= 500) {
          const delay = this.limiter.onFailure(true);
          ctx.log('warn', `${this.id} ${res.status} on ${redact(url)}, backing off ${Math.round(delay)}ms`);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          this.limiter.onFailure(false);
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        this.limiter.onSuccess();
        const parsed = (await res.json()) as T;
        if (cacheKey) await ctx.cache!.set(cacheKey, JSON.stringify(parsed), cacheTtlSeconds!);
        return parsed;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        this.limiter.onFailure(true);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** rate-limited text GET; optionally cached (§39) — used for page fetches and robots.txt */
  protected async getText(
    ctx: ConnectorContext,
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
    cacheTtlSeconds?: number,
  ): Promise<{ body: string; status: number; contentType: string | null; headers: Record<string, string> }> {
    type CachedText = { body: string; status: number; contentType: string | null; headers: Record<string, string> };
    const cacheKey = cacheTtlSeconds && ctx.cache ? `${this.id}:GET:${url}` : null;
    if (cacheKey) {
      const cached = await ctx.cache!.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as CachedText;
    }
    await this.checkBudget(ctx, true);
    await this.limiter.acquire(ctx.signal);
    const res = await ctx.safeFetch(url, {
      ...init,
      headers: { 'user-agent': ctx.userAgent, ...(init.headers ?? {}) },
    });
    this.limiter.observeHeaders(res.headers);
    if (!res.ok && res.status !== 404) this.limiter.onFailure(res.status === 429 || res.status >= 500);
    else this.limiter.onSuccess();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const result: CachedText = {
      body: await res.text(),
      status: res.status,
      contentType: res.headers.get('content-type'),
      headers,
    };
    if (cacheKey && result.status < 400) await ctx.cache!.set(cacheKey, JSON.stringify(result), cacheTtlSeconds!);
    return result;
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|auth|apikey/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}
