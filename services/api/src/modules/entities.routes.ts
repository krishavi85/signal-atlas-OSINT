import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { scoreEntityMatch } from '../orchestrator/EntityResolver.js';

export async function entityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/projects/:id/entities', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z
      .object({
        type: z.string().optional(),
        q: z.string().optional(),
        minEvidence: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(200).default(100),
      })
      .parse(req.query);

    const rows = await prisma.entity.findMany({
      where: {
        projectId: id,
        mergedIntoId: null,
        ...(q.type ? { type: q.type } : {}),
        ...(q.q ? { OR: [{ displayName: { contains: q.q } }, { canonicalValue: { contains: q.q } }] } : {}),
      },
      include: {
        _count: { select: { evidenceLinks: true, relationshipsFrom: true, relationshipsTo: true, aliases: true } },
        aliases: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: q.limit,
    });
    return rows.filter((r) => r._count.evidenceLinks >= q.minEvidence);
  });

  app.get('/entities/:entityId', async (req) => {
    const { entityId } = z.object({ entityId: z.string() }).parse(req.params);
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      include: {
        aliases: true,
        mergedChildren: { select: { id: true, displayName: true, type: true } },
        mergeLog: { orderBy: { createdAt: 'desc' } },
        evidenceLinks: {
          include: {
            evidence: {
              select: { id: true, title: true, url: true, sourcePlatform: true, publishedAt: true, isDuplicate: true },
            },
          },
          take: 100,
        },
        relationshipsFrom: { include: { to: { select: { id: true, displayName: true, type: true } } } },
        relationshipsTo: { include: { from: { select: { id: true, displayName: true, type: true } } } },
      },
    });
    if (!entity) throw notFound('Entity not found');
    await assertProjectAccess(req, entity.projectId);
    return entity;
  });

  // Suggest merge candidates (§7) — scored, never auto-merged on name alone.
  app.get('/entities/:entityId/merge-candidates', async (req) => {
    const { entityId } = z.object({ entityId: z.string() }).parse(req.params);
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, include: { aliases: true } });
    if (!entity) throw notFound('Entity not found');
    await assertProjectAccess(req, entity.projectId);

    const others = await prisma.entity.findMany({
      where: { projectId: entity.projectId, type: entity.type, id: { not: entityId }, mergedIntoId: null },
      include: { aliases: true, _count: { select: { evidenceLinks: true } } },
      take: 500,
    });
    const scored = others
      .map((o) => ({ entity: o, ...scoreEntityMatch(entity, o) }))
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    return scored;
  });

  const MergeInput = z.object({ sourceEntityId: z.string(), reason: z.string().min(3).max(500) });
  app.post('/entities/:entityId/merge', async (req) => {
    const { entityId } = z.object({ entityId: z.string() }).parse(req.params);
    const { sourceEntityId, reason } = MergeInput.parse(req.body);
    if (sourceEntityId === entityId) throw badRequest('Cannot merge an entity into itself');

    const [target, source] = await Promise.all([
      prisma.entity.findUnique({ where: { id: entityId }, include: { aliases: true } }),
      prisma.entity.findUnique({ where: { id: sourceEntityId }, include: { aliases: true } }),
    ]);
    if (!target || !source) throw notFound('Entity not found');
    if (target.projectId !== source.projectId) throw badRequest('Entities belong to different projects');
    await assertProjectAccess(req, target.projectId, 'EDITOR');
    const u = currentUser(req);
    const match = scoreEntityMatch(target, source);

    await prisma.$transaction(async (tx) => {
      // repoint evidence links (ignore duplicates)
      const links = await tx.evidenceEntity.findMany({ where: { entityId: sourceEntityId } });
      for (const link of links) {
        await tx.evidenceEntity
          .update({ where: { id: link.id }, data: { entityId: entityId } })
          .catch(async () => {
            await tx.evidenceEntity.delete({ where: { id: link.id } });
          });
      }
      // absorb aliases + a NAME alias for the source's display name
      const aliasValues = new Set(target.aliases.map((a) => a.value.toLowerCase()));
      for (const a of [...source.aliases, { value: source.displayName, kind: 'NAME' }]) {
        if (aliasValues.has(a.value.toLowerCase())) continue;
        await tx.entityAlias
          .create({ data: { entityId, value: a.value, kind: (a as { kind?: string }).kind ?? 'NAME', source: 'USER' } })
          .catch(() => {});
      }
      await tx.entity.update({
        where: { id: sourceEntityId },
        data: { mergedIntoId: entityId, resolutionConfidence: 'HIGH' },
      });
      await tx.entityMergeLog.create({
        data: {
          entityId, action: 'MERGE', otherEntityId: sourceEntityId, reason,
          score: match.score, factorsJson: match.factors as object,
          performedBy: u.id, reversible: true,
        },
      });
    });

    await audit({
      projectId: target.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'ENTITY_MERGED',
      targetType: 'entity', targetId: entityId,
      summary: `Merged "${source.displayName}" into "${target.displayName}" (match score ${match.score.toFixed(2)})`,
      metadata: { sourceEntityId, factors: match.factors, reason },
    });
    return { ok: true, mergedInto: entityId, matchScore: match.score };
  });

  app.post('/entities/:entityId/unmerge', async (req) => {
    const { entityId } = z.object({ entityId: z.string() }).parse(req.params);
    const { childEntityId, reason } = z
      .object({ childEntityId: z.string(), reason: z.string().min(3).max(500) })
      .parse(req.body);
    const child = await prisma.entity.findUnique({ where: { id: childEntityId } });
    if (!child || child.mergedIntoId !== entityId) throw badRequest('That entity is not merged into this one');
    await assertProjectAccess(req, child.projectId, 'EDITOR');
    const u = currentUser(req);

    await prisma.$transaction(async (tx) => {
      await tx.entity.update({ where: { id: childEntityId }, data: { mergedIntoId: null, resolutionConfidence: 'LOW' } });
      await tx.entityMergeLog.create({
        data: { entityId, action: 'UNMERGE', otherEntityId: childEntityId, reason, performedBy: u.id, reversible: false },
      });
    });
    await audit({
      projectId: child.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'ENTITY_SEPARATED',
      targetType: 'entity', targetId: childEntityId, summary: `Separated "${child.displayName}" from ${entityId}`, metadata: { reason },
    });
    return { ok: true };
  });
}
