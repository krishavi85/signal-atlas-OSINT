import { lookup } from 'node:dns/promises';
import { validateOutboundUrl, isBlockedIPv4, isBlockedIPv6 } from '@osint/core';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';

/**
 * SSRF-guarded fetch (§40).
 *
 *  1. URL-shape validation (scheme, credentials, literal private IPs) via core.
 *  2. DNS resolution + per-address block check (defeats DNS-rebinding to
 *     private ranges).
 *  3. Manual redirect handling: every hop re-validated.
 *  4. Timeout + response size cap.
 *
 * NOTE: Node's fetch does not let us pin the resolved IP for the actual
 * connection, so a determined attacker controlling DNS could still rebind
 * between our check and the request. For untrusted targets this is acceptable
 * given the other guards; a hardened deployment should route outbound fetches
 * through an egress proxy with an allowlist.
 */

const MAX_REDIRECTS = 5;
const MAX_BYTES = 8 * 1024 * 1024;

export interface SafeFetchInit extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for ${host}: ${(err as Error).message}`);
  }
  if (addrs.length === 0) throw new Error(`No DNS records for ${host}`);
  for (const { address, family } of addrs) {
    if (family === 4 && isBlockedIPv4(address)) {
      throw new Error(`Blocked: ${host} resolves to private/reserved IPv4 ${address}`);
    }
    if (family === 6 && isBlockedIPv6(address)) {
      throw new Error(`Blocked: ${host} resolves to private/reserved IPv6 ${address}`);
    }
  }
}

export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const env = loadEnv();
  const timeoutMs = init.timeoutMs ?? 20_000;
  const maxBytes = init.maxBytes ?? MAX_BYTES;
  let current = url;
  let redirects = 0;

  for (;;) {
    const check = validateOutboundUrl(current);
    if (!check.ok || !check.parsed) throw new Error(`Outbound request refused: ${check.reason} (${current})`);
    await assertHostAllowed(check.parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const upstreamSignal = init.signal;
    if (upstreamSignal) upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      res = await fetch(check.parsed, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': env.HTTP_USER_AGENT,
          ...(env.HTTP_CONTACT_EMAIL ? { from: env.HTTP_CONTACT_EMAIL } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error(`Too many redirects (${current})`);
      const next = new URL(res.headers.get('location')!, check.parsed).toString();
      logger.debug({ from: current, to: next }, 'safeFetch redirect');
      current = next;
      continue;
    }

    // enforce size cap
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) throw new Error(`Response too large: ${len} bytes > ${maxBytes}`);

    return res;
  }
}
