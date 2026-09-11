import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';
import { computeNextRun, validateCron } from '../orchestrator/MonitoringEngine.js';
import { registry } from '../connectors/runtime.js';

const CRON_PRESETS: Record<string, string> = {
  HOURLY: '0 * * * *',
  EVERY_6H: '0 */6 * * *',
  EVERY_12H: '0 */12 * * *',
  DAILY: '0 8 * * *',
  WEEKLY: '0 8 * * 1',
};

const CreateMonitoring = z.object({
  name: z.string().min(1).max(200),
  query: z.string().min(1).max(500),
  connectorIds: z.array(z.string()).optional(),
  languages: z.array(z.string().min(2).max(8)).default(['en']),
  schedule: z.union([z.enum(['HOURLY', 'EVERY_6H', 'EVERY_12H', 'DAILY', 'WEEKLY']), z.string()]),
  enabled: z.boolean().default(true),
});

function resolveCron(schedule: string): string {
  return CRON_PRESETS[schedule] ?? schedule;
}

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/monitoring/presets', async () => ({
    presets: Object.entries(CRON_PRESETS).map(([key, cron]) => ({ key, cron, nextRun: computeNextRun(cron) })),
    connectors: registry.ids(),
  }));

  app.get('/projects/:id/monitoring', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.monitoringJob.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { results: true } } },
    });
  });

  app.post('/projects/:id/monitoring', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const input = CreateMonitoring.parse(req.body);
    const cron = resolveCron(input.schedule);
    const check = validateCron(cron);
    if (!check.valid) throw badRequest(`Invalid schedule: ${check.error}`);

    const job = await prisma.monitoringJob.create({
      data: {
        projectId: id,
        name: input.name,
        query: input.query,
        connectorIds: input.connectorIds ?? undefined,
        scheduleCron: cron,
        languages: input.languages.join(','),
        enabled: input.enabled,
        nextRunAt: computeNextRun(cron),
      },
    });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'monitoring_job', targetId: job.id, summary: `Created monitoring job "${job.name}" (${cron})`,
    });
    reply.status(201).send(job);
  });

  app.get('/monitoring/:jobId', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Monitoring job not found');
    await assertProjectAccess(req, job.projectId);
    return job;
  });

  app.get('/monitoring/:jobId/results', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Monitoring job not found');
    await assertProjectAccess(req, job.projectId);
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return prisma.monitoringResult.findMany({ where: { monitoringJobId: jobId }, orderBy: { runAt: 'desc' }, take: q.limit });
  });

  app.patch('/monitoring/:jobId', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Monitoring job not found');
    await assertProjectAccess(req, job.projectId, 'EDITOR');
    const u = currentUser(req);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        query: z.string().min(1).max(500).optional(),
        connectorIds: z.array(z.string()).optional(),
        schedule: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.query !== undefined) data.query = body.query;
    if (body.connectorIds !== undefined) data.connectorIds = body.connectorIds;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.schedule !== undefined) {
      const cron = resolveCron(body.schedule);
      const check = validateCron(cron);
      if (!check.valid) throw badRequest(`Invalid schedule: ${check.error}`);
      data.scheduleCron = cron;
      data.nextRunAt = computeNextRun(cron);
    }
    const updated = await prisma.monitoringJob.update({ where: { id: jobId }, data });
    await audit({
      projectId: job.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'monitoring_job', targetId: jobId, summary: `Updated monitoring job "${updated.name}"`, metadata: { changed: Object.keys(data) },
    });
    return updated;
  });

  app.post('/monitoring/:jobId/run', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Monitoring job not found');
    await assertProjectAccess(req, job.projectId, 'EDITOR');
    const jid = await enqueueJob({ type: 'MONITORING_RUN', projectId: job.projectId, payload: { monitoringJobId: jobId }, priority: 1 });
    return { jobId: jid };
  });

  app.delete('/monitoring/:jobId', async (req, reply) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.monitoringJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Monitoring job not found');
    await assertProjectAccess(req, job.projectId, 'EDITOR');
    const u = currentUser(req);
    await prisma.monitoringJob.delete({ where: { id: jobId } });
    await audit({
      projectId: job.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'USER_MODIFICATION',
      targetType: 'monitoring_job', targetId: jobId, summary: `Deleted monitoring job "${job.name}"`,
    });
    reply.status(204).send();
  });
}
