import type { FastifyInstance } from 'fastify';
import type { Job } from '@prisma/client';
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

  // §50: every failed operation should explain WHAT failed, WHERE, WHY,
  // whether data was lost, and how to retry — assembled here rather than left
  // for the operator to reconstruct from a raw stack trace.
  app.get('/jobs/:jobId/diagnostics', async (req) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Job not found');
    if (job.projectId) await assertProjectAccess(req, job.projectId);
    return buildJobDiagnostics(job);
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

const JOB_TYPE_LABEL: Record<string, string> = {
  RESEARCH_RUN: 'a research run (search → normalize → dedupe → entities/claims/timeline)',
  DOCUMENT_INGEST: 'document ingestion (text/metadata extraction from an uploaded file)',
  URL_INGEST: 'fetching a user-provided URL (optionally JS-rendered) into evidence',
  MEDIA_PROCESS: 'media processing (fetch, metadata, perceptual hash, optional vision OCR)',
  MONITORING_RUN: 'a scheduled monitoring run',
  REPORT_GENERATE: 'report generation',
  AI_ANALYSIS: 'an AI analysis (semantic-index backfill or similar)',
  CONNECTOR_HEALTH: 'a connector health sweep',
};

interface JobDiagnostics {
  jobId: string;
  what: string;
  where: string;
  why: string;
  dataLost: string;
  howToRetry: string;
  status: string;
  attempts: number;
  maxAttempts: number;
}

/**
 * Turn a raw Job row into the WHAT/WHERE/WHY/DATA-LOST/RETRY explanation
 * required by §50. Deliberately rule-based on job type + status + the error
 * string already recorded — never invents detail the job didn't actually report.
 */
export function buildJobDiagnostics(job: Job): JobDiagnostics {
  const what = JOB_TYPE_LABEL[job.type] ?? `a "${job.type}" job`;
  const where = job.error ? locateFailure(job.error) : job.status === 'RUNNING' ? 'currently executing' : 'no failure recorded';

  let why: string;
  let dataLost: string;
  let howToRetry: string;

  switch (job.status) {
    case 'COMPLETED':
      why = 'N/A — the job completed successfully.';
      dataLost = 'None.';
      howToRetry = 'Not applicable; re-run manually if you want fresher results.';
      break;
    case 'CANCELLED':
      why = 'The job was cancelled by a user before it finished.';
      dataLost = 'Any work completed before cancellation was already committed (evidence/entities persisted so far are kept); work after the cancellation point did not run.';
      howToRetry = `POST /jobs/${job.id}/retry, or start a new one — cancellation does not corrupt state.`;
      break;
    case 'QUEUED':
      why = job.attempts > 0 ? `Failed ${job.attempts} time(s) and was automatically re-queued for retry.` : 'Waiting for a worker slot.';
      dataLost = 'None so far.';
      howToRetry = 'No action needed — the in-process job runner will pick it up. Use /jobs/:id/cancel to stop it instead.';
      break;
    case 'RUNNING':
      why = 'In progress.';
      dataLost = 'N/A — nothing has failed.';
      howToRetry = 'Not applicable while running. It will resume/retry automatically if it fails.';
      break;
    case 'PARTIAL':
      why = job.error ?? 'Some sub-steps (e.g. individual connectors) failed while others completed; see the job/search detail for per-step status.';
      dataLost = 'None — results from the steps that succeeded were kept. Only the failed step(s) produced nothing.';
      howToRetry = `POST /jobs/${job.id}/retry re-runs only the steps that did not complete (e.g. failed connectors), not the whole job.`;
      break;
    case 'FAILED':
    default:
      why = job.error ?? 'No error message was recorded for this failure.';
      dataLost =
        job.attempts >= job.maxAttempts
          ? `Exhausted ${job.maxAttempts} attempt(s) with no successful run — no results from this job were persisted.`
          : 'This attempt produced no results; a prior successful run (if any) is untouched.';
      howToRetry =
        job.attempts >= job.maxAttempts
          ? `Automatic retries are exhausted. Fix the underlying cause (see WHY), then POST /jobs/${job.id}/retry to try again.`
          : 'The job runner will retry automatically with backoff.';
  }

  return {
    jobId: job.id,
    what,
    where,
    why,
    dataLost,
    howToRetry,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
  };
}

function locateFailure(error: string): string {
  const httpStatus = /HTTP \d+/.exec(error)?.[0];
  const connector = /connector\s+"([^"]+)"/i.exec(error)?.[1];
  if (connector && httpStatus) return `the "${connector}" connector (${httpStatus})`;
  if (connector) return `the "${connector}" connector`;
  if (httpStatus) return `an upstream HTTP request (${httpStatus})`;
  if (/database|prisma|sqlite/i.test(error)) return 'the database layer';
  if (/AI unavailable|OPENAI|ANTHROPIC|ollama/i.test(error)) return 'the AI provider call';
  const m = /^([A-Za-z][\w.-]*):/.exec(error);
  if (m) return `${m[1]}`;
  return 'unspecified step (see the error message)';
}
