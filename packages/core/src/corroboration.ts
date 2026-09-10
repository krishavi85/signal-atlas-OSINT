/**
 * Source corroboration (§11) and source-quality rubric (§12).
 * Both are configurable and EXPLAINABLE — every rating carries its reasons.
 */

export const CORROBORATION_CLASSES = [
  'SINGLE_SOURCE',
  'MULTIPLE_SOURCES', // >1 source but not shown independent
  'INDEPENDENTLY_CORROBORATED', // >=2 genuinely independent sources
  'CONTRADICTED',
  'UNVERIFIED',
  'OUTDATED',
] as const;
export type CorroborationClass = (typeof CORROBORATION_CLASSES)[number];

export interface CorroborationInput {
  supportingSourceCount: number;
  independentSourceCount: number;
  contradictingSourceCount: number;
  /** ISO date of the most recent supporting evidence, if known. */
  latestSupportAt?: string | null;
  /** treat support older than this many days as potentially outdated */
  outdatedAfterDays?: number;
}

export interface CorroborationResult {
  class: CorroborationClass;
  reasons: string[];
}

export function classifyCorroboration(input: CorroborationInput): CorroborationResult {
  const reasons: string[] = [];
  const {
    supportingSourceCount: s,
    independentSourceCount: i,
    contradictingSourceCount: c,
    latestSupportAt,
    outdatedAfterDays = 365,
  } = input;

  if (c > 0 && s > 0) {
    reasons.push(`${c} contradicting source(s) vs ${s} supporting`);
    return { class: 'CONTRADICTED', reasons };
  }
  if (s === 0) {
    reasons.push('No supporting evidence recorded');
    return { class: 'UNVERIFIED', reasons };
  }

  if (latestSupportAt) {
    const ageDays = (Date.now() - Date.parse(latestSupportAt)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > outdatedAfterDays) {
      reasons.push(
        `Most recent supporting evidence is ${Math.round(ageDays)} days old (> ${outdatedAfterDays})`,
      );
      return { class: 'OUTDATED', reasons };
    }
  }

  if (i >= 2) {
    reasons.push(`${i} independent sources (distinct domains, not syndicated)`);
    return { class: 'INDEPENDENTLY_CORROBORATED', reasons };
  }
  if (s >= 2) {
    reasons.push(
      `${s} supporting sources but only ${i} independent — likely shared origin or syndication`,
    );
    return { class: 'MULTIPLE_SOURCES', reasons };
  }
  reasons.push('Exactly one supporting source');
  return { class: 'SINGLE_SOURCE', reasons };
}

// ── Source quality (§12) ──────────────────────────────────────────────────────

export const SOURCE_TIERS = [
  'PRIMARY_OFFICIAL', // government, registry, the entity's own verified channel
  'ESTABLISHED_PUBLICATION',
  'PRIMARY_DOCUMENT',
  'DIRECT_PUBLIC_STATEMENT',
  'SECONDARY_REPORTING',
  'AGGREGATOR',
  'UNKNOWN_WEBSITE',
  'ANONYMOUS_OR_USER_GENERATED',
] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export interface SourceQualitySignals {
  isGovernmentDomain?: boolean; // *.gov, *.gouv, *.gov.uk, etc.
  isEducationDomain?: boolean;
  isEntityOwnedChannel?: boolean;
  isKnownPublication?: boolean; // from a configurable allowlist
  isPrimaryDocument?: boolean; // filing, dataset, press release PDF
  isSocialUserPost?: boolean;
  isAnonymous?: boolean;
  hasNamedAuthor?: boolean;
  hasPublicationDate?: boolean;
  independentCorroborationCount?: number;
}

export interface SourceQualityResult {
  tier: SourceTier;
  /** 0..1, before corroboration adjustment */
  baseScore: number;
  score: number;
  reasons: string[];
}

const TIER_BASE: Record<SourceTier, number> = {
  PRIMARY_OFFICIAL: 0.92,
  ESTABLISHED_PUBLICATION: 0.78,
  PRIMARY_DOCUMENT: 0.85,
  DIRECT_PUBLIC_STATEMENT: 0.7,
  SECONDARY_REPORTING: 0.55,
  AGGREGATOR: 0.4,
  UNKNOWN_WEBSITE: 0.3,
  ANONYMOUS_OR_USER_GENERATED: 0.2,
};

export function assessSourceQuality(sig: SourceQualitySignals): SourceQualityResult {
  const reasons: string[] = [];
  let tier: SourceTier = 'UNKNOWN_WEBSITE';

  if (sig.isGovernmentDomain) {
    tier = 'PRIMARY_OFFICIAL';
    reasons.push('Government domain');
  } else if (sig.isEntityOwnedChannel) {
    tier = 'DIRECT_PUBLIC_STATEMENT';
    reasons.push("Entity's own verified channel");
  } else if (sig.isPrimaryDocument) {
    tier = 'PRIMARY_DOCUMENT';
    reasons.push('Primary document (filing/dataset/press release)');
  } else if (sig.isKnownPublication) {
    tier = 'ESTABLISHED_PUBLICATION';
    reasons.push('On configured established-publication allowlist');
  } else if (sig.isEducationDomain) {
    tier = 'SECONDARY_REPORTING';
    reasons.push('Educational domain');
  } else if (sig.isSocialUserPost) {
    tier = sig.isAnonymous ? 'ANONYMOUS_OR_USER_GENERATED' : 'DIRECT_PUBLIC_STATEMENT';
    reasons.push(sig.isAnonymous ? 'Anonymous social post' : 'Attributed social post');
  } else if (sig.isAnonymous) {
    tier = 'ANONYMOUS_OR_USER_GENERATED';
    reasons.push('No identifiable author or publisher');
  }

  let baseScore = TIER_BASE[tier];

  if (sig.hasNamedAuthor) {
    baseScore += 0.04;
    reasons.push('Named author (+)');
  }
  if (sig.hasPublicationDate) {
    baseScore += 0.03;
    reasons.push('Publication date present (+)');
  } else {
    baseScore -= 0.05;
    reasons.push('No publication date (−)');
  }

  baseScore = clamp01(baseScore);

  // Independent corroboration nudges the effective score but never turns a weak
  // source into an authoritative one on its own (§12: popularity ≠ truth).
  const corr = sig.independentCorroborationCount ?? 0;
  const bonus = Math.min(0.15, corr * 0.05);
  if (bonus > 0) reasons.push(`${corr} independent corroborating source(s) (+${bonus.toFixed(2)})`);
  const score = clamp01(baseScore + bonus);

  return { tier, baseScore, score, reasons };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
