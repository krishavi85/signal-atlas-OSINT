/**
 * Contradiction detection between claims (§45).
 *
 * Two claims conflict when they share a subject + predicate but assert
 * incompatible objects. Numeric / date predicates (FOUNDED_IN, RAISED) produce
 * HIGH-confidence contradictions; descriptive predicates (BASED_IN, IS_A) may
 * be complementary rather than contradictory, so they surface as OPEN for a
 * human to resolve — the engine never silently picks a winner.
 */
import { normalizeClaimObject, type ClaimPredicate } from './claims.js';

export interface ComparableClaim {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  claimDate: string | null;
}

export interface ConflictResult {
  conflicts: boolean;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  explanation: string;
}

const SINGLE_VALUE_PREDICATES = new Set(['FOUNDED_IN', 'RENAMED_TO']);
const NUMERIC_PREDICATES = new Set(['FOUNDED_IN', 'RAISED']);
const MULTI_VALUE_OK = new Set(['ANNOUNCED', 'LAUNCHED', 'ACQUIRED', 'PARTNERED_WITH', 'APPOINTED', 'OWNS']);

export function detectClaimConflict(a: ComparableClaim, b: ComparableClaim): ConflictResult {
  if (a.id === b.id) return no();
  if (normSubject(a.subject) !== normSubject(b.subject)) return no();
  if (a.predicate !== b.predicate) return no();

  const oa = normalizeClaimObject(a.predicate as ClaimPredicate, a.object);
  const ob = normalizeClaimObject(b.predicate as ClaimPredicate, b.object);
  if (oa === ob) return no();

  // For predicates where multiple distinct objects are perfectly normal
  // (a company announces many things), differing objects are NOT a contradiction.
  if (MULTI_VALUE_OK.has(a.predicate)) return no();

  if (NUMERIC_PREDICATES.has(a.predicate)) {
    const na = Number(oa);
    const nb = Number(ob);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
      return {
        conflicts: true,
        confidence: 'HIGH',
        explanation:
          a.predicate === 'FOUNDED_IN'
            ? `Founding year given as ${oa} in one source and ${ob} in another.`
            : `Amount reported as ${formatNum(na)} vs ${formatNum(nb)}.`,
      };
    }
  }

  if (SINGLE_VALUE_PREDICATES.has(a.predicate)) {
    return {
      conflicts: true,
      confidence: 'HIGH',
      explanation: `"${a.subject}" ${humanPred(a.predicate)} "${a.object}" per one source but "${b.object}" per another; this predicate admits only one value.`,
    };
  }

  // Descriptive predicates: possibly complementary. Flag for review.
  return {
    conflicts: true,
    confidence: 'LOW',
    explanation: `"${a.subject}" ${humanPred(a.predicate)} "${a.object}" and "${b.object}" — these may be complementary rather than contradictory; needs review.`,
  };
}

function no(): ConflictResult {
  return { conflicts: false, confidence: 'LOW', explanation: '' };
}
function normSubject(s: string): string {
  return s.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/\s+(inc|llc|ltd|corp|co)\.?$/, '').trim();
}
function humanPred(p: string): string {
  return p.replace(/_/g, ' ').toLowerCase();
}
function formatNum(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n}`;
}
