import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { cosine, embedText, getEmbeddingProvider, embeddingStatus, l2norm } from '../ai/embeddings.js';

/**
 * Semantic retrieval over collected evidence (§23).
 *
 * `backfillEmbeddings` computes vectors for evidence that lacks them.
 * `semanticSearch` embeds the query and cosine-ranks stored vectors in-process.
 * Without a configured embedding provider both are unavailable — no fake results.
 */

export async function backfillEmbeddings(projectId: string, limit = 200): Promise<{ embedded: number; skipped: string }> {
  const provider = getEmbeddingProvider();
  if (!provider) {
    return { embedded: 0, skipped: embeddingStatus().reason ?? 'no provider' };
  }
  const rows = await prisma.evidence.findMany({
    where: { projectId, isDuplicate: false, embedding: null },
    select: { id: true, title: true, excerpt: true, fullText: true },
    take: limit,
  });
  if (rows.length === 0) return { embedded: 0, skipped: 'up to date' };

  let embedded = 0;
  const batchSize = provider.id === 'openai' ? 32 : 8;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    let vectors: number[][];
    try {
      vectors = await provider.embed(batch.map((r) => embedText(r)));
    } catch (err) {
      logger.warn({ err, projectId }, 'embedding batch failed');
      break;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      if (!vec) continue;
      await prisma.evidenceEmbedding
        .upsert({
          where: { evidenceId: batch[j]!.id },
          create: {
            evidenceId: batch[j]!.id,
            projectId,
            provider: provider.id,
            model: provider.model,
            dim: vec.length,
            vector: vec as Prisma.InputJsonValue,
            norm: l2norm(vec),
          },
          update: { provider: provider.id, model: provider.model, dim: vec.length, vector: vec as Prisma.InputJsonValue, norm: l2norm(vec) },
        })
        .then(() => embedded++)
        .catch((err) => logger.debug({ err }, 'embedding upsert'));
    }
  }
  await audit({
    projectId,
    actorLabel: 'SYSTEM',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'project',
    targetId: projectId,
    summary: `Semantic index: embedded ${embedded} evidence records with ${provider.id}/${provider.model}`,
  });
  return { embedded, skipped: '' };
}

export interface SemanticHit {
  evidenceId: string;
  score: number;
}

export async function semanticSearch(
  projectId: string,
  query: string,
  topK = 20,
): Promise<{ available: boolean; hits: SemanticHit[]; reason?: string; setup?: string; indexed: number; total: number }> {
  const status = embeddingStatus();
  const [indexed, total] = await Promise.all([
    prisma.evidenceEmbedding.count({ where: { projectId } }),
    prisma.evidence.count({ where: { projectId, isDuplicate: false } }),
  ]);
  if (!status.available) {
    return { available: false, hits: [], reason: status.reason, setup: status.setup, indexed, total };
  }
  const provider = getEmbeddingProvider()!;
  let qvec: number[];
  try {
    const embedded = await provider.embed([query]);
    if (!embedded[0]) throw new Error('empty embedding');
    qvec = embedded[0];
  } catch (err) {
    return { available: false, hits: [], reason: `Query embedding failed: ${(err as Error).message}`, indexed, total };
  }
  const qnorm = l2norm(qvec);

  const rows = await prisma.evidenceEmbedding.findMany({ where: { projectId }, select: { evidenceId: true, vector: true, norm: true } });
  const scored = rows
    .map((r) => ({ evidenceId: r.evidenceId, score: cosine(qvec, qnorm, r.vector as number[], r.norm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { available: true, hits: scored, indexed, total };
}
