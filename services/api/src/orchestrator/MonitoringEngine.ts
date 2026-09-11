import { CronExpressionParser } from 'cron-parser';
import { canonicalizeUrl, contentHash as coreContentHash, evidenceContentHash } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { nextEvidenceId } from '../lib/ids.js';
import { getReport, makeConnectorContext, registry } from '../connectors/runtime.js';
import { assessSourcesForSearch, extractEntitiesForEvidence } from './pipeline.js';

/**
 * Monitoring & change detection (§16, §17).
 *
 * A monitoring job re-runs a query on a schedule and compares every candidate
 * result against the project's EXISTING evidence corpus (not just this run's
 * batch):
 *   - exact/canonical URL or content-hash match with identical content -> a
 *     known duplicate, suppressed (never alerted on republished content, §16)
 *   - same canonical URL but different content -> the underlying page CHANGED
 *     (e.g. an updated bio) -> recorded as new evidence that supersedes the
 *     previous capture, and reported as a "changed" finding
 *   - no match at all -> genuinely NEW public information
 *
 * Errors and rate-limit state are recorded per run, never silently dropped.
 */

export function computeNextRun(cron: string, from: Date = new Date()): Date {
  // Evaluate in UTC — schedules are stored/interpreted in UTC throughout the
  // platform, independent of the server's local timezone.
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: 'UTC' });
  return it.next().toDate();
}

