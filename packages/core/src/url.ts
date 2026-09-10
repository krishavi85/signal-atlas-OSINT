/**
 * URL canonicalization for deduplication (§18) and SSRF-relevant parsing.
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  'ref_url', 'spm', 's_cid', 'yclid', '_ga', 'vero_id', 'oly_anon_id', 'oly_enc_id',
]);

export interface CanonicalUrl {
  canonical: string;
  host: string;
  registrableDomain: string;
}

/**
 * Produce a canonical form: lowercase scheme+host, strip default ports,
 * remove tracking params, sort remaining params, drop fragments, collapse
 * trailing slash. Returns null for unparseable input.
 */
export function canonicalizeUrl(input: string): CanonicalUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  u.hash = '';
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  const host = u.hostname;
  return {
    canonical: u.toString(),
    host,
    registrableDomain: registrableDomain(host),
  };
}

/**
 * Best-effort registrable-domain extraction without a full Public Suffix List.
 * Handles common multi-part TLDs; documented as approximate.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'co.nz', 'co.za', 'com.au', 'net.au',
  'org.au', 'com.br', 'com.mx', 'co.in', 'co.jp', 'com.sg', 'com.hk',
]);

export function registrableDomain(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** true when both URLs canonicalize to the same string. */
export function sameCanonicalUrl(a: string, b: string): boolean {
  const ca = canonicalizeUrl(a);
  const cb = canonicalizeUrl(b);
  return ca !== null && cb !== null && ca.canonical === cb.canonical;
}
