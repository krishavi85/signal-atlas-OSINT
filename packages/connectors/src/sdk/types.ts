import type { NormalizedResult } from '@osint/core';
import type { CapabilityReport, CapabilityGap } from './capabilities.js';

/** Health states per §32. */
export type ConnectorHealthState =
  | 'ONLINE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'MISCONFIGURED'
  | 'NOT_CONFIGURED';

export interface ConnectorHealth {
  state: ConnectorHealthState;
  checkedAt: string;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** requests remaining in the current window, if the provider reports it */
  requestsRemaining: number | null;
  message: string;
}

export interface RateLimitStatus {
  /** requests permitted per window */
  limit: number | null;
  remaining: number | null;
  /** epoch ms when the window resets */
  resetAt: number | null;
  /** current recommended delay before next call (backoff), ms */
  retryAfterMs: number;
  concurrency: number;
}

/** Runtime configuration handed to a connector at construction. */
export interface ConnectorContext {
  /** resolved secrets/keys for THIS connector only (never logged) */
  config: Record<string, string | undefined>;
  userAgent: string;
  contactEmail?: string;
  /** structured logger scoped to the connector */
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** SSRF-guarded fetch (validates URL, pins DNS, blocks private ranges) */
  safeFetch: (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;
  /** shared response cache (§39) */
  cache?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  };
  /** persistent per-connector daily request budget (§38), distinct from the in-process token bucket */
  budget?: {
    consume: (maxPerDay: number) => Promise<{ allowed: boolean; remaining: number; resetAt: string }>;
  };
  signal?: AbortSignal;
}

export interface SearchParams {
  /** the exact query string to run (already expanded/planned by the orchestrator) */
  query: string;
  limit: number;
  /** ISO dates */
  dateAfter?: string | null;
  dateBefore?: string | null;
  language?: string | null;
  /** connector-specific hints, e.g. subreddit, feed URL, channel id */
  scope?: Record<string, string>;
  page?: number;
}

/** A raw hit before normalization — connector-shaped. */
export interface RawHit {
  /** stable-ish id within the provider */
  externalId: string;
  url: string | null;
  raw: unknown;
}

export interface FetchParams {
  url: string;
}

export interface RawDocument {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  headers: Record<string, string>;
  fetchedAt: string;
}

export interface SearchOutcome {
  hits: RawHit[];
  /** provider-reported total, if any */
  totalAvailable: number | null;
  /** true when the provider signalled more pages */
  hasMore: boolean;
  /** non-fatal issues (e.g. "date filter ignored: unsupported") */
  notices: string[];
}

/**
 * The connector contract (§3). Every connector implements this. Methods that a
 * connector cannot support throw `ConnectorUnsupportedError` and the
 * corresponding capability flag is false.
 */
export interface Connector {
  readonly id: string;
  readonly displayName: string;

  /** static + config-aware capability report (§31) */
  capabilities(): CapabilityReport;

  /** discover items matching a query */
  search(params: SearchParams, ctx: ConnectorContext): Promise<SearchOutcome>;

  /** retrieve one document (e.g. a user-supplied URL) */
  fetch(params: FetchParams, ctx: ConnectorContext): Promise<RawDocument>;

  /** parse a raw hit or document into an intermediate structure */
  parse(input: RawHit | RawDocument, ctx: ConnectorContext): Promise<unknown>;

  /** produce the connector-agnostic normalized result (§ evidence model) */
  normalize(parsed: unknown, params: { discoveryQuery: string }, ctx: ConnectorContext): Promise<NormalizedResult>;

  /** liveness + auth + latency probe (§32) */
  healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth>;

  /** current rate-limit picture (§38) */
  rateLimitStatus(): RateLimitStatus;
}

export class ConnectorUnsupportedError extends Error {
  constructor(
    public connectorId: string,
    public operation: string,
    public gap?: CapabilityGap,
  ) {
    super(`Connector "${connectorId}" does not support operation "${operation}"${gap ? `: ${gap.message}` : ''}`);
    this.name = 'ConnectorUnsupportedError';
  }
}

export class ConnectorRequestError extends Error {
  constructor(
    public connectorId: string,
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
    this.name = 'ConnectorRequestError';
  }
}
