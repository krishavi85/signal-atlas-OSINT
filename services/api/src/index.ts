import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { disconnectDb, prisma } from './db.js';
import { buildServer } from './server.js';
import { ensureConnectorsSeeded } from './connectors/runtime.js';
import { checkAllConnectorHealth } from './connectors/health.js';
import { registerAllJobHandlers } from './jobs/handlers.js';
import { startJobRunner, stopJobRunner, enqueueJob } from './jobs/runner.js';
import { purgeExpiredCache } from './lib/cache.js';
import { findDueMonitoringJobs } from './orchestrator/MonitoringEngine.js';

async function main(): Promise<void> {
  const env = loadEnv();

  await ensureConnectorsSeeded();
  registerAllJobHandlers();
  startJobRunner();

  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(`API listening on http://${env.API_HOST}:${env.API_PORT}/api/v1`);

  // Background maintenance
  void checkAllConnectorHealth().catch((err) => logger.warn({ err }, 'initial connector health check failed'));
  const healthTimer = setInterval(
    () => void enqueueJob({ type: 'CONNECTOR_HEALTH', payload: {} }).catch(() => {}),
    15 * 60 * 1000,
  );
  const cacheTimer = setInterval(
    () => void purgeExpiredCache().then((n) => n && logger.debug(`purged ${n} expired cache rows`)),
    30 * 60 * 1000,
  );
  // Monitoring scheduler (§17): every minute, enqueue any job whose nextRunAt
  // has arrived. Enqueue-then-jobrunner keeps this consistent with manual
  // "run now" and gives monitoring runs the same retry/observability as any
  // other job.
  const monitoringTimer = setInterval(async () => {
    try {
      const due = await findDueMonitoringJobs();
      for (const monitoringJobId of due) {
        const job = await prisma.monitoringJob.findUnique({ where: { id: monitoringJobId } });
        if (!job) continue;
        // avoid double-enqueue if a run is already in flight for this job
        const alreadyQueued = await prisma.job.findFirst({
          where: { type: 'MONITORING_RUN', status: { in: ['QUEUED', 'RUNNING'] }, payloadJson: { equals: { monitoringJobId } } },
        });
        if (alreadyQueued) continue;
        await enqueueJob({ type: 'MONITORING_RUN', projectId: job.projectId, payload: { monitoringJobId } });
      }
    } catch (err) {
      logger.warn({ err }, 'monitoring scheduler tick failed');
    }
  }, 60 * 1000);

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    clearInterval(healthTimer);
    clearInterval(cacheTimer);
    clearInterval(monitoringTimer);
    await stopJobRunner();
    await app.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
