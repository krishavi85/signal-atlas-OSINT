import type { Prisma } from '@prisma/client';
import { expandQuery } from '@osint/core';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { chatStatus } from '../ai/chat.js';
import { runResearchRun, type ResearchProgress } from './pipeline.js';
import { expandQueriesAI, generateReport } from './AIResearchEngine.js';

/**
 * GodModeResearchOrchestrator (§55, §56).
 *
 * Composes every engine that already exists into ONE autonomous run from a
 * single TARGET / OBJECTIVE / DATE RANGE / SOURCES / DEPTH / LANGUAGES input:
 *
 *   QueryPlanner + SearchOrchestrator + ConnectorRegistry   (pipeline.ts, per Search)
 *   EvidenceEngine + EntityEngine + ResolutionEngine        (pipeline.ts)
 *   CorrelationEngine (RelationshipBuilder) + ClaimEngine   (pipeline.ts)
 *   ContradictionEngine + VerificationEngine (corroboration) (ClaimEngine.ts)
 *   TimelineEngine                                          (pipeline.ts)
 *   AIResearchEngine (query expansion + report)             (AIResearchEngine.ts)
 *   ReportEngine                                            (AIResearchEngine.ts generateReport)
 *   MonitoringEngine                                        (recommendations only — never auto-created)
 *
 * DEEP mode runs one extra round of AI-suggested follow-up searches once the
 * first pass has produced entities/claims to reason from. Every section of
 * the §56 result is grounded in what actually ran — coverage gaps, unverified
 * findings, and "not found" are first-class, never hidden.
 */

export interface GodModeParams {
  target: string;
  objective?: string | null;
  subjectType?: string | null;
  depth: 'QUICK' | 'STANDARD' | 'DEEP';
  languages: string[];
  dateAfter?: string | null;
  dateBefore?: string | null;
  connectorIds?: string[] | null; // null = all effective ("all configured lawful public sources")
}

export type GodModeProgress = {
  phase: 'PLANNING' | 'PRIMARY_SEARCH' | 'FOLLOW_UP_SEARCHES' | 'GENERATING_REPORT' | 'ASSEMBLING_RESULT' | 'DONE';
  searchesPlanned: number;
  searchesCompleted: number;
  currentQuery?: string;
} & Partial<Omit<ResearchProgress, 'phase'>>;

export type GodModeProgressReporter = (p: GodModeProgress) => Promise<void> | void;

const MAX_FOLLOW_UP_QUERIES = 5;

