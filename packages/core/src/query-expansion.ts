/**
 * Query expansion engine (§5).
 *
 * DETERMINISTIC expansions only in this module. The original query is always
 * kept separate from generated ones, and every generated query records the
 * rule that produced it so the UI can show "which queries were actually
 * executed" and why. AI-generated expansions are produced elsewhere and
 * tagged distinctly.
 */

export type ExpansionKind =
  | 'ORIGINAL'
  | 'QUOTED_EXACT'
  | 'ALIAS'
  | 'DOMAIN'
  | 'SOCIAL_HANDLE'
  | 'HASHTAG'
  | 'NEWS'
  | 'SITE_SCOPED'
  | 'SPELLING_VARIANT'
  | 'AI_SUGGESTED';

export interface ExpandedQuery {
  query: string;
  kind: ExpansionKind;
  rationale: string;
  /** false until the orchestrator actually dispatches it to a connector */
  executed: boolean;
}

export interface ExpansionSubjectHints {
  subjectType?: 'PERSON' | 'ORGANIZATION' | 'COMPANY' | 'BRAND' | 'PRODUCT' | 'DOMAIN' | 'USERNAME' | 'TOPIC';
  knownAliases?: string[];
  knownDomains?: string[];
  knownHandles?: string[];
}

export function expandQuery(original: string, hints: ExpansionSubjectHints = {}): ExpandedQuery[] {
  const base = original.trim();
  const out: ExpandedQuery[] = [
    { query: base, kind: 'ORIGINAL', rationale: 'User-supplied query, unmodified', executed: false },
  ];
  if (!base) return out;

  const isMultiWord = /\s/.test(base);
  const looksLikePhrase = isMultiWord && !/["()]|AND|OR|NOT|site:/.test(base);

  if (looksLikePhrase) {
    out.push({
      query: `"${base}"`,
      kind: 'QUOTED_EXACT',
      rationale: 'Exact-phrase match to reduce noise from partial-term hits',
      executed: false,
    });
  }

  for (const alias of hints.knownAliases ?? []) {
    if (alias && alias.toLowerCase() !== base.toLowerCase()) {
      out.push({
        query: alias,
        kind: 'ALIAS',
        rationale: `Known alias of the subject`,
        executed: false,
      });
    }
  }

  for (const domain of hints.knownDomains ?? []) {
    out.push({
      query: `site:${domain}`,
      kind: 'SITE_SCOPED',
      rationale: `Scan the subject's own domain ${domain}`,
      executed: false,
    });
    out.push({
      query: `"${base}" -site:${domain}`,
      kind: 'SITE_SCOPED',
      rationale: `Third-party mentions, excluding the subject's own domain`,
      executed: false,
    });
  }

  for (const handle of hints.knownHandles ?? []) {
    const h = handle.replace(/^@/, '');
    out.push({
      query: `"@${h}"`,
      kind: 'SOCIAL_HANDLE',
      rationale: `Mentions of the social handle @${h}`,
      executed: false,
    });
  }

  if (
    (hints.subjectType === 'COMPANY' ||
      hints.subjectType === 'ORGANIZATION' ||
      hints.subjectType === 'BRAND' ||
      hints.subjectType === 'PRODUCT') &&
    !looksLikePhrase === false
  ) {
    for (const suffix of ['news', 'announcement', 'press release', 'launch', 'funding']) {
      out.push({
        query: `"${base}" ${suffix}`,
        kind: 'NEWS',
        rationale: `Surface time-sensitive announcements ("${suffix}")`,
        executed: false,
      });
    }
  }

  if (/^[A-Za-z][A-Za-z0-9 ]+$/.test(base) && isMultiWord) {
    const nospace = base.replace(/\s+/g, '');
    out.push({
      query: nospace,
      kind: 'SPELLING_VARIANT',
      rationale: 'Concatenated spelling (common for brand / product names)',
      executed: false,
    });
    out.push({
      query: `#${nospace}`,
      kind: 'HASHTAG',
      rationale: 'Hashtag form for social platforms',
      executed: false,
    });
  }

  // de-dupe on the query string, preserving the first (strongest) rationale
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = e.query.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
