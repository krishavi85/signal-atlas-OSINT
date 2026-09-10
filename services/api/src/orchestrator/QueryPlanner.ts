import { expandQuery, parseBooleanQuery, type ExpandedQuery, type ExpansionSubjectHints } from '@osint/core';

/**
 * QueryPlanner (§5, §33).
 *
 * Turns one user request into an ordered set of concrete queries, each tagged
 * with the rule that produced it. The ORIGINAL query is always first and kept
 * distinct from generated expansions. AI expansion is a separate, optional pass
 * (see orchestrator/aiExpansion) and its queries are tagged generatedBy=AI.
 */

export interface PlanInput {
  originalQuery: string;
  subjectType?: string | null;
  depth: 'QUICK' | 'STANDARD' | 'DEEP';
  hints?: ExpansionSubjectHints;
}

export interface PlannedQuery extends ExpandedQuery {
  generatedBy: 'DETERMINISTIC' | 'USER';
  order: number;
}

const DEPTH_LIMITS: Record<PlanInput['depth'], number> = {
  QUICK: 1,
  STANDARD: 6,
  DEEP: 16,
};

export function planQueries(input: PlanInput): { queries: PlannedQuery[]; parsedWarnings: string[] } {
  const parsed = parseBooleanQuery(input.originalQuery);

  const hints: ExpansionSubjectHints = {
    subjectType: normalizeSubjectType(input.subjectType),
    knownDomains: [...(input.hints?.knownDomains ?? []), ...parsed.siteFilters],
    knownAliases: input.hints?.knownAliases ?? [],
    knownHandles: input.hints?.knownHandles ?? [],
  };

  const expansions = expandQuery(input.originalQuery, hints);
  const limit = DEPTH_LIMITS[input.depth];

  // Always keep ORIGINAL; then take the next (limit-1) by a priority order.
  const priority: Record<ExpandedQuery['kind'], number> = {
    ORIGINAL: 0,
    QUOTED_EXACT: 1,
    ALIAS: 2,
    SITE_SCOPED: 3,
    SOCIAL_HANDLE: 4,
    NEWS: 5,
    DOMAIN: 6,
    HASHTAG: 7,
    SPELLING_VARIANT: 8,
    AI_SUGGESTED: 9,
  };
  const sorted = [...expansions].sort((a, b) => priority[a.kind] - priority[b.kind]);
  const chosen = [sorted[0]!, ...sorted.slice(1).filter((e) => e.kind !== 'ORIGINAL')].slice(0, limit);

  const queries: PlannedQuery[] = chosen.map((e, i) => ({
    ...e,
    generatedBy: e.kind === 'ORIGINAL' ? 'USER' : 'DETERMINISTIC',
    order: i,
  }));

  return { queries, parsedWarnings: parsed.warnings };
}

function normalizeSubjectType(t?: string | null): ExpansionSubjectHints['subjectType'] {
  if (!t) return undefined;
  const up = t.toUpperCase();
  const allowed = ['PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'DOMAIN', 'USERNAME', 'TOPIC'];
  return allowed.includes(up) ? (up as ExpansionSubjectHints['subjectType']) : undefined;
}
