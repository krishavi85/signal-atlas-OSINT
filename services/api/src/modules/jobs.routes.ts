import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { cancelJob, enqueueJob } from '../jobs/runner.js';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/projects/:id/jobs', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return prisma.job.findMany({
      where: { projectId: id, ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
  });

  app.get('/jobs/:jobId', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Job not found');
    if (job.projectId) await assertProjectAccess(req, job.projectId);
    return job;
  });

  app.post('/jobs/:jobId/cancel', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Job not found');
    if (job.projectId) await assertProjectAccess(req, job.projectId, 'EDITOR');
    await cancelJob(jobId);
    return { ok: true };
  });

  // Retry a failed job's failed steps without restarting completed work (§37).
  app.post('/jobs/:jobId/retry', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Job not found');
    if (job.projectId) await assertProjectAccess(req, job.projectId, 'EDITOR');
    if (!['FAILED', 'PARTIAL', 'CANCELLED'].includes(job.status)) {
      return { ok: false, message: `Job is ${job.status}; only FAILED/PARTIAL/CANCELLED jobs can be retried` };
    }
    // For RESEARCH_RUN, re-enqueue only the connectors that did not complete.
    if (job.type === 'RESEARCH_RUN') {
      const searchId = String((job.payloadJson as Record<string, unknown>).searchId ?? '');
      const failedRuns = await prisma.searchRun.findMany({
        where: { searchId, status: { in: ['FAILED', 'RATE_LIMITED'] } },
        distinct: ['connectorId'],
        select: { connectorId: true },
      });
      const newJobId = await enqueueJob({
        type: 'RESEARCH_RUN',
        projectId: job.projectId,
        payload: { searchId, retryOf: jobId, onlyConnectors: failedRuns.map((r) => r.connectorId) },
      });
      return { ok: true, newJobId, retryingConnectors: failedRuns.map((r) => r.connectorId) };
    }
    await prisma.job.update({ where: { id: jobId }, data: { status: 'QUEUED', attempts: 0, error: null, scheduledAt: new Date() } });
    return { ok: true, jobId };
  });
}
