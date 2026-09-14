import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { currentUser } from '../auth/plugin.js';
import { enqueueJob } from '../jobs/runner.js';
import { ingestUrlOrExplain } from '../orchestrator/UrlIngest.js';
import { loadIdentityDataset, filterSites } from '../lib/whatsMyName.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // Capability probe: dataset availability + how many sites it'll check,
  // shown up front rather than the user discovering it mid-scan (§51).
  app.get('/identity/status', async () => {
    try {
      const dataset = await loadIdentityDataset();
      const sites = filterSites(dataset.sites, { includeNsfw: false });
      const categories = [...new Set(sites.map((s) => s.category).filter((c): c is string => Boolean(c)))].sort();
      return { available: true, source: dataset.source, fetchedAt: dataset.fetchedAt, siteCount: sites.length, categories };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  });

  app.post('/projects/:id/identity/scan', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const { username } = z.object({ username: z.string().trim().min(1).max(64) }).parse(req.body ?? {});
    if (!USERNAME_RE.test(username)) {
      throw badRequest('Username may only contain letters, digits, "." "_" "-" (1-64 chars).');
    }
    const u = currentUser(req);

    const scan = await prisma.identityScan.create({ data: { projectId: id, username, status: 'QUEUED' } });
    const jobId = await enqueueJob({ type: 'IDENTITY_SCAN', projectId: id, payload: { scanId: scan.id } });
    await prisma.identityScan.update({ where: { id: scan.id }, data: { jobId } });
    await audit({
      projectId: id,
      actorId: u.id,
      actorLabel: `user:${u.email}`,
      action: 'SEARCH_EXECUTED',
      targetType: 'identity_scan',
      targetId: scan.id,
      summary: `Started username scan for "${username}"`,
    });
    reply.status(202).send({ scanId: scan.id, jobId });
  });

  app.get('/projects/:id/identity/scans', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const scans = await prisma.identityScan.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return scans;
  });

  app.get('/identity/scans/:scanId', async (req) => {
    const { scanId } = z.object({ scanId: z.string() }).parse(req.params);
    const scan = await prisma.identityScan.findUnique({ where: { id: scanId } });
    if (!scan) throw notFound('Scan not found');
    await assertProjectAccess(req, scan.projectId);
    const q = z.object({ status: z.enum(['FOUND', 'NOT_FOUND', 'UNKNOWN', 'ERROR']).optional() }).parse(req.query);
    const results = await prisma.identityScanResult.findMany({
      where: { scanId, ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ status: 'asc' }, { platform: 'asc' }],
    });
    return { scan, results };
  });

  // Promote a FOUND hit into the evidence base — reuses the same ingest path
  // as any other user-provided URL (§9), so a profile result carries the
  // same provenance/entity-extraction as everything else, rather than being
  // a second, parallel kind of "finding."
  app.post('/identity/results/:resultId/add-evidence', async (req) => {
    const { resultId } = z.object({ resultId: z.string() }).parse(req.params);
    const result = await prisma.identityScanResult.findUnique({ where: { id: resultId }, include: { scan: true } });
    if (!result) throw notFound('Result not found');
    await assertProjectAccess(req, result.scan.projectId, 'EDITOR');
    if (result.status !== 'FOUND') throw badRequest('Only FOUND results can be added as evidence.');
    if (result.evidenceId) return { evidenceId: result.evidenceId, reused: true };

    const ingested = await ingestUrlOrExplain(result.scan.projectId, result.url);
    await prisma.identityScanResult.update({ where: { id: resultId }, data: { evidenceId: ingested.evidenceId } });
    return { evidenceId: ingested.evidenceId, reused: ingested.reusedExisting };
  });
}
