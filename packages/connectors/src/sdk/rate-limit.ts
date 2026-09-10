import type { RateLimitStatus } from './types.js';

/**
 * Token-bucket rate limiter with exponential backoff + jitter (§38).
 * Per-connector instance. Never used to defeat a provider limit — only to keep
 * the platform's own request rate polite and below documented ceilings.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private consecutiveFailures = 0;
  private retryAfterUntil = 0;
  private remaining: number | null = null;
  private resetAt: number | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    public readonly concurrency = 2,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Wait until a token is available and the backoff window has passed. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      this.refill();
      const now = Date.now();
      const backoffWait = Math.max(0, this.retryAfterUntil - now);
      if (backoffWait === 0 && this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const tokenWait = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.refillPerSecond) * 1000;
      const wait = Math.max(backoffWait, tokenWait, 25);
      await sleep(Math.min(wait, 30_000), signal);
    }
  }

  /** Feed provider rate-limit headers back in. */
  observeHeaders(headers: Headers): void {
    const remaining =
      headers.get('x-ratelimit-remaining') ??
      headers.get('ratelimit-remaining') ??
      headers.get('x-rate-limit-remaining');
    const reset =
      headers.get('x-ratelimit-reset') ??
      headers.get('ratelimit-reset') ??
      headers.get('x-rate-limit-reset');
    const retryAfter = headers.get('retry-after');

    if (remaining !== null) this.remaining = Number(remaining);
    if (reset !== null) {
      const n = Number(reset);
      // reset may be epoch seconds or delta seconds
      this.resetAt = n > 1_000_000_000 ? n * 1000 : Date.now() + n * 1000;
    }
    if (retryAfter !== null) {
      const n = Number(retryAfter);
      const ms = Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      this.retryAfterUntil = Date.now() + ms;
    }
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Register a failure; returns the backoff delay applied (ms). */
  onFailure(retryable: boolean): number {
    if (!retryable) return 0;
    this.consecutiveFailures += 1;
    const base = Math.min(60_000, 500 * 2 ** (this.consecutiveFailures - 1));
    const jitter = Math.random() * base * 0.3;
    const delay = base + jitter;
    this.retryAfterUntil = Math.max(this.retryAfterUntil, Date.now() + delay);
    return delay;
  }

  status(): RateLimitStatus {
    this.refill();
    return {
      limit: this.capacity,
      remaining: this.remaining ?? Math.floor(this.tokens),
      resetAt: this.resetAt,
      retryAfterMs: Math.max(0, this.retryAfterUntil - Date.now()),
      concurrency: this.concurrency,
    };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
