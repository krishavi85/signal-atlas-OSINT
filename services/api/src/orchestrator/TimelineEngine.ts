import { prisma } from '../db.js';
import { audit } from '../modules/audit.js';

/**
 * TimelineEngine (§15).
 *
 * Derives chronological events from:
 *  - evidence publication dates  -> PUBLICATION events
 *  - dated claims                -> ANNOUNCEMENT / REGISTRATION / CHANGE events
 *
 * Auto-derived events (evidenceId set, or createdBy convention) are rebuilt on
 * each run; analyst-authored events (evidenceId null) are preserved.
 */

const PREDICATE_EVENT_TYPE: Record<string, string> = {
  ANNOUNCED: 'ANNOUNCEMENT',
  LAUNCHED: 'ANNOUNCEMENT',
  ACQUIRED: 'CHANGE',
  FOUNDED_IN: 'REGISTRATION',
  RAISED: 'ANNOUNCEMENT',
  RENAMED_TO: 'CHANGE',
  APPOINTED: 'CHANGE',
  PARTNERED_WITH: 'ANNOUNCEMENT',
};

export async function buildTimelineForProject(projectId: string): Promise<number> {
  // wipe previously auto-derived events (those linked to evidence)
  await prisma.timelineEvent.deleteMany({ where: { projectId, evidenceId: { not: null } } });

  const seen = new Set<string>();
  const rows: Array<Parameters<typeof prisma.timelineEvent.create>[0]['data']> = [];

  const evidence = await prisma.evidence.findMany({
    where: { projectId, isDuplicate: false, publishedAt: { not: null } },
    select: { id: true, title: true, publishedAt: true, sourcePlatform: true },
    orderBy: { publishedAt: 'asc' },
    take: 2000,
  });
  for (const e of evidence) {
    const day = e.publishedAt!.toISOString().slice(0, 10);
    const dedupeKey = `pub|${day}|${(e.title ?? '').toLowerCase().slice(0, 60)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({
      projectId,
      occurredAt: e.publishedAt!,
      precision: 'DAY',
      title: e.title ?? `${e.sourcePlatform} item`,
      eventType: e.sourcePlatform === 'rss' || e.sourcePlatform === 'web' ? 'PUBLICATION' : 'MENTION',
      evidenceId: e.id,
      confidenceLevel: 'MEDIUM',
    });
  }

  const claims = await prisma.claim.findMany({
    where: { projectId, claimDate: { not: null } },
    include: { evidenceLinks: { select: { evidenceId: true }, take: 1 } },
  });
  for (const c of claims) {
    const day = c.claimDate!.toISOString().slice(0, 10);
    const isYearOnly = c.claimDate!.getUTCMonth() === 0 && c.claimDate!.getUTCDate() === 1;
    const dedupeKey = `claim|${c.predicate}|${day}|${c.subject.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({
      projectId,
      occurredAt: c.claimDate!,
      precision: isYearOnly ? 'YEAR' : 'DAY',
      title: `${c.subject}: ${c.predicate.replace(/_/g, ' ').toLowerCase()} ${c.object}`.slice(0, 200),
      description: c.text,
      eventType: PREDICATE_EVENT_TYPE[c.predicate] ?? 'MENTION',
      evidenceId: c.evidenceLinks[0]?.evidenceId ?? null,
      confidenceLevel: c.confidenceLevel,
    });
  }

  for (const data of rows) {
    // only keep rows that still have an evidenceId (schema wipe contract above);
    // claim-derived rows without evidence are skipped to preserve the rebuild rule
    if (!data.evidenceId) continue;
    await prisma.timelineEvent.create({ data });
  }

  await audit({
    projectId,
    actorLabel: 'SYSTEM',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'project',
    targetId: projectId,
    summary: `Timeline engine derived ${rows.filter((r) => r.evidenceId).length} dated events`,
  });
  return rows.filter((r) => r.evidenceId).length;
}
