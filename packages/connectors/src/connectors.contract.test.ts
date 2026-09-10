import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NormalizedResult } from '@osint/core';
import { buildDefaultRegistry } from './index.js';
import { CAPABILITY_KEYS } from './sdk/capabilities.js';
import type { ConnectorContext } from './sdk/types.js';

/**
 * Connector contract tests (§49). Every registered connector must:
 *  - expose a stable id + displayName
 *  - return a well-formed capability report (declared/effective/gaps)
 *  - report NOT_CONFIGURED (or an offline-ish state) with NO network + NO keys
 *  - never throw synchronously from capabilities()/rateLimitStatus()
 *  - produce a schema-valid NormalizedResult from a representative parsed input
 */

function offlineCtx(config: Record<string, string | undefined> = {}): ConnectorContext {
  return {
    config,
    userAgent: 'osint-platform-test/0.1',
    log: () => {},
    safeFetch: async () => {
      throw new Error('network disabled in contract test');
    },
    cache: undefined,
    signal: undefined,
  };
}

const registry = buildDefaultRegistry();

test('registry has all built-in connectors with unique ids', () => {
  const ids = registry.ids();
  assert.ok(ids.length >= 12);
  assert.equal(new Set(ids).size, ids.length);
});

for (const connector of registry.all()) {
  test(`[${connector.id}] capability report is well-formed`, () => {
    const fn = connector.capabilities as (ctx?: ConnectorContext | null) => ReturnType<typeof connector.capabilities>;
    const report = fn.call(connector, offlineCtx());
    assert.equal(report.connectorId, connector.id);
    assert.ok(report.displayName.length > 0);
    assert.ok(['web-search', 'news', 'social', 'code', 'reference', 'user-input', 'registry'].includes(report.category));
    for (const k of Object.keys(report.declared)) assert.ok((CAPABILITY_KEYS as readonly string[]).includes(k));
    for (const k of Object.keys(report.effective)) assert.ok((CAPABILITY_KEYS as readonly string[]).includes(k));
    for (const gap of report.gaps) {
      assert.ok(gap.message.length > 0, `${connector.id} gap needs a message`);
      assert.ok(
        ['MISSING_API_KEY', 'MISSING_OAUTH', 'REQUIRES_APP_REVIEW', 'NOT_IMPLEMENTED', 'DISABLED_BY_CONFIG', 'PLATFORM_RESTRICTION'].includes(gap.code),
      );
    }
  });

  test(`[${connector.id}] rateLimitStatus() is finite and non-throwing`, () => {
    const s = connector.rateLimitStatus();
    assert.ok(s.retryAfterMs >= 0);
    assert.ok(s.concurrency >= 1);
  });
}

test('key-gated connectors declare a config gap when unconfigured', () => {
  const gated = ['brave-search', 'google-cse', 'youtube', 'reddit', 'facebook-graph', 'instagram-graph', 'searxng'];
  for (const id of gated) {
    const c = registry.get(id)!;
    const fn = c.capabilities as (ctx?: ConnectorContext | null) => ReturnType<typeof c.capabilities>;
    const report = fn.call(c, offlineCtx());
    assert.ok(report.gaps.length > 0, `${id} should report a gap with no config`);
    // effective SEARCH must be false when a total gap ('ALL') is present
    if (report.gaps.some((g) => g.capability === 'ALL')) {
      assert.notEqual(report.effective.SEARCH_SUPPORTED, true, `${id} must not claim SEARCH while fully unconfigured`);
    }
  }
});

test('key-free connectors have no blocking gaps', () => {
  for (const id of ['wikipedia', 'hackernews', 'rss', 'web-generic', 'wayback']) {
    const c = registry.get(id)!;
    const fn = c.capabilities as (ctx?: ConnectorContext | null) => ReturnType<typeof c.capabilities>;
    const report = fn.call(c, offlineCtx());
    assert.ok(!report.gaps.some((g) => g.capability === 'ALL'), `${id} should have no total gap`);
  }
});

test('search on an unconfigured gated connector returns empty + notice, never fake data', async () => {
  for (const id of ['brave-search', 'google-cse', 'youtube', 'reddit', 'facebook-graph', 'instagram-graph']) {
    const c = registry.get(id)!;
    const out = await c.search({ query: 'anything', limit: 5 }, offlineCtx());
    assert.equal(out.hits.length, 0, `${id} must return zero hits when unconfigured`);
    assert.ok(out.notices.length > 0, `${id} must explain why it returned nothing`);
  }
});

test('normalize() output validates against NormalizedResult schema', async () => {
  const cases: Array<[string, unknown]> = [
    ['wikipedia', { pageid: 1, title: 'Acme Corp', snippet: 'An <b>example</b> company', timestamp: '2025-01-01T00:00:00Z', base: 'https://en.wikipedia.org', summary: { title: 'Acme Corp', extract: 'Acme Corp is a fictional company.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Acme_Corp' } }, lang: 'en' } }],
    ['hackernews', { objectID: '123', title: 'Show HN: Acme', story_title: null, url: 'https://acme.example', story_url: null, author: 'pg', points: 10, num_comments: 3, created_at: '2025-02-02T00:00:00Z', created_at_i: 1, comment_text: null, story_text: 'body', _tags: ['story'] }],
    ['rss', { item: { title: 'News', link: 'https://news.example/a', description: '<p>hi</p>', content: null, author: 'Jane', publishedAt: '2025-03-03T00:00:00Z', guid: 'g1' }, feedTitle: 'Feed', feedUrl: 'https://news.example/rss' }],
    ['github', { id: 5, full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets', description: 'Widgets', owner: { login: 'acme' }, created_at: '2024-01-01T00:00:00Z', stargazers_count: 3, forks_count: 1, open_issues_count: 0, topics: [], __target: 'repositories' }],
    ['wayback', { timestamp: '20230115120000', original: 'http://acme.example/', mimetype: 'text/html', statuscode: '200', digest: 'ABC123' }],
  ];
  for (const [id, parsed] of cases) {
    const c = registry.get(id)!;
    const normalized = await c.normalize(parsed, { discoveryQuery: 'acme' }, offlineCtx());
    const parsedResult = NormalizedResult.safeParse(normalized);
    assert.ok(parsedResult.success, `${id} normalize output invalid: ${JSON.stringify(parsedResult.error?.issues)}`);
    assert.equal(normalized.discoveryQuery, 'acme');
    assert.equal(normalized.connectorId, id);
  }
});
