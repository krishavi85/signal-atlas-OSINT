import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { assertProjectAccess } from './projects.js';
import { allConnectorReports } from '../connectors/runtime.js';

/**
 * Home dashboard aggregate (§25) and per-project overview (§21 "Overview").
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/dashboard', async (req) => {
    const u = currentUser(req);
    const projectIds = (await prisma.projectMember.findMany({ where: { userId: u.id }, select: { projectId: true } })).map(
      (m) => m.projectId,
    );

    const [activeProjects, recentEvidence, runningJobs, failedJobs, unverifiedClaims, contradictions, connectors] =
      await Promise.all([
        prisma.project.count({ where: { id: { in: projectIds }, status: 'ACTIVE' } }),
        prisma.evidence.findMany({
          where: { projectId: { in: projectIds }, isDuplicate: false },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, title: true, url: true, sourcePlatform: true, projectId: true, createdAt: true },
        }),
        prisma.job.count({ where: { projectId: { in: projectIds }, status: 'RUNNING' } }),
        prisma.job.count({ where: { projectId: { in: projectIds }, status: 'FAILED' } }),
        prisma.claim.count({ where: { projectId: { in: projectIds }, corroboration: { in: ['UNVERIFIED', 'SINGLE_SOURCE'] } } }),
        prisma.contradiction.count({ where: { projectId: { in: projectIds }, status: 'OPEN' } }),
        allConnectorReports(),
      ]);

    const connectorHealth = await prisma.connectorHealthCheck.findMany({ orderBy: { checkedAt: 'desc' } });
    const latestHealth = new Map<string, string>();
    for (const h of connectorHealth) if (!latestHealth.has(h.connectorId)) latestHealth.set(h.connectorId, h.state);

    const monitoring = await prisma.monitoringJob.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, name: true, enabled: true, lastRunAt: true, nextRunAt: true, lastError: true, projectId: true },
    });

    return {
      activeProjects,
      runningJobs,
      failedJobs,
      unverifiedClaims,
      contradictions,
      recentEvidence,
      sourceHealth: connectors.map((c) => ({
        connectorId: c.connectorId,
        displayName: c.displayName,
        available: c.effective.SEARCH_SUPPORTED === true || c.effective.FETCH_SUPPORTED === true,
        health: latestHealth.get(c.connectorId) ?? 'UNKNOWN',
        gaps: c.gaps.map((g) => g.message),
      })),
      monitoring,
    };
  });

  app.get('/projects/:id/overview', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);

    const [project, evidence, dupes, entities, entityByType, claims, timeline, latestSearch, openContradictions, mediaCount, mediaWithGps] =
      await Promise.all([
        prisma.project.findUniqueOrThrow({ where: { id } }),
        prisma.evidence.count({ where: { projectId: id, isDuplicate: false } }),
        prisma.evidence.count({ where: { projectId: id, isDuplicate: true } }),
        prisma.entity.count({ where: { projectId: id, mergedIntoId: null } }),
        prisma.entity.groupBy({ by: ['type'], where: { projectId: id, mergedIntoId: null }, _count: true }),
        prisma.claim.groupBy({ by: ['corroboration'], where: { projectId: id }, _count: true }),
        prisma.timelineEvent.count({ where: { projectId: id } }),
        prisma.search.findFirst({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { evidence: true } } } }),
        prisma.contradiction.count({ where: { projectId: id, status: 'OPEN' } }),
        prisma.mediaAsset.count({ where: { projectId: id, duplicateOfId: null } }),
        prisma.mediaAsset.count({ where: { projectId: id, gpsLat: { not: null } } }),
      ]);

    const topSources = await prisma.source.findMany({
      where: { evidence: { some: { projectId: id } } },
      orderBy: { qualityScore: 'desc' },
      take: 10,
      select: { label: true, tier: true, qualityScore: true, platform: true, _count: { select: { evidence: true } } },
    });

    return {
      project,
      counts: {
        evidence,
        duplicatesSuppressed: dupes,
        entities,
        timelineEvents: timeline,
        openContradictions,
        media: mediaCount,
        mediaWithGps,
      },
      entityByType: entityByType.map((e) => ({ type: e.type, count: e._count })),
      claimsByCorroboration: claims.map((c) => ({ corroboration: c.corroboration, count: c._count })),
      latestSearch,
      topSources,
    };
  });
}
