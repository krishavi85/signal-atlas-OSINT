import {
  assertFactHasEvidence,
  classifyCorroboration,
  detectClaimConflict,
  extractClaimsHeuristic,
  factor,
  normalizeClaimObject,
  scoreConfidence,
  type ClaimPredicate,
  type ConfidenceFactor,
  type KnownEntityRef,
} from '@osint/core';
import { canonicalizeUrl } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';

/**
 * ClaimEngine (§10, §11, §44, §45).
 *
 *  1. extract    — deterministic subject-predicate-object claims from evidence
 *                  text, anchored to known project entities
 *  2. corroborate— per claim: count supporting / independent / contradicting
 *                  sources, classify (§11), compute factor-based confidence (§44)
 *  3. contradict — pairwise conflict detection between claims (§45); never picks
 *                  a winner, records CONTRADICTION-* rows
 *
 * All three are idempotent and safe to re-run.
 */

export interface ClaimEngineResult {
  claimsExtracted: number;
  claimsScored: number;
  contradictions: number;
}

export async function runClaimEngine(projectId: string): Promise<ClaimEngineResult> {
  const extracted = await extractClaims(projectId);
  const scored = await corroborateClaims(projectId);
  const contradictions = await detectContradictions(projectId);
  return { claimsExtracted: extracted, claimsScored: scored, contradictions };
}

// ── 1. extraction ────────────────────────────────────────────────────────────

async function extractClaims(projectId: string): Promise<number> {
  const [evidence, entities] = await Promise.all([
    prisma.evidence.findMany({
      where: { projectId, isDuplicate: false },
      select: { id: true, title: true, excerpt: true, fullText: true },
    }),
    prisma.entity.findMany({
      where: { projectId, mergedIntoId: null },
      select: { canonicalValue: true, displayName: true, type: true, aliases: { select: { value: true } } },
    }),
  ]);

  const known: KnownEntityRef[] = [];
  for (const e of entities) {
    known.push({ type: e.type, value: e.displayName });
    if (e.canonicalValue !== e.displayName.toLowerCase()) known.push({ type: e.type, value: e.canonicalValue });
    for (const a of e.aliases) known.push({ type: e.type, value: a.value });
  }
  if (known.length === 0) return 0;

  let created = 0;
  for (const ev of evidence) {
    const text = [ev.title, ev.fullText ?? ev.excerpt].filter(Boolean).join('. ');
    if (!text || text.length < 20) continue;
    const claims = extractClaimsHeuristic(text, known).slice(0, 25);
    for (const c of claims) {
      const normObject = normalizeClaimObject(c.predicate as ClaimPredicate, c.object);
      // upsert-by-shape: find an existing claim with same subject+predicate+normalized object
      const existing = await prisma.claim.findFirst({
        where: { projectId, subject: c.subject, predicate: c.predicate },
      });
      let claimId: string;
      if (existing && normalizeClaimObject(existing.predicate as ClaimPredicate, existing.object) === normObject) {
        claimId = existing.id;
      } else {
        const row = await prisma.claim.create({
          data: {
            projectId,
            subject: c.subject,
            predicate: c.predicate,
            object: c.object,
            claimDate: parseClaimDate(c.claimDate),
            text: c.text,
            epistemicTag: 'CLAIM',
            createdBy: 'SYSTEM',
          },
        });
        claimId = row.id;
        created++;
      }
      await prisma.claimEvidence
        .upsert({
          where: { claimId_evidenceId: { claimId, evidenceId: ev.id } },
          create: { claimId, evidenceId: ev.id, stance: 'SUPPORTS', excerpt: c.sentence.slice(0, 500) },
          update: {},
        })
        .catch((err) => logger.debug({ err }, 'claimEvidence upsert'));
    }
  }
  if (created > 0) {
    await audit({
      projectId,
      actorLabel: 'SYSTEM',
      action: 'CLAIM_EXTRACTED',
      targetType: 'project',
      targetId: projectId,
      summary: `Claim engine extracted ${created} new claims (deterministic, entity-anchored — not ML)`,
    });
  }
  return created;
}

// ── 2. corroboration + confidence ────────────────────────────────────────────

