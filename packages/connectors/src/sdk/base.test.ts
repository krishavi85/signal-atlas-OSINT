import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BaseConnector } from './base.js';
import { TokenBucketLimiter } from './rate-limit.js';
import type { CapabilityGap } from './capabilities.js';
import type { ConnectorContext, ConnectorHealth } from './types.js';

/**
 * Response cache (§39) and daily budget (§38) behavior, exercised through a
 * minimal concrete connector so the protected getJson()/getText() helpers
 * (shared by every real connector) get direct coverage.
 */
class TestConnector extends BaseConnector {
  constructor(dailyBudget?: number) {
    super({
      id: 'test-connector',
      displayName: 'Test Connector',
      category: 'reference',
      declared: { SEARCH_SUPPORTED: true },
      limiter: new TokenBucketLimiter(100, 100, 1), // effectively unthrottled for the test
      dailyBudget,
    });
  }
  protected configGaps(): CapabilityGap[] {
    return [];
  }
  async healthCheck(): Promise<ConnectorHealth> {
    return this.health('ONLINE', 0, 'ok');
  }
  callGetJson<T>(ctx: ConnectorContext, url: string, cacheTtlSeconds?: number) {
    return this.getJson<T>(ctx, url, {}, 0, cacheTtlSeconds);
  }
  callGetText(ctx: ConnectorContext, url: string, cacheTtlSeconds?: number) {
    return this.getText(ctx, url, {}, cacheTtlSeconds);
  }
}

function fakeCtx(overrides: Partial<ConnectorContext> & { fetchCount?: { n: number } } = {}) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const budgetCounts = new Map<string, number>();
  const fetchCount = overrides.fetchCount ?? { n: 0 };
  const ctx: ConnectorContext = {
    config: {},
    userAgent: 'test/1.0',
    log: () => {},
    safeFetch: async () => {
      fetchCount.n += 1;
      return new Response(JSON.stringify({ ok: true, n: fetchCount.n }), { status: 200 });
    },
    cache: {
      get: async (key) => {
        const row = store.get(key);
        if (!row) return null;
        if (row.expiresAt < Date.now()) {
          store.delete(key);
          return null;
        }
        return row.value;
      },
      set: async (key, value, ttlSeconds) => {
        store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      },
    },
    budget: {
      consume: async (maxPerDay) => {
        const n = (budgetCounts.get('test-connector') ?? 0) + 1;
        budgetCounts.set('test-connector', n);
        return { allowed: n <= maxPerDay, remaining: Math.max(0, maxPerDay - n), resetAt: 'tomorrow' };
      },
    },
    ...overrides,
  };
  return { ctx, fetchCount };
}

test('getJson: a cache hit never calls safeFetch again', async () => {
  const c = new TestConnector();
  const { ctx, fetchCount } = fakeCtx();
  const first = await c.callGetJson<{ n: number }>(ctx, 'https://example.com/a', 60);
  const second = await c.callGetJson<{ n: number }>(ctx, 'https://example.com/a', 60);
  assert.equal(fetchCount.n, 1, 'second call should be served from cache, not a new fetch');
  assert.deepEqual(first, second);
});

test('getJson: different URLs are cached independently', async () => {
  const c = new TestConnector();
  const { ctx, fetchCount } = fakeCtx();
  await c.callGetJson(ctx, 'https://example.com/a', 60);
  await c.callGetJson(ctx, 'https://example.com/b', 60);
  assert.equal(fetchCount.n, 2);
});

test('getJson: without a cacheTtlSeconds, every call hits the network', async () => {
  const c = new TestConnector();
  const { ctx, fetchCount } = fakeCtx();
  await c.callGetJson(ctx, 'https://example.com/a');
  await c.callGetJson(ctx, 'https://example.com/a');
  assert.equal(fetchCount.n, 2);
});

test('getText: caches the fetched page body', async () => {
  const c = new TestConnector();
  const { ctx, fetchCount } = fakeCtx();
  const first = await c.callGetText(ctx, 'https://example.com/page', 3600);
  const second = await c.callGetText(ctx, 'https://example.com/page', 3600);
  assert.equal(fetchCount.n, 1);
  assert.deepEqual(first, second);
});

test('budget: a connector with no dailyBudget is never blocked, no matter how many calls', async () => {
  const c = new TestConnector(); // no budget configured
  const { ctx, fetchCount } = fakeCtx();
  for (let i = 0; i < 5; i++) await c.callGetJson(ctx, `https://example.com/${i}`);
  assert.equal(fetchCount.n, 5);
});

test('budget: requests beyond the daily cap are refused with a clear, non-retryable error', async () => {
  const c = new TestConnector(2);
  const { ctx, fetchCount } = fakeCtx();
  await c.callGetJson(ctx, 'https://example.com/1');
  await c.callGetJson(ctx, 'https://example.com/2');
  await assert.rejects(
    () => c.callGetJson(ctx, 'https://example.com/3'),
    (err: Error) => {
      assert.match(err.message, /[Dd]aily budget/);
      assert.match(err.message, /exhausted/);
      return true;
    },
  );
  assert.equal(fetchCount.n, 2, 'the third, over-budget call must never reach the network');
});

test('budget: a cache hit does not consume budget', async () => {
  const c = new TestConnector(1);
  const { ctx, fetchCount } = fakeCtx();
  await c.callGetJson(ctx, 'https://example.com/a', 60); // consumes the one allowed slot, populates cache
  await c.callGetJson(ctx, 'https://example.com/a', 60); // cache hit — must not touch the budget or network
  await c.callGetJson(ctx, 'https://example.com/a', 60); // still a cache hit
  assert.equal(fetchCount.n, 1);
});
