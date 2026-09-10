import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessSourceQuality,
  assertFactHasEvidence,
  canonicalizeUrl,
  classifyCorroboration,
  contentHash,
  countIndependentSources,
  deduplicate,
  expandQuery,
  extractEntitiesHeuristic,
  factor,
  formatEvidenceId,
  hammingDistance,
  isNearDuplicate,
  parseBooleanQuery,
  parseEvidenceId,
  registrableDomain,
  sameCanonicalUrl,
  scoreConfidence,
  simhash64,
  toPlainQuery,
  validateOutboundUrl,
  type NormalizedResult,
} from './index.js';

// ── evidence ids ─────────────────────────────────────────────────────────────
test('evidence id round-trips and zero-pads', () => {
  assert.equal(formatEvidenceId(2026, 42), 'EVIDENCE-2026-000042');
  assert.deepEqual(parseEvidenceId('EVIDENCE-2026-000042'), { year: 2026, seq: 42 });
  assert.equal(parseEvidenceId('nope'), null);
});

// ── hashing / near-dup ───────────────────────────────────────────────────────
test('contentHash ignores whitespace and smart quotes', () => {
  assert.equal(
    contentHash('Hello   “world”'),
    contentHash('hello "world"'),
  );
});

test('simhash near-duplicate detection', () => {
  const a = 'The company announced a new product line for the European market in March.';
  const b = 'The company announced a new product line for the European market in March!!';
  const c = 'Completely unrelated sentence about marine biology and coral reefs.';
  assert.ok(isNearDuplicate(a, b));
  assert.ok(!isNearDuplicate(a, c));
  assert.ok(hammingDistance(simhash64(a), simhash64(c)) > 10);
});

// ── url canon ────────────────────────────────────────────────────────────────
test('canonicalizeUrl strips tracking params, ports, fragments, trailing slash', () => {
  const c = canonicalizeUrl('HTTPS://Example.com:443/path/?utm_source=x&b=2&a=1#frag');
  assert.equal(c?.canonical, 'https://example.com/path?a=1&b=2');
  assert.equal(c?.registrableDomain, 'example.com');
});

test('registrableDomain handles multi-part TLDs', () => {
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
});

test('sameCanonicalUrl', () => {
  assert.ok(sameCanonicalUrl('http://x.com/a?z=1&y=2', 'http://x.com/a?y=2&z=1'));
  assert.ok(!sameCanonicalUrl('http://x.com/a', 'http://x.com/b'));
});

// ── boolean query ────────────────────────────────────────────────────────────
test('parseBooleanQuery: operators, phrases, field filters', () => {
  const p = parseBooleanQuery('"acme corp" AND (funding OR acquisition) NOT rumor site:sec.gov -reddit.com after:2025-01-01 lang:en');
  assert.deepEqual(p.phrases, ['acme corp']);
  assert.ok(p.terms.includes('funding') && p.terms.includes('acquisition'));
  assert.ok(p.excludedTerms.includes('rumor'));
  assert.deepEqual(p.siteFilters, ['sec.gov']);
  assert.deepEqual(p.excludedDomains, ['reddit.com']);
  assert.equal(p.dateAfter, '2025-01-01');
  assert.equal(p.language, 'en');
  assert.equal(p.ast?.type, 'and');
});

test('parseBooleanQuery: implicit AND and plain rendering', () => {
  const p = parseBooleanQuery('beatshore music label');
  assert.equal(p.ast?.type, 'and');
  assert.equal(toPlainQuery(p), 'beatshore music label');
});

test('parseBooleanQuery: malformed date is warned, not thrown', () => {
  const p = parseBooleanQuery('acme before:nonsense');
  assert.equal(p.dateBefore, null);
  assert.ok(p.warnings.some((w) => w.includes('before')));
});

