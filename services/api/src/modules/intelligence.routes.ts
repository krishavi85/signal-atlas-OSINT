import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';

/**
 * Phase 3 read/APIs: claims (§10/§11), contradictions (§45), timeline (§15),
 * relationships + graph (§8), and the "WHY?" explainability endpoint (§47).
 */
export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // ── Claims ────────────────────────────────────────────────────────────────
  app.get('/projects/:id/claims', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z
      .object({
        corroboration: z.string().optional(),
        predicate: z.string().optional(),
        subject: z.string().optional(),
        minConfidence: z.coerce.number().min(0).max(1).optional(),
        limit: z.coerce.number().min(1).max(300).default(100),
      })
      .parse(req.query);
    const claims = await prisma.claim.findMany({
      where: {
        projectId: id,
        ...(q.corroboration ? { corroboration: q.corroboration } : {}),
        ...(q.predicate ? { predicate: q.predicate } : {}),
        ...(q.subject ? { subject: { contains: q.subject } } : {}),
        ...(q.minConfidence != null ? { confidenceScore: { gte: q.minConfidence } } : {}),
      },
      orderBy: [{ confidenceScore: 'desc' }, { createdAt: 'desc' }],
      take: q.limit,
      include: {
        _count: { select: { evidenceLinks: true, contradictionsA: true, contradictionsB: true } },
      },
    });
    return claims;
  });

  app.get('/claims/:claimId', async (req) => {
    const { claimId } = z.object({ claimId: z.string() }).parse(req.params);
    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        evidenceLinks: {
          include: {
            evidence: {
              select: {
                id: true, title: true, url: true, sourcePlatform: true, publishedAt: true, isDuplicate: true,
                source: { select: { label: true, tier: true, qualityScore: true } },
              },
            },
          },
        },
        contradictionsA: { include: { claimB: { select: { id: true, text: true, object: true } } } },
        contradictionsB: { include: { claimA: { select: { id: true, text: true, object: true } } } },
      },
    });
    if (!claim) throw notFound('Claim not found');
    await assertProjectAccess(req, claim.projectId);
    return claim;
  });

  // "WHY?" — evidence-based explanation of a claim's status (§47). No hidden CoT.
  app.get('/claims/:claimId/why', async (req) => {
    const { claimId } = z.object({ claimId: z.string() }).parse(req.params);
    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        evidenceLinks: {
          include: { evidence: { select: { id: true, url: true, sourcePlatform: true, source: { select: { tier: true, label: true } } } } },
        },
        contradictionsA: { include: { claimB: { select: { id: true, text: true } } } },
        contradictionsB: { include: { claimA: { select: { id: true, text: true } } } },
      },
    });
    if (!claim) throw notFound('Claim not found');
    await assertProjectAccess(req, claim.projectId);

    const supporting = claim.evidenceLinks.filter((l) => l.stance === 'SUPPORTS');
    const contradicting = claim.evidenceLinks.filter((l) => l.stance === 'CONTRADICTS');
    return {
      claim: { id: claim.id, text: claim.text, epistemicTag: claim.epistemicTag },
      status: {
        corroboration: claim.corroboration,
        verificationStatus: claim.verificationStatus,
        confidenceLevel: claim.confidenceLevel,
        confidenceScore: claim.confidenceScore,
      },
      confidenceFactors: claim.confidenceFactorsJson ?? [],
      supportingEvidence: supporting.map((l) => ({
        evidenceId: l.evidence.id,
        url: l.evidence.url,
        platform: l.evidence.sourcePlatform,
        sourceTier: l.evidence.source?.tier ?? null,
        excerpt: l.excerpt,
      })),
      contradictingEvidence: contradicting.map((l) => ({ evidenceId: l.evidence.id, url: l.evidence.url, excerpt: l.excerpt })),
      contradictions: [
        ...claim.contradictionsA.map((c) => ({ withClaimId: c.claimBId, text: c.claimB.text, explanation: c.explanation, status: c.status })),
        ...claim.contradictionsB.map((c) => ({ withClaimId: c.claimAId, text: c.claimA.text, explanation: c.explanation, status: c.status })),
      ],
      reasoning:
        `This is tagged ${claim.epistemicTag}. Corroboration is ${claim.corroboration} based on ` +
        `${supporting.length} supporting evidence record(s)` +
        (contradicting.length ? ` and ${contradicting.length} contradicting` : '') +
        `. Confidence ${claim.confidenceLevel} (${(claim.confidenceScore * 100) | 0}%) is the weighted result of the factors listed above.`,
    };
  });

  // Manual verification override (§10)
  app.patch('/claims/:claimId', async (req) => {
    const { claimId } = z.object({ claimId: z.string() }).parse(req.params);
    const body = z
      .object({
        verificationStatus: z.enum(['UNVERIFIED', 'SINGLE_SOURCE', 'MULTIPLE_SOURCES', 'INDEPENDENTLY_CORROBORATED', 'CONTRADICTED', 'OUTDATED']).optional(),
        epistemicTag: z.enum(['FACT', 'SOURCE', 'CLAIM', 'INFERENCE', 'HYPOTHESIS', 'UNKNOWN']).optional(),
      })
      .parse(req.body);
    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) throw notFound('Claim not found');
    await assertProjectAccess(req, claim.projectId, 'EDITOR');
    const u = currentUser(req);
    if (body.epistemicTag === 'FACT') {
      const support = await prisma.claimEvidence.count({ where: { claimId, stance: 'SUPPORTS' } });
      if (support === 0) throw badRequest('Cannot tag a claim FACT with no supporting evidence (§14)');
    }
    const updated = await prisma.claim.update({ where: { id: claimId }, data: { ...body, createdBy: claim.createdBy } });
    await audit({
      projectId: claim.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'claim', targetId: claimId, summary: `Claim manually updated: ${JSON.stringify(body)}`,
    });
    return updated;
  });

  // ── Contradictions ────────────────────────────────────────────────────────
  app.get('/projects/:id/contradictions', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.contradiction.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        claimA: { select: { id: true, text: true, subject: true, predicate: true, object: true, claimDate: true } },
        claimB: { select: { id: true, text: true, subject: true, predicate: true, object: true, claimDate: true } },
      },
    });
  });

  app.patch('/contradictions/:contradictionId', async (req) => {
    const { contradictionId } = z.object({ contradictionId: z.string() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['OPEN', 'RESOLVED_A', 'RESOLVED_B', 'UNRESOLVABLE', 'DISMISSED']),
        resolutionNote: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const c = await prisma.contradiction.findUnique({ where: { id: contradictionId } });
    if (!c) throw notFound('Contradiction not found');
    await assertProjectAccess(req, c.projectId, 'EDITOR');
    const u = currentUser(req);
    const updated = await prisma.contradiction.update({ where: { id: contradictionId }, data: body });
    await audit({
      projectId: c.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'contradiction', targetId: contradictionId, summary: `Contradiction ${body.status}${body.resolutionNote ? `: ${body.resolutionNote}` : ''}`,
    });
    return updated;
  });

  // ── Timeline (§15) ────────────────────────────────────────────────────────
  app.get('/projects/:id/timeline', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z
      .object({
        eventType: z.string().optional(),
        after: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
        minConfidence: z.enum(['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED']).optional(),
        limit: z.coerce.number().min(1).max(1000).default(500),
      })
      .parse(req.query);
    const events = await prisma.timelineEvent.findMany({
      where: {
        projectId: id,
        ...(q.eventType ? { eventType: q.eventType } : {}),
        ...(q.after || q.before
          ? { occurredAt: { ...(q.after ? { gte: new Date(q.after) } : {}), ...(q.before ? { lte: new Date(q.before) } : {}) } }
          : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: q.limit,
      include: { evidence: { select: { id: true, url: true, sourcePlatform: true } } },
    });
    const buckets = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
      return acc;
    }, {});
    return { events, byType: buckets, span: events.length ? { first: events[0]!.occurredAt, last: events[events.length - 1]!.occurredAt } : null };
  });

  // ── Relationships + graph (§8) ────────────────────────────────────────────
  app.get('/projects/:id/relationships', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.relationship.findMany({
      where: { projectId: id },
      include: {
        from: { select: { id: true, displayName: true, type: true } },
        to: { select: { id: true, displayName: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
  });

  app.get('/projects/:id/graph', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ minEvidence: z.coerce.number().min(1).default(1) }).parse(req.query);

    const [entities, relationships] = await Promise.all([
      prisma.entity.findMany({
        where: { projectId: id, mergedIntoId: null },
        include: { _count: { select: { evidenceLinks: true } } },
      }),
      prisma.relationship.findMany({ where: { projectId: id } }),
    ]);

    const keep = new Set(entities.filter((e) => e._count.evidenceLinks >= q.minEvidence).map((e) => e.id));
    const edges = relationships.filter((r) => keep.has(r.fromId) && keep.has(r.toId));
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.fromId);
      connected.add(e.toId);
    }
    const nodes = entities
      .filter((e) => keep.has(e.id) && (connected.has(e.id) || e._count.evidenceLinks >= q.minEvidence))
      .map((e) => ({
        id: e.id,
        label: e.displayName,
        type: e.type,
        evidenceCount: e._count.evidenceLinks,
        resolutionConfidence: e.resolutionConfidence,
      }));

    return {
      nodes,
      edges: edges.map((e) => ({
        id: e.id,
        source: e.fromId,
        target: e.toId,
        type: e.type,
        directed: e.directed,
        confidence: e.confidence,
        evidenceIds: e.evidenceIds,
      })),
    };
  });

  app.get('/relationships/:relId', async (req) => {
    const { relId } = z.object({ relId: z.string() }).parse(req.params);
    const rel = await prisma.relationship.findUnique({
      where: { id: relId },
      include: { from: true, to: true },
    });
    if (!rel) throw notFound('Relationship not found');
    await assertProjectAccess(req, rel.projectId);
    const evidenceIds = Array.isArray(rel.evidenceIds) ? (rel.evidenceIds as string[]) : [];
    const evidence = await prisma.evidence.findMany({
      where: { id: { in: evidenceIds } },
      select: { id: true, title: true, url: true, sourcePlatform: true, publishedAt: true },
    });
    return { ...rel, evidence };
  });
}
