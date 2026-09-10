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
