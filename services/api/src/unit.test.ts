import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'file:./prisma/dev.db';
process.env.AUTH_JWT_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.CREDENTIAL_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64url');

const { encryptSecret, decryptSecret, encryptJson, decryptJson } = await import('./lib/crypto.js');
const { hashPassword, verifyPassword } = await import('./lib/password.js');
const { planQueries } = await import('./orchestrator/QueryPlanner.js');
const { scoreEntityMatch, jaroWinkler } = await import('./orchestrator/EntityResolver.js');
const { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } = await import('./auth/tokens.js');
const { buildEvidenceContext, validateCitations } = await import('./ai/grounding.js');
const { parseJsonLoose } = await import('./ai/chat.js');
const { perceptualHash, hammingHex, isDuplicateImage, extractImageMeta } = await import('./lib/mediaExtract.js');

test('crypto: AES-256-GCM round trip + tamper detection', () => {
  const enc = encryptSecret('super-secret-token');
  assert.equal(decryptSecret(enc), 'super-secret-token');
  assert.notEqual(enc, 'super-secret-token');
  const tampered = enc.slice(0, -4) + 'AAAA';
  assert.throws(() => decryptSecret(tampered));
  const bundle = encryptJson({ API_KEY: 'abc', CX: '123' });
  assert.deepEqual(decryptJson(bundle), { API_KEY: 'abc', CX: '123' });
});

test('password: scrypt hash verifies and rejects wrong password', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('tokens: access token signs/verifies; refresh token hashes stably', async () => {
  const t = await signAccessToken({ sub: 'u1', email: 'a@b.c', role: 'ADMIN' });
  const claims = await verifyAccessToken(t);
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.role, 'ADMIN');
  await assert.rejects(() => verifyAccessToken(t + 'x'));
  const { token, hash } = generateRefreshToken();
  assert.equal(hashRefreshToken(token), hash);
});

test('QueryPlanner: original first, depth-limited, expansions tagged', () => {
  const { queries } = planQueries({ originalQuery: 'Acme Robotics funding', subjectType: 'COMPANY', depth: 'STANDARD' });
  assert.equal(queries[0]?.kind, 'ORIGINAL');
  assert.equal(queries[0]?.generatedBy, 'USER');
  assert.ok(queries.length > 1 && queries.length <= 6);
  assert.ok(queries.slice(1).every((q) => q.generatedBy === 'DETERMINISTIC'));
  assert.ok(queries.every((q) => q.rationale.length > 0));

  const quick = planQueries({ originalQuery: 'x', subjectType: null, depth: 'QUICK' });
  assert.equal(quick.queries.length, 1);
});

test('EntityResolver: name-only similarity capped; shared identifier lifts score', () => {
  const a = { type: 'COMPANY', displayName: 'Acme Corporation', canonicalValue: 'acme corporation', aliases: [] };
  const b = { type: 'COMPANY', displayName: 'Acme Corp', canonicalValue: 'acme corp', aliases: [] };
  const nameOnly = scoreEntityMatch(a, b);
  assert.ok(nameOnly.score <= 0.7, `name-only should be capped, got ${nameOnly.score}`);
  assert.notEqual(nameOnly.recommendation, 'LIKELY_SAME');

  const withDomain = scoreEntityMatch(
    { ...a, aliases: [{ value: 'acme.com', kind: 'DOMAIN' }] },
    { ...b, aliases: [{ value: 'acme.com', kind: 'DOMAIN' }] },
  );
  assert.ok(withDomain.score > nameOnly.score);
  assert.ok(withDomain.factors.some((f) => f.key === 'shared_identifier' && f.value > 0));

  const diffType = scoreEntityMatch(a, { ...b, type: 'PERSON' });
  assert.equal(diffType.score, 0);
  assert.equal(diffType.recommendation, 'DO_NOT_MERGE');
});

test('jaroWinkler basic properties', () => {
  assert.equal(jaroWinkler('same', 'same'), 1);
  assert.ok(jaroWinkler('acme corp', 'acme corporation') > 0.8);
  assert.ok(jaroWinkler('acme', 'zzzz') < 0.5);
});

