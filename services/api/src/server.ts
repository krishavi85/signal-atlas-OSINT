import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { registerErrorHandler } from './lib/errors.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { projectRoutes } from './modules/projects.js';
import { connectorRoutes } from './modules/connectors.routes.js';
import { searchRoutes } from './modules/search.routes.js';
import { evidenceRoutes } from './modules/evidence.routes.js';
import { entityRoutes } from './modules/entities.routes.js';
import { jobRoutes } from './modules/jobs.routes.js';
import { dashboardRoutes } from './modules/dashboard.routes.js';
import { sseRoutes } from './realtime/sse.js';
import { registry } from './connectors/runtime.js';

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });

  registerErrorHandler(app);
  // Decorate the root instance directly so `authenticate` / `requireAdmin` are
  // inherited by every child scope (avoids needing fastify-plugin here).
  await authPlugin(app);

  // Health / readiness (§50)
  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'ok', connectors: registry.ids().length };
    } catch (err) {
      reply.status(503);
      return { status: 'not-ready', db: 'error', error: (err as Error).message };
    }
  });
  app.get('/version', async () => ({ name: 'osint-platform-api', version: '0.1.0', node: process.version }));

  // Feature/capability manifest so the frontend can render honest states (§31, §51)
  app.get('/manifest', async () => ({
    connectors: registry.ids(),
    ai: { provider: env.AI_PROVIDER, embeddings: env.AI_EMBEDDINGS_PROVIDER },
    jobDriver: env.JOB_DRIVER,
    notImplemented: [
      'AI synthesis & report generation (Phase 5/8)',
      'Knowledge graph & timeline UI (Phase 6)',
      'Monitoring engine (Phase 7)',
      'Document ingestion pipeline (Phase 3)',
      'Semantic / vector search (needs embeddings + pgvector)',
    ],
  }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(projectRoutes);
      await api.register(connectorRoutes);
      await api.register(searchRoutes);
      await api.register(evidenceRoutes);
      await api.register(entityRoutes);
      await api.register(jobRoutes);
      await api.register(dashboardRoutes);
      await api.register(sseRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
