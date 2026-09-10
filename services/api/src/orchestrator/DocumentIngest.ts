import type { Prisma } from '@prisma/client';
import { contentHash, simhash64 } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { nextEvidenceId } from '../lib/ids.js';
import { storage } from '../lib/storage.js';
import { extractDocument, type DocKind } from '../lib/documentExtract.js';
import { extractEntitiesForEvidence } from './pipeline.js';
import { buildRelationshipsForProject } from './RelationshipBuilder.js';
import { runClaimEngine } from './ClaimEngine.js';
import { buildTimelineForProject } from './TimelineEngine.js';

/**
 * Document ingestion pipeline (§20).
 *
 * file (already stored) -> extract text + metadata -> Evidence record ->
 * deterministic entity extraction -> re-run project intelligence passes.
 */
export async function ingestDocument(documentId: string): Promise<{ evidenceId: string; entities: number }> {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  await prisma.document.update({ where: { id: documentId }, data: { status: 'PENDING', error: null } });

  let extracted;
  try {
    const buf = await storage().get(doc.storageKey);
    extracted = await extractDocument(doc.kind as DocKind, buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.document.update({ where: { id: documentId }, data: { status: 'ERROR', error: message } });
    throw new Error(`Document extraction failed for ${doc.originalName}: ${message}`);
  }

  const text = extracted.text.trim();
  const meta = extracted.metadata;

  await prisma.document.update({
    where: { id: documentId },
    data: { status: 'PROCESSED', extractedText: text.slice(0, 500_000), metadataJson: meta as Prisma.InputJsonValue },
  });

  // one Evidence record for the document
  const existing = await prisma.evidence.findFirst({ where: { projectId: doc.projectId, documentId } });
  let evidenceId: string;
  if (existing) {
    evidenceId = existing.id;
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: {
        title: (meta.title as string) ?? doc.originalName,
        fullText: text.slice(0, 200_000),
        excerpt: text.slice(0, 500),
        rawMetadata: meta as Prisma.InputJsonValue,
        contentHash: contentHash(text || doc.sha256),
        simhash: simhash64(text).toString(16),
        analysisStatus: 'NORMALIZED',
      },
    });
  } else {
    const { id, year, seq } = await nextEvidenceId();
    evidenceId = id;
    await prisma.evidence.create({
      data: {
        id,
        year,
        seq,
        projectId: doc.projectId,
        documentId,
        connectorId: 'document',
        discoveryQuery: `(uploaded document: ${doc.originalName})`,
        sourcePlatform: 'document',
        url: null,
        title: (meta.title as string) ?? doc.originalName,
        author: (meta.author as string) ?? null,
        publishedAt: parseMetaDate(meta),
        retrievedAt: doc.createdAt.toISOString(),
        excerpt: text.slice(0, 500),
        fullText: text.slice(0, 200_000),
        language: (meta.language as string) ?? null,
        rawMetadata: meta as Prisma.InputJsonValue,
        contentHash: contentHash(text || doc.sha256),
        simhash: simhash64(text).toString(16),
        analysisStatus: 'NORMALIZED',
      },
    });
  }

  const entityLinks = text ? await extractEntitiesForEvidence(doc.projectId, evidenceId, `${(meta.title as string) ?? ''}\n\n${text}`, null) : 0;

  await audit({
    projectId: doc.projectId,
    actorLabel: 'SYSTEM',
    action: 'DOCUMENT_INGESTED',
    targetType: 'document',
    targetId: documentId,
    summary: `Ingested "${doc.originalName}" (${doc.kind}) → ${evidenceId}, ${entityLinks} entity links`,
    metadata: { pages: meta.pages ?? null, rows: meta.rows ?? null, bytes: doc.byteSize },
  });

  // refresh project-level intelligence (best-effort, non-fatal)
  for (const [name, fn] of [
    ['relationships', () => buildRelationshipsForProject(doc.projectId)],
    ['claims', () => runClaimEngine(doc.projectId)],
    ['timeline', () => buildTimelineForProject(doc.projectId)],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err, name, documentId }, 'post-ingest pass failed (non-fatal)');
    }
  }

  return { evidenceId, entities: entityLinks };
}

function parseMetaDate(meta: Record<string, unknown>): Date | null {
  const raw = (meta.publishedAt ?? meta.creationDate ?? meta.CreationDate) as string | undefined;
  if (!raw) return null;
  // PDF dates look like "D:20230115120000Z"
  const m = /D:(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}
