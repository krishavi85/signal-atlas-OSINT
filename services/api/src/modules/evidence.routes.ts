import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVIDENCE_ID_RE } from '@osint/core';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';

export async function evidenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // Full-text + faceted search across a project's collected evidence (§23).
  app.get('/projects/:id/evidence', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z
      .object({
        q: z.string().optional(),
        connectorId: z.string().optional(),
        platform: z.string().optional(),
        language: z.string().optional(),
        verificationStatus: z.string().optional(),
        includeDuplicates: z.coerce.boolean().default(false),
        publishedAfter: z.string().datetime().optional(),
        publishedBefore: z.string().datetime().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);

    const where: Record<string, unknown> = { projectId: id };
    if (!q.includeDuplicates) where.isDuplicate = false;
    if (q.connectorId) where.connectorId = q.connectorId;
    if (q.platform) where.sourcePlatform = q.platform;
    if (q.language) where.language = q.language;
    if (q.verificationStatus) where.verificationStatus = q.verificationStatus;
    if (q.publishedAfter || q.publishedBefore) {
      where.publishedAt = {
        ...(q.publishedAfter ? { gte: new Date(q.publishedAfter) } : {}),
        ...(q.publishedBefore ? { lte: new Date(q.publishedBefore) } : {}),
      };
    }
    if (q.q) {
      // SQLite LIKE-based contains; swap for FTS5/tsvector in production (see ARCHITECTURE swap points).
      where.OR = [
        { title: { contains: q.q } },
        { excerpt: { contains: q.q } },
        { fullText: { contains: q.q } },
        { author: { contains: q.q } },
      ];
    }

    const rows = await prisma.evidence.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        source: { select: { label: true, tier: true, qualityScore: true } },
        connector: { select: { displayName: true } },
        _count: { select: { entities: true, duplicates: true, claimLinks: true } },
      },
    });
    const nextCursor = rows.length > q.limit ? rows.pop()!.id : null;

    const facets = await prisma.evidence.groupBy({
      by: ['sourcePlatform'],
      where: { projectId: id, isDuplicate: false },
      _count: true,
    });

    return { items: rows, nextCursor, facets: { platform: facets.map((f) => ({ value: f.sourcePlatform, count: f._count })) } };
  });

  app.get('/evidence/:evidenceId', async (req) => {
    const { evidenceId } = z.object({ evidenceId: z.string().regex(EVIDENCE_ID_RE) }).parse(req.params);
    const ev = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        source: true,
        connector: { select: { id: true, displayName: true } },
        search: { select: { id: true, originalQuery: true } },
        entities: { include: { entity: { select: { id: true, type: true, displayName: true, canonicalValue: true } } } },
        duplicates: { select: { id: true, url: true, sourcePlatform: true, duplicateReason: true } },
        duplicateOf: { select: { id: true, url: true, title: true } },
        claimLinks: { include: { claim: { select: { id: true, text: true, corroboration: true } } } },
      },
    });
    if (!ev) throw notFound('Evidence not found');
    await assertProjectAccess(req, ev.projectId);
    return ev;
  });

  app.delete('/evidence/:evidenceId', async (req, reply) => {
    const { evidenceId } = z.object({ evidenceId: z.string().regex(EVIDENCE_ID_RE) }).parse(req.params);
    const ev = await prisma.evidence.findUnique({ where: { id: evidenceId } });
    if (!ev) throw notFound('Evidence not found');
    await assertProjectAccess(req, ev.projectId, 'EDITOR');
    const u = currentUser(req);
    // The evidence id is retained in the audit log even after deletion (§30 retention / §29 auditability).
    await prisma.evidence.delete({ where: { id: evidenceId } });
    await audit({
      projectId: ev.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'EVIDENCE_REMOVED',
      targetType: 'evidence', targetId: evidenceId,
      summary: `Removed evidence ${evidenceId} (${ev.url ?? ev.sourcePlatform})`,
      metadata: { contentHash: ev.contentHash },
    });
    reply.status(204).send();
  });
}
