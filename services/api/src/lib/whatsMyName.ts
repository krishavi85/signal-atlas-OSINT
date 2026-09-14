import { z } from 'zod';
import { safeFetch } from './safeFetch.js';
import { makeCache } from './cache.js';
import { logger } from '../logger.js';

/**
 * WhatsMyName (https://github.com/WebBreacher/WhatsMyName) publishes a
 * community-maintained, CC-BY-SA dataset describing how to check whether a
 * username exists on ~700 public sites: a profile-URL template, the
 * HTTP status/body substring expected when it exists, and the status/body
 * substring expected when it doesn't. We fetch that public JSON file
 * ourselves and run the checks — no Sherlock/Maigret binary, no scraping of
 * anything beyond the same single public profile URL a browser would load.
 *
 * Cached in the DB-backed response cache (§39) so a scan doesn't refetch a
 * ~250KB file it already has, and so the platform still works offline
 * against the last-known dataset. The cache row is stored with a long TTL
 * (30 days — just a cleanup horizon, not a correctness signal: the generic
 * cache helper deletes a row outright once it's past TTL, which would
 * defeat a "prefer fresh, fall back to stale" policy) and freshness is
 * instead judged from the `fetchedAt` timestamp stored inside the payload.
 */
const DATASET_URL = 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json';
const FRESH_FOR_MS = 24 * 60 * 60 * 1000;
const CACHE_ROW_TTL_SECONDS = 30 * 24 * 60 * 60;
const NSFW_CATEGORY = 'xx NSFW xx';

const SiteSchema = z
  .object({
    name: z.string().min(1),
    uri_check: z.string().min(1),
    uri_pretty: z.string().optional(),
    e_code: z.number(),
    e_string: z.string().default(''),
    m_code: z.number(),
    m_string: z.string().default(''),
    cat: z.string().optional(),
    post_body: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    strip_bad_char: z.string().optional(),
    protection: z.array(z.string()).optional(),
  })
  .passthrough();

const DatasetSchema = z.object({
  license: z.unknown().optional(),
  categories: z.array(z.string()).optional(),
  sites: z.array(z.unknown()),
});

export interface IdentitySite {
  name: string;
  uriCheck: string;
  uriPretty: string;
  eCode: number;
  eString: string;
  mCode: number;
  mString: string;
  category: string | null;
  postBody: string | null;
  headers: Record<string, string> | null;
  stripBadChar: string | null;
  protection: string[];
}

export interface IdentityDataset {
  source: string;
  fetchedAt: string;
  sites: IdentitySite[];
  skipped: number;
}

const CACHE_KEY = 'whatsmyname:dataset';

function toSite(raw: z.infer<typeof SiteSchema>): IdentitySite {
  return {
    name: raw.name,
    uriCheck: raw.uri_check,
    uriPretty: raw.uri_pretty ?? raw.uri_check,
    eCode: raw.e_code,
    eString: raw.e_string,
    mCode: raw.m_code,
    mString: raw.m_string,
    category: raw.cat ?? null,
    postBody: raw.post_body ?? null,
    headers: raw.headers ?? null,
    stripBadChar: raw.strip_bad_char ?? null,
    protection: raw.protection ?? [],
  };
}

async function fetchDataset(): Promise<IdentityDataset> {
  const res = await safeFetch(DATASET_URL, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  if (!res.ok) throw new Error(`WhatsMyName dataset fetch failed: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const parsed = DatasetSchema.parse(json);

  const sites: IdentitySite[] = [];
  let skipped = 0;
  for (const rawSite of parsed.sites) {
    const result = SiteSchema.safeParse(rawSite);
    if (!result.success) {
      skipped += 1;
      continue;
    }
    sites.push(toSite(result.data));
  }
  return { source: DATASET_URL, fetchedAt: new Date().toISOString(), sites, skipped };
}

/**
 * Loads the dataset: a cached copy less than 24h old is returned without
 * touching the network at all; an older (or missing) copy triggers a fresh
 * fetch; if that fetch fails, a stale cached copy is used anyway (with a
 * warning) rather than failing the whole scan over a transient GitHub
 * hiccup. Only a cold cache with no network is a real, typed capability gap.
 */
export async function loadIdentityDataset(opts: { refresh?: boolean } = {}): Promise<IdentityDataset> {
  const c = makeCache('whatsmyname');
  const cachedRaw = opts.refresh ? null : await c.get(CACHE_KEY);
  const cached = cachedRaw ? (JSON.parse(cachedRaw) as IdentityDataset) : null;
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FRESH_FOR_MS) return cached;

  try {
    const dataset = await fetchDataset();
    await c.set(CACHE_KEY, JSON.stringify(dataset), CACHE_ROW_TTL_SECONDS);
    return dataset;
  } catch (err) {
    if (cached) {
      logger.warn({ err, fetchedAt: cached.fetchedAt }, 'WhatsMyName dataset refresh failed; using stale cached copy');
      return cached;
    }
    throw new Error(`Username-enumeration dataset unavailable (no network + no cached copy): ${(err as Error).message}`);
  }
}

export function filterSites(sites: IdentitySite[], opts: { includeNsfw?: boolean; categories?: string[] } = {}): IdentitySite[] {
  return sites.filter((s) => {
    if (!opts.includeNsfw && s.category === NSFW_CATEGORY) return false;
    if (opts.categories && opts.categories.length > 0 && (!s.category || !opts.categories.includes(s.category))) return false;
    return true;
  });
}
