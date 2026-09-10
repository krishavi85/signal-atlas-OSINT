import { isIP } from 'node:net';

/**
 * SSRF protection for outbound fetches (§40).
 *
 * Policy:
 *  - scheme allowlist: http, https only
 *  - block credentials in URL
 *  - block literal IPs in private / loopback / link-local / CGNAT / reserved ranges
 *  - hostnames must still be re-checked AFTER DNS resolution by the fetch layer
 *    (see services/api/src/lib/safeFetch.ts) — this module validates the URL
 *    shape and literal-IP cases synchronously.
 */

export interface UrlPolicyResult {
  ok: boolean;
  reason?: string;
  parsed?: URL;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

export function validateOutboundUrl(input: string): UrlPolicyResult {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: 'Unparseable URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Scheme ${u.protocol} not allowed` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'Credentials in URL not allowed' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `Hostname ${host} is blocked` };
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4 && isBlockedIPv4(host)) {
    return { ok: false, reason: `IPv4 ${host} is in a blocked range` };
  }
  if (ipVersion === 6 && isBlockedIPv6(host)) {
    return { ok: false, reason: `IPv6 ${host} is in a blocked range` };
  }
  // `.internal` / `.local` / bare single-label hosts are suspicious for SSRF.
  if (!host.includes('.') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: `Non-public hostname ${host}` };
  }
  return { ok: true, parsed: u };
}

export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — validate the embedded v4
    const v4 = lower.split(':').pop() ?? '';
    if (v4.includes('.')) return isBlockedIPv4(v4);
  }
  if (lower.startsWith('2001:db8:')) return true; // documentation
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}