export async function runGodModeRun(
  godModeRunId: string,
  report: GodModeProgressReporter,
  userId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const run = await prisma.godModeRun.findUniqueOrThrow({ where: { id: godModeRunId } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: run.projectId } });
  await prisma.godModeRun.update({ where: { id: godModeRunId }, data: { status: 'RUNNING' } });

  const searchIds: string[] = [];
  const progress: GodModeProgress = { phase: 'PLANNING', searchesPlanned: 1, searchesCompleted: 0 };
  const tick = async () => report({ ...progress });
  await tick();

  const connectorIds = Array.isArray(run.requestedConnectors) ? (run.requestedConnectors as string[]) : null;

  async function runOneSearch(query: string, depth: 'QUICK' | 'STANDARD' | 'DEEP'): Promise<void> {
    const search = await prisma.search.create({
      data: {
        projectId: run.projectId,
        originalQuery: query,
        subjectType: run.subjectType,
        objective: run.objective,
        dateAfter: run.dateRangeStart,
        dateBefore: run.dateRangeEnd,
        languages: run.languages,
        depth,
        requestedConnectors: connectorIds ?? undefined,
        status: 'PLANNED',
      },
    });
    searchIds.push(search.id);
    progress.currentQuery = query;
    await tick();
    await runResearchRun(
      search.id,
      async (p) => {
        Object.assign(progress, p);
        await tick();
      },
      signal,
    );
    progress.searchesCompleted += 1;
    await tick();
  }

  // ── 1. primary search on the target ────────────────────────────────────────
  progress.phase = 'PRIMARY_SEARCH';
  await tick();
  const depth = (['QUICK', 'STANDARD', 'DEEP'] as const).includes(run.depth as 'QUICK' | 'STANDARD' | 'DEEP')
    ? (run.depth as 'QUICK' | 'STANDARD' | 'DEEP')
    : 'STANDARD';
  await runOneSearch(run.target, depth);

  // ── 2. DEEP: one round of AI-suggested follow-up searches ──────────────────
  let aiSuggestions: Array<{ query: string; rationale: string }> = [];
  if (run.depth === 'DEEP' && chatStatus().available) {
    progress.phase = 'FOLLOW_UP_SEARCHES';
    await tick();
    try {
      const expansion = await expandQueriesAI(run.projectId, userId);
      if ('queries' in expansion) {
        aiSuggestions = expansion.queries.slice(0, MAX_FOLLOW_UP_QUERIES);
        progress.searchesPlanned += aiSuggestions.length;
        await tick();
        for (const suggestion of aiSuggestions) {
          if (signal?.aborted) break;
          await runOneSearch(suggestion.query, 'STANDARD');
        }
      }
    } catch (err) {
      logger.warn({ err, godModeRunId }, 'God Mode: AI follow-up search round failed (non-fatal)');
    }
  }

  // ── 3. report ───────────────────────────────────────────────────────────────
  progress.phase = 'GENERATING_REPORT';
  await tick();
  const reportRow = await prisma.report.create({
    data: {
      projectId: run.projectId,
      title: `${run.target} — God Mode Intelligence Report`,
      format: 'MARKDOWN',
      status: 'QUEUED',
      generatedById: userId,
    },
  });
  try {
    await generateReport(reportRow.id);
  } catch (err) {
    logger.warn({ err, godModeRunId }, 'God Mode: report generation failed (non-fatal — result still assembled)');
  }

  // ── 4. assemble the §56 result ──────────────────────────────────────────────
  progress.phase = 'ASSEMBLING_RESULT';
  await tick();
  // if we didn't already get AI suggestions (QUICK/STANDARD, or AI unavailable),
  // still populate "recommended next searches" — via AI if available, else the
  // deterministic core expander, so the section is never empty when avoidable.
  if (aiSuggestions.length === 0 && chatStatus().available) {
    try {
      const expansion = await expandQueriesAI(run.projectId, userId);
      if ('queries' in expansion) aiSuggestions = expansion.queries;
    } catch (err) {
      logger.debug({ err }, 'God Mode: recommendation-only AI expansion failed');
    }
  }

  const result = await assembleGodModeResult(run.projectId, { searchIds, aiSuggestions, target: run.target, project });

  const anyEvidence = result.evidence.total > 0;
  const status = anyEvidence ? 'COMPLETED' : 'PARTIAL';

  await prisma.godModeRun.update({
    where: { id: godModeRunId },
    data: {
      status,
      searchIds: searchIds as unknown as Prisma.InputJsonValue,
      reportId: reportRow.id,
      resultJson: result as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });

  await audit({
    projectId: run.projectId,
    actorId: userId,
    actorLabel: userId ? 'user:god-mode' : 'SYSTEM',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'god_mode_run',
    targetId: godModeRunId,
    summary: `God Mode run for "${run.target}" (${run.depth}) → ${status}: ${searchIds.length} search(es), ${result.evidence.total} evidence, ${result.claims.total} claims, ${result.contradictions.length} contradiction(s)`,
  });

  progress.phase = 'DONE';
  await tick();
}

// ── §56 result assembly ──────────────────────────────────────────────────────

export interface GodModeResult {
  target: string;
  generatedAt: string;
  executiveSummary: { text: string; aiGenerated: boolean };
  keyFindings: Array<{ text: string; epistemicTag: string; confidenceLevel: string }>;
  verifiedFindings: Array<{ text: string; confidenceLevel: string; evidenceCount: number }>;
  unverifiedFindings: Array<{ text: string; corroboration: string }>;
  importantEntities: Array<{ type: string; name: string; evidenceCount: number; resolutionConfidence: string }>;
  connectionGraph: { nodeCount: number; edgeCount: number; topEdges: Array<{ from: string; type: string; to: string; evidenceCount: number }> };
  timeline: Array<{ occurredAt: string; eventType: string; title: string }>;
  claims: { total: number; items: Array<{ text: string; corroboration: string; confidenceLevel: string; epistemicTag: string }> };
  contradictions: Array<{ explanation: string; status: string }>;
  sourceCoverage: Array<{ connectorId: string; state: 'COMPLETED' | 'PARTIAL' | 'NOT_RUN' | 'FAILED'; hits: number; note?: string }>;
  evidence: { total: number; duplicatesSuppressed: number; sample: Array<{ id: string; title: string | null; url: string | null; platform: string }> };
  informationGaps: string[];
  confidenceAssessment: { distribution: Record<string, number>; note: string };
  recommendedNextSearches: Array<{ query: string; rationale: string; aiGenerated: boolean }>;
  monitoringRecommendations: Array<{ name: string; query: string; schedule: string; connectorIds: string[] | null; rationale: string }>;
}

