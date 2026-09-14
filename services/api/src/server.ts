import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { registerErrorHandler } from './lib/errors.js';
import { authPlugin } from './auth/plugin.js';
import { ensureLocalUser } from './auth/localUser.js';
import { projectRoutes } from './modules/projects.js';
import { connectorRoutes } from './modules/connectors.routes.js';
import { searchRoutes } from './modules/search.routes.js';
import { evidenceRoutes } from './modules/evidence.routes.js';
import { entityRoutes } from './modules/entities.routes.js';
import { jobRoutes } from './modules/jobs.routes.js';
import { intelligenceRoutes } from './modules/intelligence.routes.js';
import { documentRoutes } from './modules/documents.routes.js';
import { aiRoutes } from './modules/ai.routes.js';
import { mediaRoutes } from './modules/media.routes.js';
import { identityRoutes } from './modules/identity.routes.js';
import { monitoringRoutes } from './modules/monitoring.routes.js';
import { exportRoutes } from './modules/export.routes.js';
import { metricsRoutes } from './modules/metrics.routes.js';
import { godModeRoutes } from './modules/god-mode.routes.js';
import { dashboardRoutes } from './modules/dashboard.routes.js';
import { sseRoutes } from './realtime/sse.js';
import { registry } from './connectors/runtime.js';
import { transcriptionCapable } from './orchestrator/MediaEngine.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Single-user local-first (no login, every request auto-authenticated) is
 * only a safe default because nothing outside this machine can reach the
 * API. If API_HOST is ever pointed at a non-loopback address there is
 * genuinely no gate anymore, so refuse to start rather than silently run
 * wide open — this is the one guard rail the "remove login entirely" choice
 * still needs.
 */
function assertLocalOnly(env: { API_HOST: string }): void {
  if (!LOOPBACK_HOSTS.has(env.API_HOST.toLowerCase())) {
    throw new Error(
      `API_HOST=${env.API_HOST} is not a loopback address. This build has no login (single-user ` +
        'local-first) — binding beyond 127.0.0.1/localhost would expose every route with zero auth. ' +
        'Set API_HOST=127.0.0.1, or put a real auth layer in front before exposing this beyond your own machine.',
    );
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();
  assertLocalOnly(env);
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
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  registerErrorHandler(app);
  // Decorate the root instance directly so `authenticate` / `requireAdmin` are
  // inherited by every child scope (avoids needing fastify-plugin here).
  await authPlugin(app);

  // Health / readiness (§50)
  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/version', async () => ({ name: 'osint-platform-api', version: '0.1.0', node: process.version }));
  await app.register(metricsRoutes);

  // Feature/capability manifest so the frontend can render honest states (§31, §51)
  const getManifest = async () => {
    const transcription = await transcriptionCapable();
    return {
      connectors: registry.ids(),
      ai: { provider: env.AI_PROVIDER, embeddings: env.AI_EMBEDDINGS_PROVIDER },
      jobDriver: env.JOB_DRIVER,
      notImplemented: [
        ...(transcription.available ? [] : [`Video / audio transcription (${transcription.reason})`]),
        'Reverse image search (needs a provider API key)',
        'Distributed tracing (needs an OpenTelemetry collector)',
      ],
      implemented: [
        'Multi-source search orchestration + query planning + coverage reporting',
      'Evidence model with immutable IDs, content hashing, dedup + syndication clustering',
      'Deterministic entity extraction + scored/reversible entity resolution',
      'Evidence-traceable relationship graph',
      'Deterministic claim extraction + factor-based corroboration + contradiction detection',
      'Timeline derivation from evidence dates + dated claims',
      'Document ingestion (PDF/DOCX/TXT/CSV/JSON/HTML)',
      'Media intelligence — image metadata, EXIF/GPS, perceptual-hash duplicate detection; vision-model OCR/description when a multimodal model is configured',
      'Semantic search (when an embedding provider is configured)',
      'Monitoring — scheduled search jobs (cron), change detection against the existing evidence corpus (new vs. changed vs. suppressed-duplicate), rate-limit + error tracking per run',
      'Report export as PDF and DOCX (in addition to Markdown/HTML/JSON)',
      'Prometheus /metrics + per-job WHAT/WHERE/WHY/DATA-LOST/RETRY diagnostics, backup/restore scripts, migration integrity check',
      'Full evidence package export (.zip: evidence.json, sources/entities/relationships/timeline/claims/audit-log CSVs, report.pdf/docx, sha256 manifest)',
      'AI research analyst — evidence-grounded Q&A, AI query expansion, report generation (when an AI provider is configured); anti-hallucination citation validation',
      'Explainable confidence ("WHY?") with exposed factors',
      'God Mode — one TARGET/OBJECTIVE/DEPTH run composing every engine (search, evidence, entities, resolution, relationships, claims, corroboration, contradictions, timeline, report, monitoring recommendations) into the full §56 15-section result',
        'Username enumeration — WhatsMyName-dataset-driven existence checks across ~650 public platforms (no login, no scraping beyond a single public profile response); promote any FOUND hit straight into the evidence base',
        ...(transcription.available ? ['Video/audio transcription via ffmpeg + Whisper (when OPENAI_API_KEY is configured)'] : []),
        'Load/performance test harness (npm run load-test -w @osint/api)',
      ],
    };
  };
  const getReadyz = async (reply: import('fastify').FastifyReply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'ok', connectors: registry.ids().length };
    } catch (err) {
      reply.status(503);
      return { status: 'not-ready', db: 'error', error: (err as Error).message };
    }
  };
  app.get('/manifest', getManifest);
  app.get('/readyz', async (_req, reply) => getReadyz(reply));

  await app.register(
    async (api) => {
      // The SPA fetches everything through a single `/api/v1`-prefixed client,
      // so mirror the unauthenticated status routes here too (root paths above
      // stay for infra-standard health checks that expect no prefix).
      api.get('/readyz', async (_req, reply) => getReadyz(reply));
      api.get('/manifest', getManifest);
      // Single-user local-first: no login, so this always resolves to the one
      // local account rather than 401ing (see auth/plugin.ts, auth/localUser.ts).
      api.get('/auth/me', async () => {
        const user = await ensureLocalUser();
        const full = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        const projectCount = await prisma.project.count();
        return { id: full.id, email: full.email, displayName: full.displayName, role: full.role, projectCount };
      });
      await api.register(projectRoutes);
      await api.register(connectorRoutes);
      await api.register(searchRoutes);
      await api.register(evidenceRoutes);
      await api.register(entityRoutes);
      await api.register(intelligenceRoutes);
      await api.register(documentRoutes);
      await api.register(aiRoutes);
      await api.register(mediaRoutes);
      await api.register(identityRoutes);
      await api.register(monitoringRoutes);
      await api.register(exportRoutes);
      await api.register(godModeRoutes);
      await api.register(jobRoutes);
      await api.register(dashboardRoutes);
      await api.register(sseRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
