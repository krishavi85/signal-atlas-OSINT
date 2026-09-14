import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';
import { makeCache } from '../lib/cache.js';
import { logger } from '../logger.js';

/**
 * Corporate / registry OSINT (§31 Phase 11).
 *
 *  - SEC EDGAR: fully public US government registry, no key ever needed.
 *    Company identity comes from SEC's own ticker/CIK registry (exact
 *    registrant match, cached) rather than full-text search — a full-text
 *    hit only proves the name was *mentioned* in some filing, which isn't
 *    the same as "this is that company's own filing," and reporting it as
 *    such would be a false-precision result (§51). Full-text search is
 *    still used, but reported separately, as mentions.
 *  - OpenCorporates: now requires a registered API token for company search
 *    (verified live — anonymous search returns "Invalid Api Token"), so this
 *    is a real, typed capability gap without one.
 *  - Companies House (UK): official free API, but registration + a key are
 *    required (Basic Auth with the key as username).
 *  - USPTO: no stable, documented public JSON search-by-name API was found
 *    to integrate against honestly (TESS/TMSearch are session-driven web
 *    UIs, not a public API contract) — a search-link launcher into USPTO's
 *    own site is offered instead of guessing at an endpoint.
 */

export interface RegistryHit {
  registry: string;
  name: string;
  identifier: string | null;
  jurisdiction: string | null;
  url: string;
}

export interface CorporateLookupResult {
  query: string;
  secEdgar: { available: true; companies: RegistryHit[]; mentions: RegistryHit[] } | { available: false; reason: string };
  openCorporates: { available: true; hits: RegistryHit[] } | { available: false; reason: string };
  companiesHouse: { available: true; hits: RegistryHit[] } | { available: false; reason: string };
  usptoSearchUrl: string;
}

interface SecTicker {
  cik_str: number;
  ticker: string;
  title: string;
}

