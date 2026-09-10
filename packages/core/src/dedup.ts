import { evidenceContentHash, type NormalizedResult } from './evidence.js';
import { contentHash, hammingDistance, simhash64 } from './hash.js';
import { canonicalizeUrl } from './url.js';

/**
 * Deduplication engine (§18).
 *
 * Tiers, in order of strength:
 *   1. exact URL           — identical url string
 *   2. canonical URL       — same canonicalized url
 *   3. content hash        — whitespace/quote-normalized body identical
 *   4. near-duplicate      — SimHash Hamming distance <= threshold
 *
 * Reposted / syndicated content is grouped so it cannot inflate corroboration
 * scores (§11, §18). The FIRST-seen item in a group is the representative;
 * later ones are marked as duplicates with a `duplicateOf` pointer and reason.
 */

export type DuplicateReason =
  | 'EXACT_URL'
  | 'CANONICAL_URL'
  | 'CONTENT_HASH'
  | 'NEAR_DUPLICATE'
  | 'SYNDICATED';

export interface DedupItem {
  id: string;
  result: NormalizedResult;
}

export interface DedupDecision {
  id: string;
  isDuplicate: boolean;
  duplicateOf: string | null;
  reason: DuplicateReason | null;
  /** group key that ties syndicated copies together for corroboration counting */
  clusterId: string;
  contentHash: string;
  simhash: string; // hex
}

const NEAR_DUP_MAX_DISTANCE = 3;

export function deduplicate(items: DedupItem[]): DedupDecision[] {
  const decisions: DedupDecision[] = [];
  const byExactUrl = new Map<string, string>();
  const byCanonUrl = new Map<string, string>();
  const byContentHash = new Map<string, string>();
  const simhashes: { id: string; hash: bigint; clusterId: string }[] = [];

  let clusterSeq = 0;

  for (const item of items) {
    const r = item.result;
    const body = r.fullText ?? r.excerpt ?? r.title ?? '';
    const ch = body ? contentHash(body) : evidenceContentHash(r);
    const sh = body ? simhash64(body) : 0n;

    let duplicateOf: string | null = null;
    let reason: DuplicateReason | null = null;
    let clusterId: string | null = null;

    if (r.url && byExactUrl.has(r.url)) {
      duplicateOf = byExactUrl.get(r.url)!;
      reason = 'EXACT_URL';
    }

    if (!duplicateOf) {
      const canon = r.canonicalUrl ?? (r.url ? canonicalizeUrl(r.url)?.canonical ?? null : null);
      if (canon && byCanonUrl.has(canon)) {
        duplicateOf = byCanonUrl.get(canon)!;
        reason = 'CANONICAL_URL';
      } else if (canon) {
        byCanonUrl.set(canon, item.id);
      }
    }

    if (!duplicateOf && body && byContentHash.has(ch)) {
      duplicateOf = byContentHash.get(ch)!;
      // Same body, different URL/host => syndication.
      reason = 'CONTENT_HASH';
    }

    if (!duplicateOf && sh !== 0n) {
      for (const prev of simhashes) {
        if (hammingDistance(sh, prev.hash) <= NEAR_DUP_MAX_DISTANCE) {
          duplicateOf = prev.id;
          reason = 'NEAR_DUPLICATE';
          clusterId = prev.clusterId;
          break;
        }
      }
    }

    if (duplicateOf && !clusterId) {
      clusterId = decisions.find((d) => d.id === duplicateOf)?.clusterId ?? null;
    }
    if (!clusterId) {
      clusterId = `cluster-${++clusterSeq}`;
    }

    // Detect syndication explicitly: duplicate by content but different registrable domain.
    if (duplicateOf && reason === 'CONTENT_HASH') {
      const orig = items.find((i) => i.id === duplicateOf)?.result;
      const origHost = orig?.url ? canonicalizeUrl(orig.url)?.registrableDomain : undefined;
      const thisHost = r.url ? canonicalizeUrl(r.url)?.registrableDomain : undefined;
      if (origHost && thisHost && origHost !== thisHost) reason = 'SYNDICATED';
    }

    if (r.url && !byExactUrl.has(r.url)) byExactUrl.set(r.url, item.id);
    if (body && !byContentHash.has(ch)) byContentHash.set(ch, item.id);
    if (sh !== 0n) simhashes.push({ id: item.id, hash: sh, clusterId });

    decisions.push({
      id: item.id,
      isDuplicate: duplicateOf !== null,
      duplicateOf,
      reason,
      clusterId,
      contentHash: ch,
      simhash: sh.toString(16),
    });
  }

  return decisions;
}

/**
 * Count INDEPENDENT sources among a set of dedup decisions + their results.
 * Independence = distinct registrable domain AND not in the same near-dup /
 * syndication cluster.
 */
export function countIndependentSources(
  decisions: DedupDecision[],
  resultsById: Map<string, NormalizedResult>,
): number {
  const seenClusters = new Set<string>();
  const seenDomains = new Set<string>();
  let count = 0;
  for (const d of decisions) {
    if (seenClusters.has(d.clusterId)) continue;
    const r = resultsById.get(d.id);
    const domain = r?.url ? canonicalizeUrl(r.url)?.registrableDomain ?? d.id : d.id;
    if (seenDomains.has(domain)) continue;
    seenClusters.add(d.clusterId);
    seenDomains.add(domain);
    count++;
  }
  return count;
}
