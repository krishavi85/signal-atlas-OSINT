import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';

/**
 * God Mode (§55, §56): one entry point that accepts TARGET / OBJECTIVE /
 * DATE RANGE / SOURCES / DEPTH / LANGUAGES and runs the complete pipeline
 * autonomously as a single background job.
 */
const StartGodMode = z.object({
  target: z.string().min(1).max(300),
  objective: z.string().max(2000).optional(),
  subjectType: z.enum(['PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'DOMAIN', 'USERNAME', 'TOPIC']).optional(),
  depth: z.enum(['QUICK', 'STANDARD', 'DEEP']).default('DEEP'),
  languages: z.array(z.string().min(2).max(8)).default(['en']),
  dateRangeStart: z.string().datetime().optional(),
  dateRangeEnd: z.string().datetime().optional(),
  connectorIds: z.array(z.string()).optional(), // omit = "all configured lawful public sources"
});

export async function godModeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.post('/projects/:id/god-mode', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    if (project.status !== 'ACTIVE') throw badRequest(`Project is ${project.status}; resume it to run God Mode`);
    const input = StartGodMode.parse(req.body);

    const run = await prisma.godModeRun.create({
      data: {
        projectId: id,
        target: input.target,
        objective: input.objective ?? project.objective,
        subjectType: input.subjectType,
        depth: input.depth,
        languages: input.languages.join(','),
        dateRangeStart: input.dateRangeStart ? new Date(input.dateRangeStart) : project.dateRangeStart,
        dateRangeEnd: input.dateRangeEnd ? new Date(input.dateRangeEnd) : project.dateRangeEnd,
        requestedConnectors: input.connectorIds ?? undefined,
        status: 'QUEUED',
        createdById: u.id,
      },
    });
    const jobId = await enqueueJob({
      type: 'GOD_MODE_RUN',
      projectId: id,
      payload: { godModeRunId: run.id, userId: u.id },
      priority: 2,
    });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'AI_ANALYSIS_EXECUTED',
      targetType: 'god_mode_run', targetId: run.id,
      summary: `Started God Mode run for "${input.target}" (${input.depth})`,
    });
    reply.status(202).send({ godModeRunId: run.id, jobId });
  });

  app.get('/projects/:id/god-mode', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.godModeRun.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, target: true, depth: true, status: true, createdAt: true, completedAt: true, reportId: true },
    });
  });

  app.get('/god-mode/:runId', async (req) => {
    const { runId } = z.object({ runId: z.string() }).parse(req.params);
    const run = await prisma.godModeRun.findUnique({ where: { id: runId } });
    if (!run) throw notFound('God Mode run not found');
    await assertProjectAccess(req, run.projectId);
    return run;
  });

  // Create the recommended monitoring job(s) on explicit user action — never automatic (§17).
  app.post('/god-mode/:runId/create-monitoring', async (req, reply) => {
    const { runId } = z.object({ runId: z.string() }).parse(req.params);
    const { index } = z.object({ index: z.coerce.number().min(0).default(0) }).parse(req.body ?? {});
    const run = await prisma.godModeRun.findUnique({ where: { id: runId } });
    if (!run) throw notFound('God Mode run not found');
    await assertProjectAccess(req, run.projectId, 'EDITOR');
    const u = currentUser(req);
    const result = run.resultJson as { monitoringRecommendations?: Array<{ name: string; query: string; schedule: string; connectorIds: string[] | null }> } | null;
    const rec = result?.monitoringRecommendations?.[index];
    if (!rec) throw badRequest('No such monitoring recommendation on this run');

    const CRON: Record<string, string> = { HOURLY: '0 * * * *', EVERY_6H: '0 */6 * * *', EVERY_12H: '0 */12 * * *', DAILY: '0 8 * * *', WEEKLY: '0 8 * * 1' };
    const { computeNextRun } = await import('../orchestrator/MonitoringEngine.js');
    const cron = CRON[rec.schedule] ?? CRON.DAILY!;
    const job = await prisma.monitoringJob.create({
      data: {
        projectId: run.projectId,
        name: rec.name,
        query: rec.query,
        connectorIds: rec.connectorIds ?? undefined,
        scheduleCron: cron,
        enabled: true,
        nextRunAt: computeNextRun(cron),
      },
    });
    await audit({
      projectId: run.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'monitoring_job', targetId: job.id, summary: `Created monitoring job "${job.name}" from a God Mode recommendation`,
    });
    reply.status(201).send(job);
  });
}