// ── entity extraction ────────────────────────────────────────────────────────
test('extractEntitiesHeuristic finds emails, urls, hashtags, handles, dates, companies', () => {
  const text =
    'Contact press@beatshore.io or visit https://beatshore.io/news on 2025-06-01. ' +
    'Follow @beatshore and #BeatShoreLive. BeatShore Holdings Ltd announced results.';
  const ents = extractEntitiesHeuristic(text);
  const byType = (t: string) => ents.filter((e) => e.type === t).map((e) => e.canonicalValue);
  assert.ok(byType('EMAIL').includes('press@beatshore.io'));
  assert.ok(byType('URL').some((u) => u.startsWith('https://beatshore.io/news')));
  assert.ok(byType('HASHTAG').includes('#beatshorelive'));
  assert.ok(byType('SOCIAL_ACCOUNT').includes('@beatshore'));
  assert.ok(byType('DATE').includes('2025-06-01'));
  assert.ok(byType('COMPANY').some((c) => c.startsWith('BeatShore Holdings')));
  // every entity carries its method + confidence
  assert.ok(ents.every((e) => e.method === 'regex' || e.method === 'gazetteer'));
  assert.ok(ents.every((e) => e.confidence > 0 && e.confidence <= 1));
});

// ── dedup engine ─────────────────────────────────────────────────────────────
function nr(partial: Partial<NormalizedResult>): NormalizedResult {
  return {
    connectorId: 'test',
    sourcePlatform: 'web',
    url: null,
    canonicalUrl: null,
    title: null,
    author: null,
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    excerpt: null,
    fullText: null,
    language: null,
    rawMetadata: {},
    discoveryQuery: 'q',
    media: [],
    ...partial,
  };
}

test('deduplicate: exact url, syndication, near-dup clustering', () => {
  const items = [
    { id: '1', result: nr({ url: 'https://a.com/story', fullText: 'Acme raised a Series B of 40 million dollars led by Foo Ventures.' }) },
    { id: '2', result: nr({ url: 'https://a.com/story', fullText: 'irrelevant' }) }, // exact url dup
    { id: '3', result: nr({ url: 'https://b.com/wire', fullText: 'Acme raised a Series B of 40 million dollars led by Foo Ventures.' }) }, // syndicated
    { id: '4', result: nr({ url: 'https://c.com/post', fullText: 'Marine biology field notes from a coral reef survey in 2024.' }) }, // unique
  ];
  const decisions = deduplicate(items);
  assert.equal(decisions[1]?.reason, 'EXACT_URL');
  assert.equal(decisions[2]?.reason, 'SYNDICATED');
  assert.equal(decisions[3]?.isDuplicate, false);

  const resultsById = new Map(items.map((i) => [i.id, i.result]));
  // items 1 & 3 are the same story on 2 domains => 1 independent source, plus item 4 => 2
  const independent = countIndependentSources(decisions, resultsById);
  assert.equal(independent, 2);
});

// ── corroboration ────────────────────────────────────────────────────────────
test('classifyCorroboration', () => {
  assert.equal(classifyCorroboration({ supportingSourceCount: 0, independentSourceCount: 0, contradictingSourceCount: 0 }).class, 'UNVERIFIED');
  assert.equal(classifyCorroboration({ supportingSourceCount: 1, independentSourceCount: 1, contradictingSourceCount: 0 }).class, 'SINGLE_SOURCE');
  assert.equal(classifyCorroboration({ supportingSourceCount: 5, independentSourceCount: 1, contradictingSourceCount: 0 }).class, 'MULTIPLE_SOURCES');
  assert.equal(classifyCorroboration({ supportingSourceCount: 3, independentSourceCount: 3, contradictingSourceCount: 0 }).class, 'INDEPENDENTLY_CORROBORATED');
  assert.equal(classifyCorroboration({ supportingSourceCount: 2, independentSourceCount: 2, contradictingSourceCount: 1 }).class, 'CONTRADICTED');
  assert.equal(
    classifyCorroboration({ supportingSourceCount: 1, independentSourceCount: 1, contradictingSourceCount: 0, latestSupportAt: '2019-01-01T00:00:00Z' }).class,
    'OUTDATED',
  );
});

