import { classifyIdentityCheck, fillIdentityTemplate } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { safeFetch } from '../lib/safeFetch.js';
import { filterSites, loadIdentityDataset, type IdentitySite } from '../lib/whatsMyName.js';

/**
 * Username / identity enumeration (§31) — WhatsMyName-style existence
 * checks. For each candidate site we make exactly one HTTP request to the
 * same public profile URL a browser would load (GET, or the site's declared
 * POST body for the handful of sites that check via an API endpoint), and
 * classify FOUND/NOT_FOUND/UNKNOWN from the response. No login, no CAPTCHA
 * solving, no content scraping beyond that single response — the same
 * technique Sherlock/Maigret/WhatsMyName itself use.
 *
 * Sites flagged in the dataset with `protection` (e.g. Cloudflare, a
 * CAPTCHA challenge page) often return a challenge page instead of the real
 * profile response; those results are still reported, but tagged so the UI
 * can caveat them rather than presenting them as equally reliable (§51).
 */

const CONCURRENCY = 12;
const PER_CHECK_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 512 * 1024; // only need to substring-search it, not store it

export interface IdentityScanProgress {
  totalChecked: number;
  totalSites: number;
  foundCount: number;
}

async function checkOneSite(site: IdentitySite, username: string): Promise<{
  status: 'FOUND' | 'NOT_FOUND' | 'UNKNOWN' | 'ERROR';
  httpStatus: number | null;
  error: string | null;
}> {
  const url = fillIdentityTemplate(site.uriCheck, username, site.stripBadChar ?? undefined);
  try {
    const res = await safeFetch(url, {
      method: site.postBody ? 'POST' : 'GET',
      timeoutMs: PER_CHECK_TIMEOUT_MS,
      maxBytes: MAX_BODY_BYTES,
      headers: site.headers ?? undefined,
      body: site.postBody ? fillIdentityTemplate(site.postBody, username, site.stripBadChar ?? undefined) : undefined,
    });
    const body = await res.text();
    const outcome = classifyIdentityCheck(res.status, body, {
      eCode: site.eCode,
      eString: site.eString,
      mCode: site.mCode,
      mString: site.mString,
    });
    return { status: outcome, httpStatus: res.status, error: null };
  } catch (err) {
    return { status: 'ERROR', httpStatus: null, error: (err as Error).message };
  }
}

export async function runIdentityScan(
  scanId: string,
  onProgress?: (p: IdentityScanProgress) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ totalChecked: number; foundCount: number }> {
  const scan = await prisma.identityScan.findUniqueOrThrow({ where: { id: scanId } });
  await prisma.identityScan.update({ where: { id: scanId }, data: { status: 'RUNNING', startedAt: new Date() } });

  const dataset = await loadIdentityDataset();
  const sites = filterSites(dataset.sites, { includeNsfw: false });
  await prisma.identityScan.update({ where: { id: scanId }, data: { totalChecked: 0, datasetSource: `${dataset.source} (${sites.length} sites)` } });

  let checked = 0;
  let found = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= sites.length) return;
      const site = sites[i];
      if (!site) continue;
      const result = await checkOneSite(site, scan.username);
      checked += 1;
      if (result.status === 'FOUND') found += 1;

      await prisma.identityScanResult.create({
        data: {
          scanId,
          platform: site.name,
          category: site.category,
          url: fillIdentityTemplate(site.uriPretty, scan.username, site.stripBadChar ?? undefined),
          status: result.status,
          httpStatus: result.httpStatus,
          protection: site.protection.length ? site.protection.join(', ') : null,
          error: result.error,
        },
      });

      if (checked % 20 === 0 || checked === sites.length) {
        // Keep the scan row itself live, not just the job's progress event —
        // the UI's scan-history list polls this row directly and shouldn't
        // sit at "0/0" for the whole run.
        await prisma.identityScan.update({ where: { id: scanId }, data: { totalChecked: checked, foundCount: found } }).catch(() => {});
        await onProgress?.({ totalChecked: checked, totalSites: sites.length, foundCount: found });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));

  const finalStatus = signal?.aborted ? 'FAILED' : 'COMPLETED';
  await prisma.identityScan.update({
    where: { id: scanId },
    data: { status: finalStatus, totalChecked: checked, foundCount: found, completedAt: new Date() },
  });

  logger.info({ scanId, username: scan.username, checked, found }, 'identity scan finished');
  return { totalChecked: checked, foundCount: found };
}