async function loadSecTickers(): Promise<SecTicker[]> {
  const cache = makeCache('sec-edgar-tickers');
  const cached = await cache.get('tickers');
  if (cached) return JSON.parse(cached) as SecTicker[];
  const res = await safeFetch('https://www.sec.gov/files/company_tickers.json', { timeoutMs: 10_000 });
  if (!res.ok) throw new Error(`SEC EDGAR ticker list HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, SecTicker>;
  const list = Object.values(body);
  await cache.set('tickers', JSON.stringify(list), 24 * 60 * 60);
  return list;
}

function edgarBrowseUrl(cik: number): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`;
}

async function searchSecEdgarCompanies(query: string): Promise<RegistryHit[]> {
  const tickers = await loadSecTickers();
  const q = query.toLowerCase();
  return tickers
    .filter((t) => t.title.toLowerCase().includes(q) || t.ticker.toLowerCase() === q)
    .slice(0, 10)
    .map((t) => ({ registry: 'SEC EDGAR', name: t.title, identifier: `CIK ${t.cik_str} · ${t.ticker}`, jurisdiction: 'US', url: edgarBrowseUrl(t.cik_str) }));
}

async function searchSecEdgarMentions(query: string): Promise<RegistryHit[]> {
  const res = await safeFetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${query}"`)}`, { timeoutMs: 10_000 });
  if (!res.ok) throw new Error(`SEC EDGAR full-text search HTTP ${res.status}`);
  const body = (await res.json()) as {
    hits?: { hits?: Array<{ _source: { display_names?: string[]; ciks?: string[]; adsh?: string } }> };
  };
  const rows = body.hits?.hits ?? [];
  const seen = new Set<string>();
  const hits: RegistryHit[] = [];
  for (const row of rows) {
    const cik = row._source.ciks?.[0];
    const name = row._source.display_names?.[0] ?? query;
    const key = `${cik}:${name}`;
    if (!cik || seen.has(key)) continue;
    seen.add(key);
    const accessionNoDashes = row._source.adsh?.replace(/-/g, '');
    const url = accessionNoDashes
      ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${row._source.adsh}-index.htm`
      : edgarBrowseUrl(Number(cik));
    hits.push({ registry: 'SEC EDGAR (mention)', name, identifier: `CIK ${cik}`, jurisdiction: 'US', url });
    if (hits.length >= 10) break;
  }
  return hits;
}

async function searchSecEdgar(query: string): Promise<CorporateLookupResult['secEdgar']> {
  try {
    const [companies, mentions] = await Promise.all([searchSecEdgarCompanies(query), searchSecEdgarMentions(query).catch(() => [])]);
    return { available: true, companies, mentions };
  } catch (err) {
    logger.warn({ err }, 'SEC EDGAR search failed');
    return { available: false, reason: (err as Error).message };
  }
}

async function searchOpenCorporates(query: string): Promise<CorporateLookupResult['openCorporates']> {
  const env = loadEnv();
  if (!env.OPENCORPORATES_API_KEY) {
    return { available: false, reason: 'OPENCORPORATES_API_KEY not configured — OpenCorporates now requires a registered API token for company search.' };
  }
  try {
    const res = await safeFetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=10&api_token=${encodeURIComponent(env.OPENCORPORATES_API_KEY)}`,
      { timeoutMs: 10_000 },
    );
    const body = (await res.json()) as {
      results?: { companies?: Array<{ company: { name: string; company_number: string; jurisdiction_code: string; opencorporates_url: string } }> };
      error?: { message?: string };
    };
    if (!res.ok) return { available: false, reason: body.error?.message ?? `OpenCorporates HTTP ${res.status}` };
    const hits: RegistryHit[] = (body.results?.companies ?? []).map(({ company: c }) => ({
      registry: 'OpenCorporates',
      name: c.name,
      identifier: c.company_number,
      jurisdiction: c.jurisdiction_code,
      url: c.opencorporates_url,
    }));
    return { available: true, hits };
  } catch (err) {
    logger.warn({ err }, 'OpenCorporates search failed');
    return { available: false, reason: (err as Error).message };
  }
}

async function searchCompaniesHouse(query: string): Promise<CorporateLookupResult['companiesHouse']> {
  const env = loadEnv();
  if (!env.COMPANIES_HOUSE_API_KEY) {
    return {
      available: false,
      reason: 'COMPANIES_HOUSE_API_KEY not configured — free key at developer.company-information.service.gov.uk.',
    };
  }
  try {
    const res = await safeFetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=10`, {
      timeoutMs: 10_000,
      headers: { authorization: `Basic ${Buffer.from(`${env.COMPANIES_HOUSE_API_KEY}:`).toString('base64')}` },
    });
    if (!res.ok) return { available: false, reason: `Companies House HTTP ${res.status}` };
    const body = (await res.json()) as { items?: Array<{ title: string; company_number: string; address_snippet?: string }> };
    const hits: RegistryHit[] = (body.items ?? []).map((c) => ({
      registry: 'Companies House',
      name: c.title,
      identifier: c.company_number,
      jurisdiction: 'GB',
      url: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
    }));
    return { available: true, hits };
  } catch (err) {
    logger.warn({ err }, 'Companies House search failed');
    return { available: false, reason: (err as Error).message };
  }
}

export async function lookupCompany(query: string): Promise<CorporateLookupResult> {
  const [secEdgar, openCorporates, companiesHouse] = await Promise.all([
    searchSecEdgar(query),
    searchOpenCorporates(query),
    searchCompaniesHouse(query),
  ]);
  return {
    query,
    secEdgar,
    openCorporates,
    companiesHouse,
    // No stable, documented query-string contract for pre-filling a search
    // was confirmed, so this links to USPTO's own trademark search tool
    // rather than guessing at a param name that might silently not work.
    usptoSearchUrl: 'https://tmsearch.uspto.gov/',
  };
}
