import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { disconnectDb } from './db.js';
import { buildServer } from './server.js';
import { ensureConnectorsSeeded } from './connectors/runtime.js';
import { checkAllConnectorHealth } from './connectors/health.js';
import { registerAllJobHandlers } from './jobs/handlers.js';
import { startJobRunner, stopJobRunner, enqueueJob } from './jobs/runner.js';
import { purgeExpiredCache } from './lib/cache.js';

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

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    clearInterval(healthTimer);
    clearInterval(cacheTimer);
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