// ── source quality ───────────────────────────────────────────────────────────
test('assessSourceQuality: gov beats unknown; popularity alone does not verify', () => {
  const gov = assessSourceQuality({ isGovernmentDomain: true, hasPublicationDate: true, hasNamedAuthor: true });
  const blog = assessSourceQuality({ hasPublicationDate: false, independentCorroborationCount: 10 });
  assert.equal(gov.tier, 'PRIMARY_OFFICIAL');
  assert.ok(gov.score > 0.9);
  assert.ok(blog.score < 0.6, `unknown blog should stay < 0.6 even with corroboration, got ${blog.score}`);
  assert.ok(blog.reasons.length > 0);
});

// ── confidence model ─────────────────────────────────────────────────────────
test('scoreConfidence: VERIFIED requires independent corroboration; contradiction caps low', () => {
  const strong = scoreConfidence([
    factor('source_reliability', 0.9, 'gov source'),
    factor('independent_corroboration', 0.9, '3 independent domains'),
    factor('evidence_directness', 0.8, 'primary doc'),
    factor('date_consistency', 0.7, 'dates agree'),
  ]);
  assert.equal(strong.level, 'VERIFIED');

  const contradicted = scoreConfidence([
    factor('source_reliability', 0.9, 'gov source'),
    factor('independent_corroboration', 0.9, '3 independent domains'),
    factor('contradiction_penalty', -0.9, 'two sources disagree on founding year'),
  ]);
  assert.ok(contradicted.level === 'LOW' || contradicted.level === 'VERY_LOW');

  assert.equal(scoreConfidence([]).level, 'VERY_LOW');
});

// ── anti-hallucination guard ─────────────────────────────────────────────────
test('assertFactHasEvidence throws for FACT with no evidence', () => {
  assert.throws(() =>
    assertFactHasEvidence({ tag: 'FACT', origin: 'AI_SYNTHESIS', evidenceIds: [] }),
  );
  assert.doesNotThrow(() =>
    assertFactHasEvidence({ tag: 'FACT', origin: 'SOURCE_CONTENT', evidenceIds: ['EVIDENCE-2026-000001'] }),
  );
  assert.doesNotThrow(() =>
    assertFactHasEvidence({ tag: 'UNKNOWN', origin: 'SYSTEM_CORRELATION', evidenceIds: [] }),
  );
});

// ── query expansion ──────────────────────────────────────────────────────────
test('expandQuery keeps original separate and annotates rationale', () => {
  const ex = expandQuery('BeatShore Records', {
    subjectType: 'COMPANY',
    knownDomains: ['beatshore.io'],
    knownHandles: ['@beatshore'],
  });
  assert.equal(ex[0]?.kind, 'ORIGINAL');
  assert.ok(ex.every((e) => e.executed === false));
  assert.ok(ex.some((e) => e.kind === 'SITE_SCOPED' && e.query.includes('beatshore.io')));
  assert.ok(ex.some((e) => e.kind === 'NEWS'));
  assert.ok(ex.every((e) => e.rationale.length > 0));
  // no duplicate query strings
  assert.equal(new Set(ex.map((e) => e.query.toLowerCase())).size, ex.length);
});

// ── SSRF guard ───────────────────────────────────────────────────────────────
test('validateOutboundUrl blocks private / loopback / metadata / creds / bad scheme', () => {
  assert.equal(validateOutboundUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(validateOutboundUrl('http://127.0.0.1:8080').ok, false);
  assert.equal(validateOutboundUrl('http://10.0.0.5').ok, false);
  assert.equal(validateOutboundUrl('http://192.168.1.1').ok, false);
  assert.equal(validateOutboundUrl('http://localhost/x').ok, false);
  assert.equal(validateOutboundUrl('http://foo.internal/x').ok, false);
  assert.equal(validateOutboundUrl('file:///etc/passwd').ok, false);
  assert.equal(validateOutboundUrl('http://user:pass@example.com').ok, false);
  assert.equal(validateOutboundUrl('https://example.com/ok').ok, true);
  assert.equal(validateOutboundUrl('http://[::1]/x').ok, false);
});
