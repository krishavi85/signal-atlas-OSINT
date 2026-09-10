import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';
import { jobBus } from './events.js';

/**
 * DB-backed job runner (§37).
 *
 *  - states: QUEUED → RUNNING → COMPLETED | PARTIAL | FAILED | CANCELLED (+ PAUSED)
 *  - a job row carries `progressJson` and `stepsJson` so a failed step can be
 *    retried without re-running completed steps.
 *  - `JOB_DRIVER=inprocess` (default): this single poller. `redis`: not bundled
 *    — the interface below is what a BullMQ adapter would implement.
 */

export type JobType =
  | 'RESEARCH_RUN'
  | 'CONNECTOR_HEALTH'
  | 'DOCUMENT_INGEST'
  | 'MONITORING_RUN'
  | 'REPORT_GENERATE'
  | 'AI_ANALYSIS';

export interface JobContext {
  jobId: string;
  projectId: string | null;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  /** merge-patch the job's progress object and notify subscribers */
  reportProgress: (patch: Record<string, unknown>) => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<{ status: 'COMPLETED' | 'PARTIAL'; result?: unknown }>;

const handlers = new Map<JobType, JobHandler>();
export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;

let running = false;
let timer: NodeJS.Timeout | null = null;
const activeControllers = new Map<string, AbortController>();

export async function enqueueJob(input: {
  type: JobType;
  projectId?: string | null;
  payload: Record<string, unknown>;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
}): Promise<string> {
  const job = await prisma.job.create({
    data: {
      type: input.type,
      projectId: input.projectId ?? null,
      payloadJson: input.payload as Prisma.InputJsonValue,
      priority: input.priority ?? 0,
      scheduledAt: input.scheduledAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      progressJson: {},
    },
  });
  jobBus.publish({ jobId: job.id, projectId: job.projectId, type: job.type, status: 'QUEUED', at: new Date().toISOString() });
  return job.id;
}

export async function cancelJob(jobId: string): Promise<void> {
  activeControllers.get(jobId)?.abort();
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job) jobBus.publish({ jobId, projectId: job.projectId, type: job.type, status: 'CANCELLED', at: new Date().toISOString() });
}

export function startJobRunner(): void {
  const env = loadEnv();
  if (env.JOB_DRIVER === 'redis') {
    logger.warn('JOB_DRIVER=redis is not bundled in this build; falling back to in-process runner. See ROADMAP.');
  }
  if (running) return;
  running = true;
  logger.info({ worker: WORKER_ID }, 'job runner started (in-process)');
  const loop = async () => {
    if (!running) return;
    try {
      await claimAndRunOne();
    } catch (err) {
      logger.error({ err }, 'job runner loop error');
    }
    timer = setTimeout(loop, POLL_INTERVAL_MS);
  };
  void loop();
}

export async function stopJobRunner(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  for (const c of activeControllers.values()) c.abort();
  // give active jobs a moment
  await new Promise((r) => setTimeout(r, 200));
}

async function claimAndRunOne(): Promise<void> {
  // release stale locks
  await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    data: { status: 'QUEUED', lockedBy: null, lockedAt: null },
  });

  const candidate = await prisma.job.findFirst({
    where: { status: 'QUEUED', scheduledAt: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }, { scheduledAt: 'asc' }],
  });
  if (!candidate) return;

  // optimistic lock
  const claimed = await prisma.job.updateMany({
    where: { id: candidate.id, status: 'QUEUED' },
    data: { status: 'RUNNING', lockedBy: WORKER_ID, lockedAt: new Date(), startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return; // lost the race

  const job = await prisma.job.findUniqueOrThrow({ where: { id: candidate.id } });
  const handler = handlers.get(job.type as JobType);
  jobBus.publish({ jobId: job.id, projectId: job.projectId, type: job.type, status: 'RUNNING', at: new Date().toISOString() });

  if (!handler) {
    await failJob(job.id, job.projectId, job.type, `No handler registered for job type ${job.type}`, false);
    return;
  }

  const controller = new AbortController();
  activeControllers.set(job.id, controller);
  try {
    const result = await handler({
      jobId: job.id,
      projectId: job.projectId,
      payload: (job.payloadJson ?? {}) as Record<string, unknown>,
      signal: controller.signal,
      reportProgress: async (patch) => {
        const current = await prisma.job.findUnique({ where: { id: job.id }, select: { progressJson: true } });
        const merged = { ...((current?.progressJson as object) ?? {}), ...patch };
        await prisma.job.update({ where: { id: job.id }, data: { progressJson: merged as Prisma.InputJsonValue } });
        jobBus.publish({
          jobId: job.id,
          projectId: job.projectId,
          type: job.type,
          status: 'RUNNING',
          progress: merged,
          at: new Date().toISOString(),
        });
      },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: result.status, finishedAt: new Date(), lockedBy: null, lockedAt: null, error: null },
    });
    jobBus.publish({ jobId: job.id, projectId: job.projectId, type: job.type, status: result.status, at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof Error && err.name === 'AbortError') && job.attempts < job.maxAttempts;
    if (controller.signal.aborted) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'CANCELLED', finishedAt: new Date(), lockedBy: null, lockedAt: null } });
    } else {
      await failJob(job.id, job.projectId, job.type, msg, retryable);
    }
  } finally {
    activeControllers.delete(job.id);
  }
}

async function failJob(jobId: string, projectId: string | null, type: string, message: string, retry: boolean): Promise<void> {
  if (retry) {
    const backoffSec = 15;
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'QUEUED', error: message, lockedBy: null, lockedAt: null, scheduledAt: new Date(Date.now() + backoffSec * 1000) },
    });
    logger.warn({ jobId, type }, `job failed, will retry: ${message}`);
    jobBus.publish({ jobId, projectId, type, status: 'RETRY_SCHEDULED', error: message, at: new Date().toISOString() });
  } else {
    await prisma.job.update({ where: { id: jobId }, data: { status: 'FAILED', error: message, finishedAt: new Date(), lockedBy: null, lockedAt: null } });
    logger.error({ jobId, type }, `job failed permanently: ${message}`);
    jobBus.publish({ jobId, projectId, type, status: 'FAILED', error: message, at: new Date().toISOString() });
  }
}