export function validateCron(cron: string): { valid: boolean; error?: string } {
  try {
    CronExpressionParser.parse(cron);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const RUN_LIMIT_PER_CONNECTOR = 20;

export async function runMonitoringJob(jobId: string): Promise<void> {
  const job = await prisma.monitoringJob.findUniqueOrThrow({ where: { id: jobId } });
  const startedAt = new Date();
  let newEvidenceCount = 0;
  let changedCount = 0;
  let suppressedDuplicateCount = 0;
  const evidenceIds: string[] = [];
  const notices: string[] = [];
  const rateLimitState: Record<string, unknown> = {};

  try {
    const connectorIds = Array.isArray(job.connectorIds) && (job.connectorIds as string[]).length
      ? (job.connectorIds as string[])
      : job.connectorId
        ? [job.connectorId]
        : registry.all().map((c) => c.id);

    for (const connectorId of connectorIds) {
      const connector = registry.get(connectorId);
      if (!connector) {
        notices.push(`${connectorId}: unknown connector`);
        continue;
      }
      const ctx = await makeConnectorContext(connectorId);
      const report = getReport(connector, ctx);
      rateLimitState[connectorId] = connector.rateLimitStatus();
      if (report.effective.SEARCH_SUPPORTED !== true) {
        notices.push(`${connectorId}: not run — ${report.gaps.find((g) => g.capability === 'ALL' || g.capability === 'SEARCH_SUPPORTED')?.message ?? 'search unsupported'}`);
        continue;
      }

      try {
        const outcome = await connector.search(
          { query: job.query, limit: RUN_LIMIT_PER_CONNECTOR, language: job.languages.split(',')[0] ?? null },
          ctx,
        );
        for (const hit of outcome.hits) {
          try {
            const parsed = await connector.parse(hit, ctx);
            const normalized = await connector.normalize(parsed, { discoveryQuery: job.query }, ctx);
            const canon = normalized.url ? canonicalizeUrl(normalized.url) : null;
            const body = normalized.fullText ?? normalized.excerpt ?? normalized.title ?? '';
            const newHash = body ? coreContentHash(body) : evidenceContentHash(normalized);

            const existing = await prisma.evidence.findFirst({
              where: {
                projectId: job.projectId,
                OR: [
                  ...(normalized.url ? [{ url: normalized.url }] : []),
                  ...(canon ? [{ canonicalUrl: canon.canonical }] : []),
                  { contentHash: newHash },
                ],
              },
              orderBy: { createdAt: 'desc' },
            });

            if (existing && existing.contentHash === newHash) {
              suppressedDuplicateCount++;
              continue; // known, unchanged — never alert on this (§16)
            }

            const changed = Boolean(existing); // same URL, different content
            const { id: evidenceId, year, seq } = await nextEvidenceId();
            const sourceRow = canon?.registrableDomain
              ? await prisma.source.upsert({
                  where: { kind_label: { kind: 'DOMAIN', label: canon.registrableDomain } },
                  create: { kind: 'DOMAIN', label: canon.registrableDomain, registrableDomain: canon.registrableDomain, platform: normalized.sourcePlatform },
                  update: { lastSeenAt: new Date() },
                })
              : null;

            await prisma.evidence.create({
              data: {
                id: evidenceId,
                year,
                seq,
                projectId: job.projectId,
                sourceId: sourceRow?.id,
                connectorId,
                discoveryQuery: `[monitor: ${job.name}] ${job.query}`,
                sourcePlatform: normalized.sourcePlatform,
                url: normalized.url,
                canonicalUrl: canon?.canonical ?? normalized.canonicalUrl,
                title: normalized.title,
                author: normalized.author,
                publishedAt: normalized.publishedAt ? new Date(normalized.publishedAt) : null,
                retrievedAt: new Date(normalized.retrievedAt),
                excerpt: normalized.excerpt,
                fullText: normalized.fullText,
                language: normalized.language,
                rawMetadata: normalized.rawMetadata as object,
                mediaJson: normalized.media.length ? (normalized.media as object) : undefined,
                contentHash: newHash,
                analysisStatus: 'NORMALIZED',
              },
            });

            if (body) await extractEntitiesForEvidence(job.projectId, evidenceId, `${normalized.title ?? ''}\n\n${body}`, normalized.url);

            evidenceIds.push(evidenceId);
            if (changed) {
              changedCount++;
              await prisma.timelineEvent.create({
                data: {
                  projectId: job.projectId,
                  occurredAt: new Date(),
                  precision: 'DAY',
                  title: `Changed: ${normalized.title ?? normalized.url ?? evidenceId}`,
                  description: `Content at this URL changed since evidence ${existing!.id} was captured.`,
                  eventType: 'CHANGE',
                  evidenceId,
                  confidenceLevel: 'MEDIUM',
                },
              });
            } else {
              newEvidenceCount++;
            }
          } catch (err) {
            logger.warn({ err, connectorId, jobId }, 'monitoring: normalize failed for a hit');
          }
        }
      } catch (err) {
        notices.push(`${connectorId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (newEvidenceCount + changedCount > 0) {
      await assessSourcesForSearch(job.projectId);
    }

    const summary =
      newEvidenceCount + changedCount === 0
        ? `No new public information found (${suppressedDuplicateCount} already-known result(s) suppressed).`
        : `${newEvidenceCount} new finding(s), ${changedCount} changed page(s), ${suppressedDuplicateCount} duplicate(s) suppressed.`;

    await prisma.monitoringResult.create({
      data: {
        monitoringJobId: jobId,
        newEvidenceCount,
        changedCount,
        suppressedDuplicateCount,
        evidenceIds: evidenceIds as object,
        summary: notices.length ? `${summary} Notices: ${notices.join('; ')}` : summary,
      },
    });

    const nextRunAt = computeNextRun(job.scheduleCron, startedAt);
    await prisma.monitoringJob.update({
      where: { id: jobId },
      data: { lastRunAt: startedAt, lastSuccessAt: new Date(), lastError: null, nextRunAt, rateLimitState: rateLimitState as object },
    });

    if (newEvidenceCount + changedCount > 0) {
      await audit({
        projectId: job.projectId,
        actorLabel: `MONITOR:${job.name}`,
        action: 'SEARCH_EXECUTED',
        targetType: 'monitoring_job',
        targetId: jobId,
        summary: `Monitoring "${job.name}": ${summary}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.monitoringResult.create({
      data: { monitoringJobId: jobId, newEvidenceCount, changedCount, suppressedDuplicateCount, evidenceIds: evidenceIds as object, summary: 'Run failed', error: message },
    });
    const nextRunAt = computeNextRun(job.scheduleCron, startedAt);
    await prisma.monitoringJob.update({ where: { id: jobId }, data: { lastRunAt: startedAt, lastError: message, nextRunAt } });
    throw err;
  }
}

/** Find jobs due to run and enqueue them. Called by the periodic scheduler. */
export async function findDueMonitoringJobs(): Promise<string[]> {
  const due = await prisma.monitoringJob.findMany({
    where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }] },
    select: { id: true },
  });
  return due.map((j) => j.id);
}
