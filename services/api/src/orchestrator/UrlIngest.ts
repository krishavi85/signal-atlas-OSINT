import { canonicalizeUrl, evidenceContentHash, simhash64 } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { nextEvidenceId } from '../lib/ids.js';
import { makeConnectorContext, registry } from '../connectors/runtime.js';
import { extractEntitiesForEvidence } from './pipeline.js';
import { buildRelationshipsForProject } from './RelationshipBuilder.js';
import { runClaimEngine } from './ClaimEngine.js';
import { buildTimelineForProject } from './TimelineEngine.js';

/**
 * Direct URL ingestion (§3 "user-provided URLs") — the web-generic
 * connector's fetch() has existed since Phase 1 (SSRF-guarded, robots-aware,
 * cached) but had never been wired to anything callable; this is that entry
 * point. Mirrors DocumentIngest.ts's shape: one external thing in, one
 * Evidence record, then re-run the project's downstream intelligence passes.
 *
 * `render: true` renders the page's JS in a headless browser first (see
 * packages/connectors/src/lib/browserFetch.ts) before extracting content —
 * useful for pages that don't have a meaningful server-rendered HTML body.
 */
export async function ingestUrl(
  projectId: string,
  url: string,
  opts: { render?: boolean } = {},
): Promise<{ evidenceId: string; entities: number; reusedExisting: boolean }> {
  const canon = canonicalizeUrl(url);
  const existing = canon
    ? await prisma.evidence.findFirst({ where: { projectId, canonicalUrl: canon.canonical } })
    : null;
  if (existing) {
    // Honest de-dup, same principle as monitoring's change detection (§16):
    // re-fetching a URL you already have doesn't silently spawn a duplicate.
    return { evidenceId: existing.id, entities: 0, reusedExisting: true };
  }

  const connector = registry.get('web-generic');
  if (!connector) throw new Error('web-generic connector not registered');
  const ctx = await makeConnectorContext('web-generic');

  const raw = await connector.fetch({ url, render: opts.render }, ctx);
  const parsed = await connector.parse(raw, ctx);
  const normalized = await connector.normalize(parsed, { discoveryQuery: `(user-provided URL: ${url})` }, ctx);

  let sourceId: string | null = null;
  if (canon?.registrableDomain) {
    const src = await prisma.source.upsert({
      where: { kind_label: { kind: 'DOMAIN', label: canon.registrableDomain } },
      create: {
        kind: 'DOMAIN',
        label: canon.registrableDomain,
        registrableDomain: canon.registrableDomain,
        platform: normalized.sourcePlatform,
        url: `${new URL(url).protocol}//${canon.host}`,
      },
      update: { lastSeenAt: new Date() },
    });
    sourceId = src.id;
  }

  const { id: evidenceId, year, seq } = await nextEvidenceId();
  await prisma.evidence.create({
    data: {
      id: evidenceId,
      year,
      seq,
      projectId,
      sourceId,
      connectorId: 'web-generic',
      discoveryQuery: normalized.discoveryQuery,
      sourcePlatform: normalized.sourcePlatform,
      url: normalized.url,
      canonicalUrl: normalized.canonicalUrl ?? canon?.canonical ?? null,
      title: normalized.title,
      author: normalized.author,
      publishedAt: normalized.publishedAt ? new Date(normalized.publishedAt) : null,
      retrievedAt: new Date(normalized.retrievedAt),
      excerpt: normalized.excerpt,
      fullText: normalized.fullText,
      language: normalized.language,
      rawMetadata: normalized.rawMetadata as object,
      mediaJson: normalized.media.length ? (normalized.media as object) : undefined,
      contentHash: evidenceContentHash(normalized),
      simhash: normalized.fullText ? simhash64(normalized.fullText).toString(16) : null,
      analysisStatus: 'NORMALIZED',
    },
  });

  const entityLinks = normalized.fullText
    ? await extractEntitiesForEvidence(projectId, evidenceId, `${normalized.title ?? ''}\n\n${normalized.fullText}`, null)
    : 0;

  await audit({
    projectId,
    actorLabel: 'SYSTEM',
    action: 'EVIDENCE_ADDED',
    targetType: 'evidence',
    targetId: evidenceId,
    summary: `Fetched user-provided URL ${url}${opts.render ? ' (JS-rendered)' : ''} → ${evidenceId}, ${entityLinks} entity links`,
  });

  for (const [name, fn] of [
    ['relationships', () => buildRelationshipsForProject(projectId)],
    ['claims', () => runClaimEngine(projectId)],
    ['timeline', () => buildTimelineForProject(projectId)],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err, name, url }, 'post-ingest pass failed (non-fatal)');
    }
  }

  return { evidenceId, entities: entityLinks, reusedExisting: false };
}
