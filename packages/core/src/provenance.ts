/**
 * The provenance boundary (spec §13, §57).
 *
 * Every statement the platform stores or renders carries an epistemic tag so
 * the UI and reports can always distinguish what a source said from what the
 * system extracted, what multiple sources confirm, and what an AI inferred.
 */
export const EPISTEMIC_TAGS = [
  'FACT', // directly observed in a primary/authoritative source, corroborated
  'SOURCE', // a source asserts this; not independently verified
  'CLAIM', // an extracted subject-predicate-object assertion pending verification
  'INFERENCE', // derived by the system/AI from other records
  'HYPOTHESIS', // an analyst's or AI's tentative explanation
  'UNKNOWN', // information gap — explicitly not found in searched sources
] as const;

export type EpistemicTag = (typeof EPISTEMIC_TAGS)[number];

/** Who/what produced an assertion. Keeps human vs AI conclusions distinct (§22). */
export const ASSERTION_ORIGINS = [
  'SOURCE_CONTENT',
  'DETERMINISTIC_EXTRACTION', // regex / parser / gazetteer — labelled heuristic, never "ML"
  'AI_EXTRACTION',
  'AI_SYNTHESIS',
  'HUMAN_ANALYST',
  'SYSTEM_CORRELATION',
] as const;

export type AssertionOrigin = (typeof ASSERTION_ORIGINS)[number];

export interface Provenance {
  tag: EpistemicTag;
  origin: AssertionOrigin;
  /** Evidence record IDs that support this assertion (§9). */
  evidenceIds: string[];
  /** Free-text note on how the assertion was derived (no hidden CoT — §47). */
  rationale?: string;
}

export function isAiOrigin(o: AssertionOrigin): boolean {
  return o === 'AI_EXTRACTION' || o === 'AI_SYNTHESIS';
}

/**
 * Guard used before rendering any factual assertion (§14).
 * An assertion may only be tagged FACT if it has evidence support.
 */
export function assertFactHasEvidence(p: Provenance): void {
  if (p.tag === 'FACT' && p.evidenceIds.length === 0) {
    throw new Error(
      'Anti-hallucination guard: an assertion tagged FACT must reference at least one evidence record.',
    );
  }
}

/** Human-readable label for an information gap (§14, §56). */
export const NOT_FOUND_LABEL = 'Not found in the searched sources';
export const UNVERIFIED_LABEL = 'Unverified';
export const INSUFFICIENT_LABEL = 'Insufficient evidence';
