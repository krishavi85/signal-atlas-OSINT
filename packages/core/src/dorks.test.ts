import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAhmiaSearchLink, buildDorkQueries, buildReverseImageSearchLinks, buildSearchEngineLinks, pimEyesLauncher } from './index.js';

test('buildDorkQueries: domain queries are quoted/operator-scoped and non-empty', () => {
  const qs = buildDorkQueries('domain', 'example.com');
  assert.ok(qs.length > 0);
  assert.ok(qs.some((q) => q.query === 'site:example.com'));
  assert.ok(qs.every((q) => q.query.includes('example.com')));
});

test('buildDorkQueries: email queries wrap the address in quotes', () => {
  const qs = buildDorkQueries('email', 'a@b.com');
  assert.ok(qs.some((q) => q.query === '"a@b.com"'));
});

test('buildDorkQueries: empty value returns no queries rather than malformed ones', () => {
  assert.deepEqual(buildDorkQueries('domain', '   '), []);
});

test('buildDorkQueries: unknown/generic falls back to a single exact-phrase query', () => {
  const qs = buildDorkQueries('generic', 'Acme Corp');
  assert.deepEqual(qs, [{ label: 'Exact phrase', query: '"Acme Corp"' }]);
});

test('buildSearchEngineLinks: one link per known engine, query URL-encoded', () => {
  const links = buildSearchEngineLinks('site:example.com "foo bar"');
  assert.equal(links.length, 4);
  assert.ok(links.every((l) => l.url.includes(encodeURIComponent('site:example.com "foo bar"'))));
  assert.deepEqual(links.map((l) => l.engine).sort(), ['Bing', 'DuckDuckGo', 'Google', 'Yandex']);
});

test('buildReverseImageSearchLinks: encodes the target URL for every engine', () => {
  const links = buildReverseImageSearchLinks('https://example.com/a b.jpg');
  assert.equal(links.length, 4);
  for (const l of links) assert.ok(l.url.includes(encodeURIComponent('https://example.com/a b.jpg')));
});

test('pimEyesLauncher: points at the PimEyes site itself, not a fabricated deep link', () => {
  const l = pimEyesLauncher();
  assert.equal(l.url, 'https://pimeyes.com/en');
});

test('buildAhmiaSearchLink: encodes the query into ahmia.fi\'s own search URL', () => {
  const l = buildAhmiaSearchLink('some target');
  assert.equal(l.url, 'https://ahmia.fi/search/?q=some%20target');
});
