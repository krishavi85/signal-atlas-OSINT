import { z } from 'zod';
import { sha256 } from './hash.js';

/**
 * Evidence model (§9). Every result retains provenance. Evidence IDs are
 * immutable and human-quotable: `EVIDENCE-<YEAR>-<zero-padded seq>`.
 */

export const EVIDENCE_ID_RE = /^EVIDENCE-\d{4}-\d{6}$/;

export function formatEvidenceId(year: number, seq: number): string {
  return `EVIDENCE-${year}-${String(seq).padStart(6, '0')}`;
}

export function parseEvidenceId(id: string): { year: number; seq: number } | null {
  const m = /^EVIDENCE-(\d{4})-(\d{6})$/.exec(id);
  if (!m) return null;
  return { year: Number(m[1]), seq: Number(m[2]) };
}

export const AnalysisStatus = z.enum([
  'UNPROCESSED',
  'NORMALIZED',
  'ENTITIES_EXTRACTED',
  'CLAIMS_EXTRACTED',
  'ANALYZED',
  'ERROR',
]);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

export const VerificationStatus = z.enum([
  'UNVERIFIED',
  'SINGLE_SOURCE',
  'MULTIPLE_SOURCES',
  'INDEPENDENTLY_CORROBORATED',
  'CONTRADICTED',
  'OUTDATED',
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** Normalised, connector-agnostic shape produced by every connector's `normalize()`. */
export const NormalizedResult = z.object({
  connectorId: z.string(),
  sourcePlatform: z.string(), // "web", "rss", "wikipedia", "hackernews", "youtube", ...
  url: z.string().url().nullable(),
  canonicalUrl: z.string().url().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  retrievedAt: z.string().datetime(),
  excerpt: z.string().nullable(),
  fullText: z.string().nullable(),
  language: z.string().nullable(),
  rawMetadata: z.record(z.unknown()),
  /** The exact query string that discovered this result. */
  discoveryQuery: z.string(),
  /** Optional media references (image/video URLs) found on the item. */
  media: z
    .array(z.object({ type: z.enum(['image', 'video', 'audio', 'document']), url: z.string() }))
    .default([]),
});
export type NormalizedResult = z.infer<typeof NormalizedResult>;

/**
 * Compute the immutable content hash for an evidence record. Bound to the
 * fields that define "the same captured content", not to retrieval metadata.
 */
export function evidenceContentHash(r: Pick<NormalizedResult, 'url' | 'title' | 'fullText' | 'excerpt'>): string {
  return sha256(
    JSON.stringify({
      url: r.url ?? '',
      title: (r.title ?? '').trim(),
      body: (r.fullText ?? r.excerpt ?? '').trim(),
    }),
  );
}

export interface EvidenceRecordInput {
  projectId: string;
  result: NormalizedResult;
  discoveryConnectorId: string;
  discoveryQuery: string;
  searchId?: string;
  screenshotKey?: string | null;
}
