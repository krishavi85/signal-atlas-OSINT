import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';
import { storage } from '../lib/storage.js';
import { IMAGE_CONTENT_TYPES } from '../lib/mediaExtract.js';
import { visionCapable } from '../orchestrator/MediaEngine.js';

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/projects/:id/media/status', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const [total, byStatus] = await Promise.all([
      prisma.mediaAsset.count({ where: { projectId: id } }),
      prisma.mediaAsset.groupBy({ by: ['status'], where: { projectId: id }, _count: true }),
    ]);
    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      vision: visionCapable(),
      capabilities: {
        imageMetadata: true,
        exifGps: true,
        perceptualDuplicateDetection: true,
        ocr: 'vision-model', // requires a configured multimodal model
        videoAudioTranscription: false, // not bundled — needs ffmpeg + speech model
        objectLogoRecognition: 'vision-model',
        reverseImageSearch: false, // no provider configured
        facialIdentification: 'never', // §19/§30 — not built, by policy
      },
    };
  });

  app.get('/projects/:id/media', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ status: z.string().optional(), includeDuplicates: z.coerce.boolean().default(true) }).parse(req.query);
    const rows = await prisma.mediaAsset.findMany({
      where: { projectId: id, ...(q.status ? { status: q.status } : {}), ...(q.includeDuplicates ? {} : { duplicateOfId: null }) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { duplicates: true } } },
      take: 400,
    });
    // group into perceptual clusters
    const clusters = new Map<string, typeof rows>();
    for (const m of rows) {
      const key = m.clusterId ?? m.id;
      (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(m);
    }
    return {
      items: rows,
      clusters: [...clusters.entries()]
        .filter(([, v]) => v.length > 1)
        .map(([key, v]) => ({ clusterId: key, count: v.length, memberIds: v.map((m) => m.id) })),
    };
  });

  app.get('/media/:mediaId', async (req) => {
    const { mediaId } = z.object({ mediaId: z.string() }).parse(req.params);
    const m = await prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      include: {
        duplicateOf: { select: { id: true, sourceUrl: true } },
        duplicates: { select: { id: true, sourceUrl: true, evidenceId: true } },
      },
    });
    if (!m) throw notFound('Media not found');
    await assertProjectAccess(req, m.projectId);
    const evidence = m.evidenceId
      ? await prisma.evidence.findUnique({ where: { id: m.evidenceId }, select: { id: true, title: true, url: true, sourcePlatform: true } })
      : null;
    return { ...m, evidence };
  });

  app.get('/media/:mediaId/file', async (req, reply) => {
    const { mediaId } = z.object({ mediaId: z.string() }).parse(req.params);
    const m = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!m) throw notFound('Media not found');
    await assertProjectAccess(req, m.projectId);
    if (!m.storageKey) {
      // not yet fetched — redirect to the original public URL if we have one
      if (m.sourceUrl) return reply.redirect(m.sourceUrl);
      throw notFound('No stored file');
    }
    const buf = await storage().get(m.storageKey);
    reply.type(m.format ? `image/${m.format === 'jpg' ? 'jpeg' : m.format}` : 'application/octet-stream');
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(buf);
  });

  // upload an image directly
  app.post('/projects/:id/media', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const file = await req.file();
    if (!file) throw badRequest('multipart file field required');
    if (!IMAGE_CONTENT_TYPES.test(file.mimetype ?? '')) {
      throw unprocessable(`Not a supported image type: ${file.mimetype}`);
    }
    const buf = await file.toBuffer();
    const stored = await storage().put(`media/${id}`, buf, file.filename.split('.').pop() ?? 'img');
    const asset = await prisma.mediaAsset.create({
      data: { projectId: id, kind: 'IMAGE', storageKey: stored.key, sha256: stored.sha256, byteSize: stored.size, note: `uploaded: ${file.filename}`, status: 'PENDING' },
    });
    const jobId = await enqueueJob({ type: 'MEDIA_PROCESS', projectId: id, payload: { projectId: id } });
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'DOCUMENT_INGESTED', targetType: 'media', targetId: asset.id, summary: `Uploaded image "${file.filename}"` });
    reply.status(202).send({ media: asset, jobId });
  });

  app.post('/projects/:id/media/process', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const { vision } = z.object({ vision: z.boolean().default(false) }).parse(req.body ?? {});
    if (vision && !visionCapable().available) {
      throw badRequest(`Vision OCR/description unavailable: ${visionCapable().reason}`);
    }
    const jobId = await enqueueJob({ type: 'MEDIA_PROCESS', projectId: id, payload: { projectId: id, vision } });
    return { jobId };
  });

  app.delete('/media/:mediaId', async (req, reply) => {
    const { mediaId } = z.object({ mediaId: z.string() }).parse(req.params);
    const m = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!m) throw notFound('Media not found');
    await assertProjectAccess(req, m.projectId, 'EDITOR');
    if (m.storageKey) await storage().delete(m.storageKey).catch(() => {});
    await prisma.mediaAsset.delete({ where: { id: mediaId } });
    reply.status(204).send();
  });
}
