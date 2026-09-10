import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';
import { storage } from '../lib/storage.js';
import { detectKind } from '../lib/documentExtract.js';
import { backfillEmbeddings, semanticSearch } from '../orchestrator/SemanticIndex.js';
import { embeddingStatus } from '../ai/embeddings.js';

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // Upload a document into an investigation (§20).
  app.post('/projects/:id/documents', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    if (project.status !== 'ACTIVE') throw badRequest(`Project is ${project.status}`);

    const file = await req.file();
    if (!file) throw badRequest('multipart file field required');
    const buf = await file.toBuffer();
    if (buf.length === 0) throw badRequest('Empty file');

    const kind = detectKind(file.filename, file.mimetype);
    if (!kind) throw unprocessable(`Unsupported file type: ${file.filename} (${file.mimetype}). Supported: PDF, DOCX, TXT, CSV, JSON, HTML.`);

    const stored = await storage().put(`documents/${id}`, buf, file.filename.split('.').pop() ?? 'bin');
    const dupe = await prisma.document.findFirst({ where: { projectId: id, sha256: stored.sha256 } });

    const doc = await prisma.document.create({
      data: {
        projectId: id,
        kind,
        originalName: file.filename.slice(0, 255),
        storageKey: stored.key,
        byteSize: stored.size,
        sha256: stored.sha256,
        uploadedById: u.id,
        status: 'PENDING',
      },
    });

    const jobId = await enqueueJob({ type: 'DOCUMENT_INGEST', projectId: id, payload: { documentId: doc.id } });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'DOCUMENT_INGESTED',
      targetType: 'document', targetId: doc.id,
      summary: `Uploaded "${doc.originalName}" (${kind}, ${(stored.size / 1024).toFixed(0)} KB)${dupe ? ' [content already present]' : ''}`,
    });
    reply.status(202).send({ document: doc, jobId, duplicateOf: dupe?.id ?? null });
  });

  app.get('/projects/:id/documents', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.document.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, kind: true, originalName: true, byteSize: true, sha256: true, status: true, error: true,
        createdAt: true, metadataJson: true,
      },
    });
  });

  app.get('/documents/:docId', async (req) => {
    const { docId } = z.object({ docId: z.string() }).parse(req.params);
    const doc = await prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw notFound('Document not found');
    await assertProjectAccess(req, doc.projectId);
    const evidence = await prisma.evidence.findFirst({
      where: { documentId: docId },
      select: { id: true, _count: { select: { entities: true, claimLinks: true } } },
    });
    return { ...doc, evidence };
  });

  app.get('/documents/:docId/download', async (req, reply) => {
    const { docId } = z.object({ docId: z.string() }).parse(req.params);
    const doc = await prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw notFound('Document not found');
    await assertProjectAccess(req, doc.projectId);
    const buf = await storage().get(doc.storageKey);
    reply.header('content-disposition', `attachment; filename="${doc.originalName.replace(/"/g, '')}"`);
    reply.type(mimeFor(doc.kind));
    return reply.send(buf);
  });

  app.delete('/documents/:docId', async (req, reply) => {
    const { docId } = z.object({ docId: z.string() }).parse(req.params);
    const doc = await prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw notFound('Document not found');
    await assertProjectAccess(req, doc.projectId, 'EDITOR');
    const u = currentUser(req);
    await storage().delete(doc.storageKey).catch(() => {});
    await prisma.document.delete({ where: { id: docId } });
    await audit({
      projectId: doc.projectId, actorId: u.id, actorLabel: `user:${u.email}`, action: 'EVIDENCE_REMOVED',
      targetType: 'document', targetId: docId, summary: `Deleted document "${doc.originalName}" and its file`,
    });
    reply.status(204).send();
  });

  // ── Semantic search (§23) ─────────────────────────────────────────────────
  app.get('/projects/:id/semantic-search', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ q: z.string().min(2), topK: z.coerce.number().min(1).max(50).default(20) }).parse(req.query);
    const result = await semanticSearch(id, q.q, q.topK);
    if (!result.available) return result;
    const evidence = await prisma.evidence.findMany({
      where: { id: { in: result.hits.map((h) => h.evidenceId) } },
      select: { id: true, title: true, url: true, sourcePlatform: true, excerpt: true, publishedAt: true },
    });
    const byId = new Map(evidence.map((e) => [e.id, e]));
    return {
      available: true,
      indexed: result.indexed,
      total: result.total,
      results: result.hits.map((h) => ({ ...byId.get(h.evidenceId), score: Number(h.score.toFixed(4)) })).filter((r) => r.id),
    };
  });

  app.get('/projects/:id/semantic-status', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const [indexed, total] = await Promise.all([
      prisma.evidenceEmbedding.count({ where: { projectId: id } }),
      prisma.evidence.count({ where: { projectId: id, isDuplicate: false } }),
    ]);
    return { ...embeddingStatus(), indexed, total };
  });

  app.post('/projects/:id/semantic-reindex', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const status = embeddingStatus();
    if (!status.available) throw badRequest(`Cannot reindex: ${status.reason} ${status.setup ?? ''}`);
    const jobId = await enqueueJob({ type: 'AI_ANALYSIS', projectId: id, payload: { op: 'EMBED', projectId: id } });
    return { jobId };
  });
}

function mimeFor(kind: string): string {
  return (
    {
      PDF: 'application/pdf',
      DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      CSV: 'text/csv',
      JSON: 'application/json',
      HTML: 'text/html',
      TXT: 'text/plain',
    }[kind] ?? 'application/octet-stream'
  );
}

// re-export so orchestrator import graph stays tidy for tests
export { backfillEmbeddings };