async function assembleGodModeResult(
  projectId: string,
  ctx: {
    searchIds: string[];
    aiSuggestions: Array<{ query: string; rationale: string }>;
    target: string;
    project: { defaultLanguages: string };
  },
): Promise<GodModeResult> {
  const [
    evidenceTotal,
    evidenceDup,
    evidenceSample,
    entities,
    claims,
    contradictions,
    timeline,
    coverageRuns,
    reportRow,
  ] = await Promise.all([
    prisma.evidence.count({ where: { projectId, isDuplicate: false } }),
    prisma.evidence.count({ where: { projectId, isDuplicate: true } }),
    prisma.evidence.findMany({
      where: { projectId, isDuplicate: false },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      select: { id: true, title: true, url: true, sourcePlatform: true },
    }),
    prisma.entity.findMany({
      where: { projectId, mergedIntoId: null },
      include: { _count: { select: { evidenceLinks: true } } },
      orderBy: { evidenceLinks: { _count: 'desc' } },
      take: 15,
    }),
    prisma.claim.findMany({ where: { projectId }, orderBy: { confidenceScore: 'desc' }, include: { _count: { select: { evidenceLinks: true } } } }),
    prisma.contradiction.findMany({
      where: { projectId, status: 'OPEN' },
      include: { claimA: { select: { text: true } }, claimB: { select: { text: true } } },
    }),
    prisma.timelineEvent.findMany({ where: { projectId }, orderBy: { occurredAt: 'desc' }, take: 20 }),
    ctx.searchIds.length
      ? prisma.searchRun.findMany({ where: { searchId: { in: ctx.searchIds } } })
      : Promise.resolve([]),
    prisma.report.findFirst({ where: { projectId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } }),
  ]);

  // coverage: aggregate per-connector across every search this run executed
  const byConnector = new Map<string, { completed: number; failed: number; skipped: number; hits: number; note?: string }>();
  for (const run of coverageRuns) {
    const e = byConnector.get(run.connectorId) ?? { completed: 0, failed: 0, skipped: 0, hits: 0 };
    if (run.status === 'COMPLETED') e.completed += 1;
    if (run.status === 'FAILED') e.failed += 1;
    if (run.status === 'SKIPPED') {
      e.skipped += 1;
      e.note = run.skippedReason ?? e.note;
    }
    e.hits += run.rawHitCount;
    byConnector.set(run.connectorId, e);
  }
  const sourceCoverage: GodModeResult['sourceCoverage'] = [...byConnector.entries()].map(([connectorId, v]) => ({
    connectorId,
    state: v.completed > 0 && v.failed === 0 ? 'COMPLETED' : v.completed > 0 ? 'PARTIAL' : v.skipped > 0 ? 'NOT_RUN' : 'FAILED',
    hits: v.hits,
    note: v.note,
  }));

  // connection graph summary
  const relationships = await prisma.relationship.findMany({
    where: { projectId },
    include: { from: { select: { displayName: true } }, to: { select: { displayName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const nodeIds = new Set<string>();
  for (const r of relationships) {
    nodeIds.add(r.fromId);
    nodeIds.add(r.toId);
  }
  const topEdges = [...relationships]
    .sort((a, b) => (Array.isArray(b.evidenceIds) ? b.evidenceIds.length : 0) - (Array.isArray(a.evidenceIds) ? a.evidenceIds.length : 0))
    .slice(0, 10)
    .map((r) => ({
      from: r.from.displayName,
      type: r.type,
      to: r.to.displayName,
      evidenceCount: Array.isArray(r.evidenceIds) ? r.evidenceIds.length : 0,
    }));

  const verified = claims.filter((c) => c.epistemicTag === 'FACT' || c.corroboration === 'INDEPENDENTLY_CORROBORATED');
  const unverified = claims.filter((c) => c.corroboration === 'UNVERIFIED' || c.corroboration === 'SINGLE_SOURCE');

  const confidenceDistribution: Record<string, number> = { VERY_LOW: 0, LOW: 0, MEDIUM: 0, HIGH: 0, VERIFIED: 0 };
  for (const c of claims) confidenceDistribution[c.confidenceLevel] = (confidenceDistribution[c.confidenceLevel] ?? 0) + 1;

  // information gaps — grounded in what actually happened, never invented
  const gaps: string[] = [];
  for (const c of sourceCoverage) {
    if (c.state === 'NOT_RUN') gaps.push(`${c.connectorId}: not run — ${c.note ?? 'unavailable'}`);
    if (c.state === 'FAILED') gaps.push(`${c.connectorId}: search failed`);
  }
  const entityTypesSeen = new Set(entities.map((e) => e.type));
  for (const t of ['PERSON', 'ORGANIZATION', 'COMPANY', 'LOCATION', 'EVENT']) {
    if (!entityTypesSeen.has(t)) gaps.push(`No ${t} entities identified in the searched sources.`);
  }
  if (claims.length === 0) gaps.push('No structured claims could be extracted (sources may lack descriptive prose, or none matched the entity-anchoring requirement).');
  if (!chatStatus().available) gaps.push('AI provider not configured — executive summary, key findings narrative, and AI-suggested searches are limited to deterministic assembly.');
  if (gaps.length === 0) gaps.push('No coverage or extraction gaps identified for this run.');

  // recommended next searches: AI suggestions if we have them, else deterministic core expansion
  const recommendedNextSearches: GodModeResult['recommendedNextSearches'] = ctx.aiSuggestions.length
    ? ctx.aiSuggestions.map((s) => ({ query: s.query, rationale: s.rationale, aiGenerated: true }))
    : expandQuery(ctx.target)
        .filter((e) => e.kind !== 'ORIGINAL')
        .slice(0, 6)
        .map((e) => ({ query: e.query, rationale: e.rationale, aiGenerated: false }));

  const availableConnectorIds = sourceCoverage.filter((c) => c.state === 'COMPLETED' || c.state === 'PARTIAL').map((c) => c.connectorId);
  const monitoringRecommendations: GodModeResult['monitoringRecommendations'] = [
    {
      name: `Mentions of ${ctx.target}`,
      query: ctx.target,
      schedule: 'DAILY',
      connectorIds: availableConnectorIds.length ? availableConnectorIds : null,
      rationale: 'Track new public mentions of the primary target using the same sources that returned results this run.',
    },
    ...(recommendedNextSearches[0]
      ? [
          {
            name: `Follow-up: ${recommendedNextSearches[0].query}`,
            query: recommendedNextSearches[0].query,
            schedule: 'WEEKLY',
            connectorIds: availableConnectorIds.length ? availableConnectorIds : null,
            rationale: recommendedNextSearches[0].rationale,
          },
        ]
      : []),
  ];

  let executiveSummary: GodModeResult['executiveSummary'];
  const aiExecSection = reportRow?.sectionsJson
    ? (reportRow.sectionsJson as unknown as Array<{ heading: string; body: string; aiGenerated: boolean }>).find(
        (s) => s.heading === 'Executive Summary' && s.aiGenerated,
      )
    : undefined;
  if (aiExecSection) {
    executiveSummary = { text: aiExecSection.body, aiGenerated: true };
  } else {
    executiveSummary = {
      text:
        `Deterministic summary (no AI provider configured): ${evidenceTotal} unique evidence record(s) collected across ` +
        `${sourceCoverage.filter((c) => c.state === 'COMPLETED' || c.state === 'PARTIAL').length} source(s) for "${ctx.target}". ` +
        `${entities.length} distinct entities and ${claims.length} claim(s) were extracted (${verified.length} independently corroborated, ` +
        `${unverified.length} single-source/unverified). ${contradictions.length} unresolved contradiction(s). See Information Gaps below for what was not found.`,
      aiGenerated: false,
    };
  }

  return {
    target: ctx.target,
    generatedAt: new Date().toISOString(),
    executiveSummary,
    keyFindings: claims.slice(0, 10).map((c) => ({ text: c.text, epistemicTag: c.epistemicTag, confidenceLevel: c.confidenceLevel })),
    verifiedFindings: verified.map((c) => ({ text: c.text, confidenceLevel: c.confidenceLevel, evidenceCount: c._count.evidenceLinks })),
    unverifiedFindings: unverified.map((c) => ({ text: c.text, corroboration: c.corroboration })),
    importantEntities: entities.map((e) => ({
      type: e.type,
      name: e.displayName,
      evidenceCount: e._count.evidenceLinks,
      resolutionConfidence: e.resolutionConfidence,
    })),
    connectionGraph: { nodeCount: nodeIds.size, edgeCount: relationships.length, topEdges },
    timeline: timeline.map((t) => ({ occurredAt: t.occurredAt.toISOString(), eventType: t.eventType, title: t.title })),
    claims: {
      total: claims.length,
      items: claims.slice(0, 50).map((c) => ({ text: c.text, corroboration: c.corroboration, confidenceLevel: c.confidenceLevel, epistemicTag: c.epistemicTag })),
    },
    contradictions: contradictions.map((c) => ({ explanation: c.explanation, status: c.status })),
    sourceCoverage,
    evidence: {
      total: evidenceTotal,
      duplicatesSuppressed: evidenceDup,
      sample: evidenceSample.map((e) => ({ id: e.id, title: e.title, url: e.url, platform: e.sourcePlatform })),
    },
    informationGaps: gaps,
    confidenceAssessment: {
      distribution: confidenceDistribution,
      note:
        claims.length === 0
          ? 'No claims to assess.'
          : `${(confidenceDistribution.VERIFIED ?? 0) + (confidenceDistribution.HIGH ?? 0)} of ${claims.length} claim(s) rated HIGH or VERIFIED confidence.`,
    },
    recommendedNextSearches,
    monitoringRecommendations,
  };
}
