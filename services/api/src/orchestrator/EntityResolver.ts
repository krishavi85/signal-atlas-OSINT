import { normalizeUsername } from '@osint/core';

/**
 * Entity resolution scorer (§7).
 *
 * Compares two entities of the SAME type and returns a match score in [0,1]
 * plus the contributing factors. Deliberately conservative: name similarity
 * alone caps the score well below "auto-merge" — a shared strong identifier
 * (domain, username, URL) is required to reach HIGH.
 *
 * The API never auto-merges from this score; it only ranks candidates for a
 * human decision. Every merge is logged and reversible.
 */

export interface ResolvableEntity {
  type: string;
  displayName: string;
  canonicalValue: string;
  aliases: Array<{ value: string; kind: string }>;
  attributesJson?: unknown;
}

export interface MatchFactor {
  key: string;
  value: number; // -1..1
  weight: number;
  explanation: string;
}

export interface MatchResult {
  score: number;
  factors: MatchFactor[];
  recommendation: 'DO_NOT_MERGE' | 'REVIEW' | 'LIKELY_SAME';
}

export function scoreEntityMatch(a: ResolvableEntity, b: ResolvableEntity): MatchResult {
  const factors: MatchFactor[] = [];

  if (a.type !== b.type) {
    return {
      score: 0,
      factors: [{ key: 'type', value: -1, weight: 1, explanation: `Different entity types (${a.type} vs ${b.type})` }],
      recommendation: 'DO_NOT_MERGE',
    };
  }

  const aNames = collectValues(a);
  const bNames = collectValues(b);

  // 1. exact identifier overlap (domain/username/url/email)
  const idKinds = new Set(['DOMAIN', 'USERNAME', 'HANDLE', 'URL', 'EMAIL', 'LEGAL_NAME']);
  const aIds = new Set(
    a.aliases.filter((x) => idKinds.has(x.kind)).map((x) => normId(x.kind, x.value)),
  );
  const bIds = new Set(
    b.aliases.filter((x) => idKinds.has(x.kind)).map((x) => normId(x.kind, x.value)),
  );
  const sharedId = [...aIds].some((v) => bIds.has(v));
  if (sharedId) {
    factors.push({ key: 'shared_identifier', value: 1, weight: 3, explanation: 'Shares a strong identifier (domain / username / URL / email)' });
  } else if (aIds.size > 0 && bIds.size > 0) {
    factors.push({ key: 'shared_identifier', value: -0.4, weight: 1.5, explanation: 'Both have identifiers but none match' });
  }

  // 2. name similarity (best pair)
  let bestName = 0;
  for (const x of aNames) for (const y of bNames) bestName = Math.max(bestName, jaroWinkler(x, y));
  factors.push({
    key: 'name_similarity',
    value: bestName * 2 - 1,
    weight: 1.2,
    explanation: `Best name similarity ${(bestName * 100).toFixed(0)}%`,
  });

  // 3. canonical exact
  if (a.canonicalValue.toLowerCase() === b.canonicalValue.toLowerCase()) {
    factors.push({ key: 'canonical_exact', value: 1, weight: 2, explanation: 'Identical canonical value' });
  }

  // 4. acronym / abbreviation
  if (isAcronymOf(a.displayName, b.displayName) || isAcronymOf(b.displayName, a.displayName)) {
    factors.push({ key: 'acronym', value: 0.8, weight: 1, explanation: 'One name is an acronym/abbreviation of the other' });
  }

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = factors.reduce((s, f) => s + ((f.value + 1) / 2) * f.weight, 0);
  let score = totalWeight > 0 ? weighted / totalWeight : 0;

  // Guard: name-only similarity must not exceed 0.7 without a corroborating factor.
  const hasStrongFactor = factors.some(
    (f) => (f.key === 'shared_identifier' || f.key === 'canonical_exact') && f.value > 0.5,
  );
  if (!hasStrongFactor) score = Math.min(score, 0.7);

  const recommendation: MatchResult['recommendation'] =
    score >= 0.85 && hasStrongFactor ? 'LIKELY_SAME' : score >= 0.55 ? 'REVIEW' : 'DO_NOT_MERGE';

  return { score, factors, recommendation };
}

function collectValues(e: ResolvableEntity): string[] {
  return [e.displayName, e.canonicalValue, ...e.aliases.map((a) => a.value)]
    .map((v) => v.toLowerCase().trim())
    .filter(Boolean);
}

function normId(kind: string, value: string): string {
  if (kind === 'USERNAME' || kind === 'HANDLE') return `u:${normalizeUsername(value)}`;
  if (kind === 'DOMAIN') return `d:${value.toLowerCase().replace(/^www\./, '')}`;
  if (kind === 'EMAIL') return `e:${value.toLowerCase()}`;
  if (kind === 'URL') return `url:${value.toLowerCase().replace(/\/+$/, '')}`;
  return `${kind}:${value.toLowerCase()}`;
}

function isAcronymOf(acronym: string, phrase: string): boolean {
  const a = acronym.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (a.length < 2 || a.length > 6) return false;
  const initials = phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return initials === a;
}

/** Jaro-Winkler string similarity, 0..1. */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const jaro = jaroDistance(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function jaroDistance(s1: string, s2: string): number {
  if (s1.length === 0 || s2.length === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  return (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
}
