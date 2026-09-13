import { lookup } from 'node:dns/promises';
import { chromium, type Browser } from 'playwright';
import { validateOutboundUrl, isBlockedIPv4, isBlockedIPv6 } from '@osint/core';

/**
 * SSRF-guarded headless-browser page render, for JS-heavy pages a plain
 * fetch() can't see content on.
 *
 * Playwright makes its own network connections, entirely bypassing
 * services/api's safeFetch() (the guard every other outbound request in this
 * app goes through). This module replicates the same protection at the
 * browser layer rather than weakening it: the initial URL is validated
 * up front, and EVERY request the page makes while rendering — subresources,
 * redirects, XHR/fetch calls the page's own JS triggers — is intercepted and
 * re-validated (DNS-resolved, checked against the same private/loopback
 * blocklist as the rest of the app) before being allowed through. A page
 * can't pivot into an internal service via a redirect or an in-page request
 * any more than the plain-fetch path can.
 *
 * Deliberately narrow: this renders a page's own JS so its final content is
 * visible — it does not click, fill forms, log in, or otherwise interact
 * with the page. That would cross into automating access-controlled
 * surfaces, which this platform refuses to do (§30) regardless of what the
 * underlying tool is technically capable of.
 *
 * The DNS-based host check duplicates services/api/src/lib/safeFetch.ts's
 * assertHostAllowed(). That's intentional, not an oversight: this package
 * has no dependency on services/api (the reverse is true), and the two
 * mechanisms — a plain fetch vs. a real browser's network stack — can't
 * share one implementation. Keep both in sync if the blocklist logic changes.
 */

let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  if (!launching) {
    launching = chromium.launch({ headless: true }).then((b) => {
      sharedBrowser = b;
      return b;
    });
  }
  return launching;
}

/** Best-effort cleanup — callable at process shutdown; safe to skip in tests. */
export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    launching = null;
  }
}

async function hostIsAllowed(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every(({ address, family }) => {
      if (family === 4) return !isBlockedIPv4(address);
      if (family === 6) return !isBlockedIPv6(address);
      return true;
    });
  } catch {
    return false;
  }
}

export interface RenderResult {
  status: number;
  contentType: string | null;
  html: string;
  headers: Record<string, string>;
}

export interface RenderOptions {
  userAgent: string;
  timeoutMs?: number;
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  const initial = validateOutboundUrl(url);
  if (!initial.ok) throw new Error(`Outbound request refused: ${initial.reason} (${url})`);

  const timeoutMs = opts.timeoutMs ?? 25_000;
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: opts.userAgent, javaScriptEnabled: true });
  const page = await context.newPage();

  // Cache host-check results per navigation — the same host is requested
  // repeatedly for a typical page's subresources, and re-resolving DNS for
  // every image/script would be wasteful.
  const hostVerdicts = new Map<string, boolean>();

  await page.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    const check = validateOutboundUrl(reqUrl);
    if (!check.ok || !check.parsed) return route.abort('blockedbyclient');
    const host = check.parsed.hostname;
    let allowed = hostVerdicts.get(host);
    if (allowed === undefined) {
      allowed = await hostIsAllowed(host);
      hostVerdicts.set(host, allowed);
    }
    if (!allowed) return route.abort('blockedbyclient');
    return route.continue();
  });

  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    // Give in-page JS a brief window to finish populating dynamic content
    // beyond the load event, without holding the browser open indefinitely.
    await page.waitForTimeout(1200);

    const html = await page.content();
    const headers = response?.headers() ?? {};
    return {
      status: response?.status() ?? 0,
      contentType: headers['content-type'] ?? null,
      html,
      headers,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
