import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TokenBucketLimiter } from './rate-limit.js';

/**
 * Rate-limit / backoff behavior (§38, and one of the explicit §49 failure
 * scenarios: "rate limit"). A polite connector must slow itself down when a
 * provider signals it's being too aggressive — never spin at full speed.
 */

test('TokenBucketLimiter: exhausts its burst capacity then makes callers wait for a refill', async () => {
  // capacity 2, refills 1 token every 250ms — slow enough that "did it wait"
  // is unambiguous, fast enough the test stays quick.
  const limiter = new TokenBucketLimiter(2, 4, 1);
  const start = Date.now();
  await limiter.acquire(); // token 1, immediate (starts full)
  await limiter.acquire(); // token 2, immediate
  assert.ok(Date.now() - start < 50, 'first two acquisitions within capacity should not wait');

  await limiter.acquire(); // capacity exhausted -> must wait for a refill
  const waited = Date.now() - start;
  assert.ok(waited >= 150, `acquire() beyond capacity must actually wait for a refill, only waited ${waited}ms`);
});

test('TokenBucketLimiter: onFailure backs off exponentially with jitter, onSuccess resets it', () => {
  const limiter = new TokenBucketLimiter(10, 5, 2);
  const d1 = limiter.onFailure(true);
  const d2 = limiter.onFailure(true);
  const d3 = limiter.onFailure(true);
  assert.ok(d2 > d1, `backoff should grow: ${d1} then ${d2}`);
  assert.ok(d3 > d2, `backoff should keep growing: ${d2} then ${d3}`);
  assert.ok(limiter.status().retryAfterMs > 0, 'status should reflect an active backoff window');

  limiter.onSuccess();
  const d4 = limiter.onFailure(true);
  assert.ok(d4 <= d1 * 2 + 1, 'a success should reset the failure streak, not compound it further');
});

test('TokenBucketLimiter: a non-retryable failure does not trigger backoff', () => {
  const limiter = new TokenBucketLimiter(10, 5, 2);
  const delay = limiter.onFailure(false);
  assert.equal(delay, 0);
  assert.equal(limiter.status().retryAfterMs, 0);
});

test('TokenBucketLimiter: observeHeaders honours Retry-After and remaining/limit', () => {
  const limiter = new TokenBucketLimiter(10, 5, 2);
  const headers = new Headers({ 'retry-after': '2', 'x-ratelimit-remaining': '3' });
  limiter.observeHeaders(headers);
  const status = limiter.status();
  assert.equal(status.remaining, 3);
  assert.ok(status.retryAfterMs > 1000 && status.retryAfterMs <= 2000, `expected ~2s backoff, got ${status.retryAfterMs}`);
});

test('TokenBucketLimiter: status() never returns negative or NaN values', () => {
  const limiter = new TokenBucketLimiter(5, 1, 3);
  const s = limiter.status();
  assert.ok(Number.isFinite(s.retryAfterMs) && s.retryAfterMs >= 0);
  assert.ok(Number.isFinite(s.remaining ?? 0) && (s.remaining ?? 0) >= 0);
  assert.equal(s.concurrency, 3);
  assert.equal(s.limit, 5);
});
