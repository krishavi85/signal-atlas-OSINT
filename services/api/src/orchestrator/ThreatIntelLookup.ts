import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';
import { logger } from '../logger.js';
import type { LookupAvailability } from '../lib/lookupTypes.js';

/**
 * Threat intelligence (§31 Phase 11).
 *
 *  - VirusTotal v3 requires an API key even on the free tier.
 *  - URLScan.io's *search* of already-submitted scans is keyless (verified
 *    live); only submitting a brand-new scan needs a key, and this module
 *    only searches — it never submits a target's URL to a third party
 *    without that being an explicit, separate opt-in action.
 *  - AlienVault OTX requires a free API key.
 */

export interface UrlScanHit {
  url: string;
  domain: string;
  scanDate: string;
  reportUrl: string;
}

export async function urlscanSearch(query: string): Promise<LookupAvailability<UrlScanHit[]>> {
  try {
    const res = await safeFetch(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=10`, { timeoutMs: 12_000 });
    if (!res.ok) return { available: false, reason: `URLScan.io HTTP ${res.status}` };
    const body = (await res.json()) as { results?: Array<{ page: { url: string; domain: string }; task: { time: string; uuid: string } }> };
    return {
      available: true,
      data: (body.results ?? []).map((r) => ({
        url: r.page.url,
        domain: r.page.domain,
        scanDate: r.task.time,
        reportUrl: `https://urlscan.io/result/${r.task.uuid}/`,
      })),
    };
  } catch (err) {
    logger.warn({ err }, 'URLScan.io search failed');
    return { available: false, reason: (err as Error).message };
  }
}

export interface VirusTotalSummary {
  type: 'domain' | 'ip_address' | 'file' | 'url';
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  reportUrl: string;
}

function vtEndpoint(target: string, type: VirusTotalSummary['type']): string {
  switch (type) {
    case 'domain':
      return `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(target)}`;
    case 'ip_address':
      return `https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(target)}`;
    case 'file':
      return `https://www.virustotal.com/api/v3/files/${encodeURIComponent(target)}`;
    case 'url':
      return `https://www.virustotal.com/api/v3/urls/${Buffer.from(target).toString('base64url')}`;
  }
}

function vtGuiUrl(target: string, type: VirusTotalSummary['type']): string {
  const kind = type === 'ip_address' ? 'ip-address' : type;
  return `https://www.virustotal.com/gui/${kind}/${encodeURIComponent(target)}`;
}

export async function virusTotalLookup(target: string, type: VirusTotalSummary['type']): Promise<LookupAvailability<VirusTotalSummary>> {
  const env = loadEnv();
  if (!env.VIRUSTOTAL_API_KEY) {
    return { available: false, reason: 'VIRUSTOTAL_API_KEY not configured — free tier key at virustotal.com/gui/join-us.' };
  }
  try {
    const res = await safeFetch(vtEndpoint(target, type), { timeoutMs: 12_000, headers: { 'x-apikey': env.VIRUSTOTAL_API_KEY } });
    if (!res.ok) return { available: false, reason: `VirusTotal HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { attributes?: { last_analysis_stats?: Record<string, number> } } };
    const stats = body.data?.attributes?.last_analysis_stats ?? {};
    return {
      available: true,
      data: {
        type,
        malicious: stats.malicious ?? 0,
        suspicious: stats.suspicious ?? 0,
        harmless: stats.harmless ?? 0,
        undetected: stats.undetected ?? 0,
        reportUrl: vtGuiUrl(target, type),
      },
    };
  } catch (err) {
    logger.warn({ err }, 'VirusTotal lookup failed');
    return { available: false, reason: (err as Error).message };
  }
}

export interface OtxPulseHit {
  name: string;
  id: string;
  malwareFamilies: string[];
  reportUrl: string;
}

export async function otxLookup(indicator: string, type: 'domain' | 'IPv4' | 'hostname'): Promise<LookupAvailability<OtxPulseHit[]>> {
  const env = loadEnv();
  if (!env.OTX_API_KEY) {
    return { available: false, reason: 'OTX_API_KEY not configured — free account at otx.alienvault.com.' };
  }
  try {
    const res = await safeFetch(`https://otx.alienvault.com/api/v1/indicators/${type}/${encodeURIComponent(indicator)}/general`, {
      timeoutMs: 12_000,
      headers: { 'x-otx-api-key': env.OTX_API_KEY },
    });
    if (!res.ok) return { available: false, reason: `OTX HTTP ${res.status}` };
    const body = (await res.json()) as { pulse_info?: { pulses?: Array<{ name: string; id: string; malware_families?: string[] }> } };
    return {
      available: true,
      data: (body.pulse_info?.pulses ?? []).map((p) => ({
        name: p.name,
        id: p.id,
        malwareFamilies: p.malware_families ?? [],
        reportUrl: `https://otx.alienvault.com/pulse/${p.id}`,
      })),
    };
  } catch (err) {
    logger.warn({ err }, 'OTX lookup failed');
    return { available: false, reason: (err as Error).message };
  }
}
