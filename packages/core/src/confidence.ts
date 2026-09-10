/**
 * Confidence model (§44). Confidence is NOT an AI-generated percentage; it is
 * computed from explicit, inspectable factors. Every consumer can see the
 * contributing factors and their weights.
 */

export const CONFIDENCE_LEVELS = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ConfidenceFactor {
  key:
    | 'source_reliability'
    | 'independent_corroboration'
    | 'entity_resolution_certainty'
    | 'date_consistency'
    | 'evidence_directness'
    | 'contradiction_penalty'
    | 'evidence_completeness';
  /** Normalised contribution in [-1, 1]. Negative = detracts. */
  value: number;
  /** Relative weight (>=0). Weights are normalised at scoring time. */
  weight: number;
  /** Human-readable justification shown in the "WHY?" panel (§47). */
  explanation: string;
}

export interface ConfidenceResult {
  score: number; // 0..1
  level: ConfidenceLevel;
  factors: ConfidenceFactor[];
}

const DEFAULT_WEIGHTS: Record<ConfidenceFactor['key'], number> = {
  source_reliability: 1.0,
  independent_corroboration: 1.4,
  entity_resolution_certainty: 1.1,
  date_consistency: 0.6,
  evidence_directness: 1.0,
  contradiction_penalty: 1.6,
  evidence_completeness: 0.7,
};

export function scoreConfidence(factors: ConfidenceFactor[]): ConfidenceResult {
  if (factors.length === 0) {
    return { score: 0, level: 'VERY_LOW', factors };
  }
  const totalWeight = factors.reduce((s, f) => s + Math.max(0, f.weight), 0);
  if (totalWeight === 0) return { score: 0, level: 'VERY_LOW', factors };

  // Weighted mean of factor values mapped from [-1,1] to [0,1].
  const weighted = factors.reduce((s, f) => {
    const v = clamp(f.value, -1, 1);
    return s + ((v + 1) / 2) * Math.max(0, f.weight);
  }, 0);
  const score = clamp(weighted / totalWeight, 0, 1);

  return { score, level: toLevel(score, factors), factors };
}

/** Build a factor with the default weight for its key. */
export function factor(
  key: ConfidenceFactor['key'],
  value: number,
  explanation: string,
  weight = DEFAULT_WEIGHTS[key],
): ConfidenceFactor {
  return { key, value: clamp(value, -1, 1), weight, explanation };
}

function toLevel(score: number, factors: ConfidenceFactor[]): ConfidenceLevel {
  const contradicted = factors.some(
    (f) => f.key === 'contradiction_penalty' && f.value < -0.5,
  );
  if (contradicted) return score < 0.35 ? 'VERY_LOW' : 'LOW';

  // VERIFIED requires genuine independent corroboration, not just a high mean.
  const independentlyCorroborated = factors.some(
    (f) => f.key === 'independent_corroboration' && f.value >= 0.75,
  );
  if (score >= 0.85 && independentlyCorroborated) return 'VERIFIED';
  if (score >= 0.7) return 'HIGH';
  if (score >= 0.45) return 'MEDIUM';
  if (score >= 0.25) return 'LOW';
  return 'VERY_LOW';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
