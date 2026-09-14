import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { buildDorkQueries, buildSearchEngineLinks } from '@osint/core';
import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';
import { logger } from '../logger.js';

/**
 * Phone OSINT (§31 Phase 11). Number parsing/validation/type is fully
 * offline (libphonenumber-js's Google-derived metadata) — real, but a
 * number's *type* (mobile/fixed/VOIP) can be stale the moment a number is
 * ported, so it's reported as "declared type," not a live carrier lookup.
 * Live carrier/line-type/location needs numverify (optional key, free
 * tier) — without it that piece is a named capability gap, not guessed at.
 */

export interface PhoneLookupResult {
  input: string;
  valid: boolean;
  possible: boolean;
  e164: string | null;
  international: string | null;
  national: string | null;
  country: string | null;
  countryCallingCode: string | null;
  declaredType: string | null;
  carrierLookup:
    | { available: true; carrier: string | null; lineType: string | null; location: string | null }
    | { available: false; reason: string };
  dorkQueries: Array<{ label: string; query: string; links: ReturnType<typeof buildSearchEngineLinks> }>;
}

async function numverifyLookup(e164: string): Promise<PhoneLookupResult['carrierLookup']> {
  const env = loadEnv();
  if (!env.NUMVERIFY_API_KEY) {
    return { available: false, reason: 'NUMVERIFY_API_KEY not configured — set it for live carrier/line-type/location lookup (free tier at numverify.com).' };
  }
  try {
    const res = await safeFetch(
      `http://apilayer.net/api/validate?access_key=${encodeURIComponent(env.NUMVERIFY_API_KEY)}&number=${encodeURIComponent(e164)}`,
      { timeoutMs: 10_000 },
    );
    if (!res.ok) return { available: false, reason: `numverify HTTP ${res.status}` };
    const body = (await res.json()) as { carrier?: string; line_type?: string; location?: string; success?: boolean; error?: { info?: string } };
    if (body.success === false) return { available: false, reason: body.error?.info ?? 'numverify request failed' };
    return { available: true, carrier: body.carrier || null, lineType: body.line_type || null, location: body.location || null };
  } catch (err) {
    logger.warn({ err }, 'numverify lookup failed');
    return { available: false, reason: (err as Error).message };
  }
}

export async function lookupPhoneNumber(input: string, defaultCountry?: string): Promise<PhoneLookupResult> {
  const parsed = parsePhoneNumberFromString(input, defaultCountry as CountryCode | undefined);
  const e164 = parsed?.number ?? null;

  const dorkQueries = buildDorkQueries('phone', e164 ?? input).map((q) => ({ ...q, links: buildSearchEngineLinks(q.query) }));

  return {
    input,
    valid: parsed?.isValid() ?? false,
    possible: parsed?.isPossible() ?? false,
    e164,
    international: parsed?.formatInternational() ?? null,
    national: parsed?.formatNational() ?? null,
    country: parsed?.country ?? null,
    countryCallingCode: parsed ? `+${parsed.countryCallingCode}` : null,
    declaredType: parsed?.getType() ?? null,
    carrierLookup: e164 && parsed?.isValid() ? await numverifyLookup(e164) : { available: false, reason: 'Number is not valid enough to look up.' },
    dorkQueries,
  };
}