test('buildEvidenceContext numbers blocks and maps to ids', () => {
  const { blocks, prompt } = buildEvidenceContext([
    { id: 'EVIDENCE-2026-000001', title: 'A', excerpt: 'first', fullText: null, url: 'https://a.com', publishedAt: '2025-01-01', source: { label: 'A News', tier: 'ESTABLISHED_PUBLICATION' } },
    { id: 'EVIDENCE-2026-000002', title: 'B', excerpt: 'second', fullText: null, url: null, publishedAt: null, source: null },
  ]);
  assert.equal(blocks[0]?.ref, 'E1');
  assert.equal(blocks[1]?.evidenceId, 'EVIDENCE-2026-000002');
  assert.ok(prompt.includes('[E1] EVIDENCE-2026-000001'));
  assert.ok(prompt.includes('A News'));
});

test('validateCitations: grounds cited statements, flags uncited factual ones, exempts gap markers', () => {
  const { blocks } = buildEvidenceContext([
    { id: 'EVIDENCE-2026-000001', title: null, excerpt: 'x', fullText: null, url: null, publishedAt: null, source: null },
    { id: 'EVIDENCE-2026-000002', title: null, excerpt: 'y', fullText: null, url: null, publishedAt: null, source: null },
  ]);
  const aiText = [
    '[FACT] The organization was founded in 2019 [E1, E2].',
    'It later expanded into three new countries and doubled its headcount.', // uncited factual -> ungrounded
    'Its exact revenue is not found in the searched sources.', // gap marker -> exempt
    'The CEO stepped down in 2023 [E5].', // invalid ref
  ].join('\n');
  const v = validateCitations(aiText, blocks);
  assert.deepEqual(v.evidenceIdsUsed.sort(), ['EVIDENCE-2026-000001', 'EVIDENCE-2026-000002']);
  assert.equal(v.grounded.length, 1);
  assert.ok(v.ungrounded.some((s) => s.includes('three new countries')));
  assert.ok(!v.ungrounded.some((s) => s.includes('not found in the searched sources')));
  assert.deepEqual(v.invalidRefs, ['E5']);
});

test('parseJsonLoose handles fenced and trailing prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"queries":[]} hope that helps'), { queries: [] });
  assert.equal(parseJsonLoose('not json at all'), null);
});

test('media: perceptual hash detects a resized copy as duplicate, not an unrelated image', async () => {
  const { Jimp } = await import('jimp');
  const rgba = (r: number, g: number, b: number, a: number) => ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  const gradient = new Jimp({ width: 128, height: 128 });
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) gradient.setPixelColor(rgba(x * 2, y * 2, (x + y) % 256, 255), x, y);
  const solid = new Jimp({ width: 128, height: 128, color: 0x3366ccff });

  const gradBuf = Buffer.from(await gradient.getBuffer('image/png'));
  const gradSmall = gradient.clone().resize({ w: 64, h: 64 });
  const gradSmallBuf = Buffer.from(await gradSmall.getBuffer('image/jpeg'));
  const solidBuf = Buffer.from(await solid.getBuffer('image/png'));

  const h1 = await perceptualHash(gradBuf);
  const h2 = await perceptualHash(gradSmallBuf);
  const h3 = await perceptualHash(solidBuf);
  assert.ok(h1 && h2 && h3);
  assert.ok(hammingHex(h1!, h2!) <= 6, `resized copy should be near, got ${hammingHex(h1!, h2!)}`);
  assert.ok(hammingHex(h1!, h3!) > 12, `unrelated image should be far, got ${hammingHex(h1!, h3!)}`);
  assert.equal(isDuplicateImage(h1, h2), true);
  assert.equal(isDuplicateImage(h1, h3), false);

  const meta = await extractImageMeta(gradBuf);
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 128);
  assert.equal(meta.gps, null);
  assert.equal(meta.sha256.length, 64);
});
