/**
 * Dependency-free markup helpers. Deliberately small: extract text and a few
 * fields from HTML, and parse RSS/Atom feeds. Not a full DOM — good enough for
 * evidence excerpts, with the raw body always retained separately.
 */

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITY_MAP[code] ?? m;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

export interface HtmlMeta {
  title: string | null;
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  canonical: string | null;
  language: string | null;
  ogImage: string | null;
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

export function extractHtmlMeta(html: string): HtmlMeta {
  const head = html.slice(0, 200_000);
  const title =
    metaContent(head, [/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i]) ??
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? null);
  return {
    title: title ? decodeEntities(title) : null,
    description: metaContent(head, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    ]),
    author: metaContent(head, [
      /<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']*)["']/i,
    ]),
    publishedAt: metaContent(head, [
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+name=["']date["'][^>]+content=["']([^"']*)["']/i,
      /<time[^>]+datetime=["']([^"']*)["']/i,
    ]),
    canonical: /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(head)?.[1] ?? null,
    language: /<html[^>]+lang=["']([a-zA-Z-]{2,10})["']/i.exec(head)?.[1]?.toLowerCase() ?? null,
    ogImage: metaContent(head, [/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i]),
  };
}

// ── RSS / Atom ───────────────────────────────────────────────────────────────

export interface FeedItem {
  title: string | null;
  link: string | null;
  description: string | null;
  content: string | null;
  author: string | null;
  publishedAt: string | null;
  guid: string | null;
}

export interface ParsedFeed {
  feedTitle: string | null;
  feedLink: string | null;
  items: FeedItem[];
}

function tag(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  return decodeEntities(unwrapCdata(m[1] ?? '')).trim() || null;
}

function attr(xml: string, name: string, a: string): string | null {
  const re = new RegExp(`<${name}\\s[^>]*\\b${a}=["']([^"']+)["']`, 'i');
  return re.exec(xml)?.[1] ?? null;
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const items: FeedItem[] = [];

  if (isAtom) {
    const entryRe = /<entry[\s>][\s\S]*?<\/entry>/gi;
    for (const m of xml.match(entryRe) ?? []) {
      items.push({
        title: tag(m, 'title'),
        link: attr(m, 'link', 'href'),
        description: tag(m, 'summary'),
        content: tag(m, 'content'),
        author: tag(m, 'name'),
        publishedAt: normalizeDate(tag(m, 'published') ?? tag(m, 'updated')),
        guid: tag(m, 'id'),
      });
    }
    return { feedTitle: tag(xml.split('<entry')[0] ?? xml, 'title'), feedLink: attr(xml, 'link', 'href'), items };
  }

  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  for (const m of xml.match(itemRe) ?? []) {
    items.push({
      title: tag(m, 'title'),
      link: tag(m, 'link'),
      description: tag(m, 'description'),
      content: tag(m, 'content:encoded') ?? tag(m, 'content'),
      author: tag(m, 'dc:creator') ?? tag(m, 'author'),
      publishedAt: normalizeDate(tag(m, 'pubDate') ?? tag(m, 'dc:date')),
      guid: tag(m, 'guid'),
    });
  }
  const channel = xml.split('<item')[0] ?? xml;
  return { feedTitle: tag(channel, 'title'), feedLink: tag(channel, 'link'), items };
}

export function normalizeDate(input: string | null): string | null {
  if (!input) return null;
  const t = Date.parse(input);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