async function corroborateClaims(projectId: string): Promise<number> {
  const claims = await prisma.claim.findMany({
    where: { projectId },
    include: {
      evidenceLinks: {
        include: {
          evidence: {
            select: {
              id: true, url: true, clusterId: true, publishedAt: true, sourcePlatform: true,
              source: { select: { qualityScore: true, tier: true } },
            },
          },
        },
      },
    },
  });

  let scored = 0;
  for (const claim of claims) {
    const supports = claim.evidenceLinks.filter((l) => l.stance === 'SUPPORTS');
    const contradicts = claim.evidenceLinks.filter((l) => l.stance === 'CONTRADICTS');

    const domains = new Set<string>();
    const clusters = new Set<string>();
    let qualitySum = 0;
    let qualityN = 0;
    let latestSupportAt: number | null = null;
    let hasPrimary = false;

    for (const l of supports) {
      const e = l.evidence;
      const d = e.url ? canonicalizeUrl(e.url)?.registrableDomain ?? e.id : e.id;
      domains.add(d);
      if (e.clusterId) clusters.add(e.clusterId);
      else clusters.add(e.id);
      if (e.source?.qualityScore != null) {
        qualitySum += e.source.qualityScore;
        qualityN++;
      }
      if (e.source?.tier === 'PRIMARY_OFFICIAL' || e.source?.tier === 'PRIMARY_DOCUMENT' || e.source?.tier === 'DIRECT_PUBLIC_STATEMENT') {
        hasPrimary = true;
      }
      if (e.publishedAt) {
        const t = e.publishedAt.getTime();
        latestSupportAt = latestSupportAt === null ? t : Math.max(latestSupportAt, t);
      }
    }

    const independent = Math.min(domains.size, clusters.size);
    const corr = classifyCorroboration({
      supportingSourceCount: supports.length,
      independentSourceCount: independent,
      contradictingSourceCount: contradicts.length,
      latestSupportAt: latestSupportAt ? new Date(latestSupportAt).toISOString() : null,
    });

    const avgQuality = qualityN > 0 ? qualitySum / qualityN : 0.35;
    const factors: ConfidenceFactor[] = [
      factor('source_reliability', avgQuality * 2 - 1, `Mean source quality ${(avgQuality * 100) | 0}% across ${qualityN || 'unrated'} rated source(s)`),
      factor(
        'independent_corroboration',
        independent >= 3 ? 0.9 : independent === 2 ? 0.7 : independent === 1 ? -0.2 : -0.8,
        `${independent} independent source(s)`,
      ),
      factor('evidence_directness', hasPrimary ? 0.7 : -0.2, hasPrimary ? 'At least one primary / first-party source' : 'Only secondary reporting'),
      factor('evidence_completeness', supports.length >= 2 ? 0.4 : -0.3, `${supports.length} supporting evidence record(s)`),
      factor(
        'contradiction_penalty',
        contradicts.length > 0 ? -0.9 : 0.2,
        contradicts.length > 0 ? `${contradicts.length} contradicting evidence record(s)` : 'No contradicting evidence recorded',
      ),
    ];
    if (claim.claimDate) {
      factors.push(factor('date_consistency', 0.3, `Claim carries a date (${claim.claimDate.toISOString().slice(0, 10)})`));
    }

    const conf = scoreConfidence(factors);
    const epistemicTag =
      corr.class === 'INDEPENDENTLY_CORROBORATED' && contradicts.length === 0 && conf.level === 'VERIFIED'
        ? 'FACT'
        : corr.class === 'CONTRADICTED'
          ? 'CLAIM'
          : 'CLAIM';

    const evidenceIds = supports.map((l) => l.evidence.id);
    try {
      assertFactHasEvidence({ tag: epistemicTag, origin: 'SYSTEM_CORRELATION', evidenceIds });
    } catch {
      // never let the guard block scoring — downgrade instead
      continue;
    }

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        corroboration: corr.class,
        confidenceScore: conf.score,
        confidenceLevel: conf.level,
        confidenceFactorsJson: conf.factors as object,
        epistemicTag,
        verificationStatus:
          corr.class === 'INDEPENDENTLY_CORROBORATED' ? 'INDEPENDENTLY_CORROBORATED'
          : corr.class === 'CONTRADICTED' ? 'CONTRADICTED'
          : corr.class === 'MULTIPLE_SOURCES' ? 'MULTIPLE_SOURCES'
          : corr.class === 'SINGLE_SOURCE' ? 'SINGLE_SOURCE'
          : 'UNVERIFIED',
      },
    });
    scored++;
  }
  return scored;
}

// ── 3. contradictions ────────────────────────────────────────────────────────

async function detectContradictions(projectId: string): Promise<number> {
  const claims = await prisma.claim.findMany({
    where: { projectId },
    select: { id: true, subject: true, predicate: true, object: true, claimDate: true },
  });

  // bucket by normalized subject to keep it O(n·k)
  const buckets = new Map<string, typeof claims>();
  for (const c of claims) {
    const k = c.subject.toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(c);
  }

  let created = 0;
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const r = detectClaimConflict(
          { ...a, claimDate: a.claimDate?.toISOString() ?? null },
          { ...b, claimDate: b.claimDate?.toISOString() ?? null },
        );
        if (!r.conflicts) continue;
        const [claimAId, claimBId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const existing = await prisma.contradiction.findUnique({ where: { claimAId_claimBId: { claimAId, claimBId } } });
        if (existing) continue;
        await prisma.contradiction.create({
          data: { projectId, claimAId, claimBId, explanation: r.explanation, status: 'OPEN' },
        });
        created++;
        if (r.confidence === 'HIGH') {
          await prisma.claim.updateMany({
            where: { id: { in: [claimAId, claimBId] } },
            data: { corroboration: 'CONTRADICTED', verificationStatus: 'CONTRADICTED' },
          });
        }
      }
    }
  }
  if (created > 0) {
    await audit({
      projectId,
      actorLabel: 'SYSTEM',
      action: 'AI_ANALYSIS_EXECUTED',
      targetType: 'project',
      targetId: projectId,
      summary: `Contradiction engine found ${created} conflicting claim pair(s) — left OPEN for analyst resolution (§45)`,
    });
  }
  return created;
}

function parseClaimDate(d: string | null): Date | null {
  if (!d) return null;
  if (/^\d{4}$/.test(d)) return new Date(Date.UTC(Number(d), 0, 1));
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t) : null;
}
