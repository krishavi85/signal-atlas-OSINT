/**
 * Search-engine dork / reverse-image-search link generation (§31 dork
 * toolkit). Pure string building — no network, no execution. The platform
 * hands the analyst a set of pre-built queries/links to open themselves;
 * it never runs a scraped "dork engine" against Google/Bing on their
 * behalf (that would mean automating queries against a search engine's own
 * UI, which their ToS prohibit — see the SearXNG/Brave/Google-CSE connectors
 * for the lawful, API-based equivalent of actually running a search).
 */

export type DorkTargetType = 'domain' | 'email' | 'phone' | 'username' | 'generic';

export interface SearchEngineLink {
  engine: string;
  url: string;
}

const ENGINES: Array<{ engine: string; build: (q: string) => string }> = [
  { engine: 'Google', build: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { engine: 'Bing', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { engine: 'DuckDuckGo', build: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { engine: 'Yandex', build: (q) => `https://yandex.com/search/?text=${encodeURIComponent(q)}` },
];

/** One dork query string, plus which engines it's meaningful on ('all' unless noted). */
export interface DorkQuery {
  label: string;
  query: string;
}

/**
 * Builds a set of labelled dork queries for a target type. `value` should
 * already be the raw identifier (a domain, an email, a phone number in
 * whatever format the caller wants searched, or a username) — quoting and
 * operator syntax is added here.
 */
export function buildDorkQueries(targetType: DorkTargetType, value: string): DorkQuery[] {
  const v = value.trim();
  if (!v) return [];
  switch (targetType) {
    case 'domain':
      return [
        { label: 'All indexed pages', query: `site:${v}` },
        { label: 'Documents (PDF/DOC/XLS)', query: `site:${v} (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xls OR filetype:xlsx)` },
        { label: 'Exposed directory listings', query: `site:${v} intitle:"index of"` },
        { label: 'Login/admin surfaces', query: `site:${v} (inurl:login OR inurl:admin OR inurl:portal)` },
        { label: 'Mentioned elsewhere on the web', query: `"${v}" -site:${v}` },
      ];
    case 'email':
      return [
        { label: 'Exact mentions', query: `"${v}"` },
        { label: 'On paste sites', query: `"${v}" (site:pastebin.com OR site:ghostbin.com)` },
        { label: 'In documents', query: `"${v}" (filetype:pdf OR filetype:xls OR filetype:doc)` },
      ];
    case 'phone':
      return [
        { label: 'Exact mentions', query: `"${v}"` },
        { label: 'Classifieds / listings', query: `"${v}" (site:craigslist.org OR intitle:"for sale")` },
      ];
    case 'username':
      return [
        { label: 'Exact mentions', query: `"${v}"` },
        { label: 'Profile-style pages', query: `intitle:"${v}" (profile OR user)` },
        { label: 'On paste/forum sites', query: `"${v}" (site:pastebin.com OR site:reddit.com OR site:forum.com)` },
      ];
    case 'generic':
    default:
      return [{ label: 'Exact phrase', query: `"${v}"` }];
  }
}

export function buildSearchEngineLinks(query: string): SearchEngineLink[] {
  return ENGINES.map(({ engine, build }) => ({ engine, url: build(query) }));
}

/**
 * Reverse-image-search launcher links: given a publicly reachable image URL,
 * build the deep link each engine's own "search by image URL" feature
 * accepts. These open the *engine's own* UI — nothing is fetched, parsed, or
 * matched by this platform. Bing's exact query-param contract isn't
 * officially documented for third-party use and has drifted before; if it
 * stops prefilling, the link still lands on Bing's image search itself.
 */
export function buildReverseImageSearchLinks(imageUrl: string): SearchEngineLink[] {
  const u = encodeURIComponent(imageUrl);
  return [
    { engine: 'Google Lens', url: `https://lens.google.com/uploadbyurl?url=${u}` },
    { engine: 'Yandex Images', url: `https://yandex.com/images/search?rpt=imageview&url=${u}` },
    { engine: 'Bing Visual Search', url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIIRP&sbisrc=UrlPaste&q=imgurl:${u}` },
    { engine: 'TinEye', url: `https://tineye.com/search?url=${u}` },
  ];
}

/**
 * PimEyes has no URL-based deep link — it only accepts an uploaded file
 * through its own UI. This is a launcher to that upload page, not a search
 * result; face-matching itself is never performed by this platform (§19,
 * §30 — see docs/LEGAL.md).
 */
export function pimEyesLauncher(): SearchEngineLink {
  return { engine: 'PimEyes (manual upload required)', url: 'https://pimeyes.com/en' };
}

/**
 * Ahmia (ahmia.fi) is a clearnet search engine that indexes .onion sites and
 * itself filters out abuse content — this links to Ahmia's own search page,
 * the same one a browser would load; nothing here touches Tor or fetches a
 * .onion address directly.
 */
export function buildAhmiaSearchLink(query: string): SearchEngineLink {
  return { engine: 'Ahmia (Tor .onion index)', url: `https://ahmia.fi/search/?q=${encodeURIComponent(query)}` };
}
