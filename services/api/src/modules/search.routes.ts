import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBooleanQuery } from '@osint/core';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';
import { planQueries } from '../orchestrator/QueryPlanner.js';
import { allConnectorReports } from '../connectors/runtime.js';

const StartSearch = z.object({
  query: z.string().min(1).max(500),
  subjectType: z.enum(['PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'DOMAIN', 'USERNAME', 'TOPIC']).optional(),
  objective: z.string().max(1000).optional(),
  dateAfter: z.string().datetime().optional(),
  dateBefore: z.string().datetime().optional(),
  languages: z.array(z.string().min(2).max(8)).optional(),
  depth: z.enum(['QUICK', 'STANDARD', 'DEEP']).default('STANDARD'),
  connectors: z.array(z.string()).optional(),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // Preview the plan without executing (§46 coverage transparency).
  app.post('/projects/:id/search/preview', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const input = StartSearch.parse(req.body);
    const parsed = parseBooleanQuery(input.query);
    const { queries, parsedWarnings } = planQueries({
      originalQuery: input.query,
      subjectType: input.subjectType ?? null,
      depth: input.depth,
    });
    const reports = await allConnectorReports();
    const coverage = reports.map((r) => {
      const searchable = r.effective.SEARCH_SUPPORTED === true;
      return {
        connectorId: r.connectorId,
        displayName: r.displayName,
        category: r.category,
        willRun: searchable && (!input.connectors || input.connectors.includes(r.connectorId)),
        status: searchable ? 'AVAILABLE' : 'UNAVAILABLE',
        reason: searchable ? null : r.gaps.find((g) => g.capability === 'ALL' || g.capability === 'SEARCH_SUPPORTED')?.message ?? 'Search not supported',
      };
    });
    return { parsed, plannedQueries: queries, parsedWarnings, coverage };
  });

  app.post('/projects/:id/search', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    if (project.status !== 'ACTIVE') throw badRequest(`Project is ${project.status}; resume it to run searches`);
    const input = StartSearch.parse(req.body);

    const search = await prisma.search.create({
      data: {
        projectId: id,
        originalQuery: input.query,
        subjectType: input.subjectType,
        objective: input.objective ?? project.objective,
        dateAfter: input.dateAfter ? new Date(input.dateAfter) : project.dateRangeStart,
        dateBefore: input.dateBefore ? new Date(input.dateBefore) : project.dateRangeEnd,
        languages: (input.languages ?? project.defaultLanguages.split(',')).join(','),
        depth: input.depth,
        requestedConnectors: input.connectors ?? undefined,
        status: 'PLANNED',
      },
    });

    const jobId = await enqueueJob({
      type: 'RESEARCH_RUN',
      projectId: id,
      payload: { searchId: search.id },
      priority: input.depth === 'DEEP' ? 1 : 0,
    });
    await prisma.search.update({ where: { id: search.id }, data: { jobId } });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED',
      targetType: 'search', targetId: search.id, summary: `Queued search "${input.query}" (${input.depth})`,
    });

    reply.status(202).send({ searchId: search.id, jobId, status: 'PLANNED' });
  });

  app.get('/projects/:id/searches', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return prisma.search.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { _count: { select: { evidence: true, runs: true, queries: true } } },
    });
  });

  app.get('/searches/:searchId', async (req) => {
    const { searchId } = z.object({ searchId: z.string() }).parse(req.params);
    const search = await prisma.search.findUnique({
      where: { id: searchId },
      include: {
        queries: { orderBy: { createdAt: 'asc' } },
        runs: { include: { connector: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { evidence: true } },
      },
    });
    if (!search) throw notFound('Search not found');
    await assertProjectAccess(req, search.projectId);
    const job = search.jobId ? await prisma.job.findUnique({ where: { id: search.jobId } }) : null;

    // §46 coverage summary
    const byConnector = new Map<string, { completed: number; failed: number; skipped: number; skippedReason?: string; hits: number }>();
    for (const run of search.runs) {
      const e = byConnector.get(run.connectorId) ?? { completed: 0, failed: 0, skipped: 0, hits: 0 };
      if (run.status === 'COMPLETED') e.completed += 1;
      if (run.status === 'FAILED') e.failed += 1;
      if (run.status === 'SKIPPED') {
        e.skipped += 1;
        e.skippedReason = run.skippedReason ?? undefined;
      }
      e.hits += run.rawHitCount;
      byConnector.set(run.connectorId, e);
    }
    const coverage = [...byConnector.entries()].map(([connectorId, v]) => ({
      connectorId,
      state:
        v.completed > 0 && v.failed === 0 ? 'COMPLETED'
        : v.completed > 0 ? 'PARTIAL'
        : v.skipped > 0 ? 'NOT_RUN'
        : 'FAILED',
      hits: v.hits,
      note: v.skippedReason,
    }));

    return { ...search, job, coverage };
  });

  app.get('/searches/:searchId/results', async (req) => {
    const { searchId } = z.object({ searchId: z.string() }).parse(req.params);
    const search = await prisma.search.findUnique({ where: { id: searchId } });
    if (!search) throw notFound('Search not found');
    await assertProjectAccess(req, search.projectId);
    const q = z
      .object({
        includeDuplicates: z.coerce.boolean().default(false),
        limit: z.coerce.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);

    const rows = await prisma.evidence.findMany({
      where: { searchId, ...(q.includeDuplicates ? {} : { isDuplicate: false }) },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        source: { select: { label: true, tier: true, qualityScore: true } },
        _count: { select: { entities: true, duplicates: true } },
      },
    });
    const nextCursor = rows.length > q.limit ? rows.pop()!.id : null;
    return { items: rows, nextCursor };
  });

  app.post('/searches/:searchId/cancel', async (req) => {
    const { searchId } = z.object({ searchId: z.string() }).parse(req.params);
    const search = await prisma.search.findUnique({ where: { id: searchId } });
    if (!search) throw notFound('Search not found');
    await assertProjectAccess(req, search.projectId, 'EDITOR');
    if (search.jobId) {
      const { cancelJob } = await import('../jobs/runner.js');
      await cancelJob(search.jobId);
    }
    await prisma.search.update({ where: { id: searchId }, data: { status: 'CANCELLED' } });
    return { ok: true };
  });
}
