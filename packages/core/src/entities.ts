/**
 * Entity types (§6) and DETERMINISTIC heuristic extractors.
 *
 * IMPORTANT (§51): everything here is regex / gazetteer / rule based. It is
 * labelled `DETERMINISTIC_EXTRACTION` and MUST NOT be described as ML/NER in
 * any UI or report. An optional AI extractor (packages/connectors or api) can
 * augment these; its output is tagged `AI_EXTRACTION` separately.
 */

export const ENTITY_TYPES = [
  'PERSON',
  'ORGANIZATION',
  'COMPANY',
  'BRAND',
  'USERNAME',
  'DOMAIN',
  'URL',
  'EMAIL',
  'PHONE',
  'LOCATION',
  'EVENT',
  'PRODUCT',
  'HASHTAG',
  'DATE',
  'DOCUMENT',
  'IMAGE',
  'VIDEO',
  'SOCIAL_ACCOUNT',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface ExtractedEntity {
  type: EntityType;
  /** Canonical, normalised value. */
  canonicalValue: string;
  /** Exact substring as it appeared in the source. */
  originalText: string;
  /** 0..1 — extraction confidence for THIS extractor only. */
  confidence: number;
  /** Character offset in the analysed text. */
  offset: number;
  /** ~120 chars of surrounding context. */
  context: string;
  method: 'regex' | 'gazetteer';
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164-ish and common separators; deliberately conservative to limit false positives.
const PHONE_RE = /(?<!\w)(\+?\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?!\w)/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const HASHTAG_RE = /(?<![\w&])#([A-Za-z][A-Za-z0-9_]{1,138})/g;
const HANDLE_RE = /(?<![\w@./])@([A-Za-z0-9_.]{2,30})\b/g;
const DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const LONG_DATE_RE =
  /\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}?,?\s*\d{4}\b/gi;

const COMPANY_SUFFIXES =
  /\b([A-Z][A-Za-z0-9&'-]+(?:\s+[A-Z][A-Za-z0-9&'-]+){0,4})\s+(Inc\.?|LLC|Ltd\.?|Limited|GmbH|B\.?V\.?|N\.?V\.?|PLC|Corp\.?|Corporation|Company|Co\.?|Holdings|Group|S\.?A\.?|Pvt\.?\s+Ltd\.?|LLP)\b/g;

function ctx(text: string, start: number, len: number): string {
  const from = Math.max(0, start - 50);
  const to = Math.min(text.length, start + len + 50);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

function pushMatches(
  text: string,
  re: RegExp,
  type: EntityType,
  confidence: number,
  canonical: (raw: string, m: RegExpExecArray) => string,
  out: ExtractedEntity[],
  method: ExtractedEntity['method'] = 'regex',
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (m.index === re.lastIndex) re.lastIndex++;
    out.push({
      type,
      canonicalValue: canonical(raw, m),
      originalText: raw,
      confidence,
      offset: m.index,
      context: ctx(text, m.index, raw.length),
      method,
    });
  }
}

const COMMON_FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'pdf', 'doc', 'docx', 'mp4', 'svg']);

/**
 * Extract structured entities from a block of text. Pure, synchronous,
 * side-effect free. Deduplicates on (type, canonicalValue) keeping the
 * highest-confidence / first occurrence.
 */
export function extractEntitiesHeuristic(text: string): ExtractedEntity[] {
  if (!text || text.length === 0) return [];
  const raw: ExtractedEntity[] = [];

  pushMatches(text, EMAIL_RE, 'EMAIL', 0.95, (s) => s.toLowerCase(), raw);
  pushMatches(text, URL_RE, 'URL', 0.9, (s) => s.replace(/[.,;:)\]]+$/, ''), raw);
  pushMatches(text, HASHTAG_RE, 'HASHTAG', 0.9, (s) => s.toLowerCase(), raw);
  pushMatches(text, HANDLE_RE, 'SOCIAL_ACCOUNT', 0.55, (s) => s.toLowerCase(), raw);
  pushMatches(text, ISO_DATE_RE, 'DATE', 0.9, (s) => s, raw);
  pushMatches(text, LONG_DATE_RE, 'DATE', 0.75, (s) => s.replace(/\s+/g, ' ').trim(), raw);
  pushMatches(text, PHONE_RE, 'PHONE', 0.4, (s) => s.replace(/[\s.()-]/g, ''), raw);
  pushMatches(
    text,
    COMPANY_SUFFIXES,
    'COMPANY',
    0.7,
    (s) => s.replace(/\s+/g, ' ').trim(),
    raw,
  );

  // Domains — but not if they are really the tail of a URL/email or a filename.
  DOMAIN_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = DOMAIN_RE.exec(text)) !== null) {
    const d = dm[0].toLowerCase();
    const tld = d.split('.').pop()!;
    if (COMMON_FILE_TLDS.has(tld)) continue;
    const before = text.slice(Math.max(0, dm.index - 8), dm.index);
    if (before.includes('@') || before.endsWith('/') || before.endsWith('.')) continue;
    raw.push({
      type: 'DOMAIN',
      canonicalValue: d,
      originalText: dm[0],
      confidence: 0.6,
      offset: dm.index,
      context: ctx(text, dm.index, dm[0].length),
      method: 'regex',
    });
  }

  return dedupeEntities(raw);
}

export function dedupeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const byKey = new Map<string, ExtractedEntity>();
  for (const e of entities) {
    const key = `${e.type}::${e.canonicalValue.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || e.confidence > existing.confidence) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => a.offset - b.offset);
}

/** Normalise a username/handle for cross-platform comparison. */
export function normalizeUsername(handle: string): string {
  return handle.replace(/^@+/, '').toLowerCase().replace(/[._-]+/g, '');
}
