import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { chat, chatStatus, parseJsonLoose } from '../ai/chat.js';
import {
  buildEvidenceContext,
  validateCitations,
  SUMMARY_SYSTEM,
  EXPAND_SYSTEM,
  REPORT_NARRATIVE_SYSTEM,
} from '../ai/grounding.js';
import { semanticSearch } from './SemanticIndex.js';

/**
 * AI research analyst (§13). Every function here is a no-op-with-honest-error
 * when AI is not configured (§14, §51) — the deterministic report generator
 * degrades gracefully and marks the AI sections as unavailable rather than
 * fabricating prose.
 */

export interface AiUnavailable {
  available: false;
  reason: string;
  setup?: string;
}

// ── grounded Q&A over the evidence ──────────────────────────────────────────

export async function summarizeProject(
  projectId: string,
  question: string,
  userId: string | null,
): Promise<{ id: string } | AiUnavailable> {
  const status = chatStatus();
  if (!status.available) return { available: false, reason: status.reason ?? 'AI not configured', setup: status.setup };

  const items = await selectEvidenceForQuestion(projectId, question, 24);
  if (items.length === 0) throw new Error('No evidence in this project yet — run a search first.');

  const { blocks, prompt } = buildEvidenceContext(items);
  const result = await chat(
    {
      role: 'synth',
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: `EVIDENCE:\n\n${prompt}\n\n---\nQUESTION: ${question}` }],
      maxTokens: 1500,
    },
    { projectId, operation: 'SUMMARY' },
  );

  const validation = validateCitations(result.text, blocks);
  const analysis = await prisma.aiAnalysis.create({
    data: {
      projectId,
      kind: 'SUMMARY',
      question,
      provider: result.provider,
      model: result.model,
      outputText: result.text,
      outputJson: { grounded: validation.grounded, invalidRefs: validation.invalidRefs } as Prisma.InputJsonValue,
      citedEvidenceIds: validation.evidenceIdsUsed as Prisma.InputJsonValue,
      ungroundedStatements: validation.ungrounded as Prisma.InputJsonValue,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      createdById: userId,
    },
  });
  await audit({
    projectId,
    actorId: userId,
    actorLabel: userId ? `user:ai` : 'SYSTEM',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'ai_analysis',
    targetId: analysis.id,
    summary: `AI summary for "${question.slice(0, 80)}" — ${validation.evidenceIdsUsed.length} evidence cited, ${validation.ungrounded.length} ungrounded statement(s) flagged`,
    metadata: { model: result.model, tokens: result.usage },
  });
  return { id: analysis.id };
}

// ── AI query expansion (§5) ─────────────────────────────────────────────────

export async function expandQueriesAI(
  projectId: string,
  userId: string | null,
): Promise<{ id: string; queries: Array<{ query: string; rationale: string }> } | AiUnavailable> {
  const status = chatStatus();
  if (!status.available) return { available: false, reason: status.reason ?? 'AI not configured', setup: status.setup };

  const [project, executed, topEntities, latestSearch] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.query.findMany({ where: { search: { projectId }, executed: true }, select: { text: true }, take: 40 }),
    prisma.entity.findMany({
      where: { projectId, mergedIntoId: null },
      orderBy: { evidenceLinks: { _count: 'desc' } },
      take: 15,
      select: { type: true, displayName: true },
    }),
    prisma.search.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { originalQuery: true, subjectType: true } }),
  ]);

  const context = [
    `SUBJECT: ${latestSearch?.originalQuery ?? project.name}${latestSearch?.subjectType ? ` (${latestSearch.subjectType})` : ''}`,
    `OBJECTIVE: ${project.objective ?? 'general public-information research'}`,
    `ALREADY EXECUTED QUERIES:\n${[...new Set(executed.map((q) => q.text))].map((q) => `- ${q}`).join('\n') || '(none)'}`,
    `KNOWN ENTITIES:\n${topEntities.map((e) => `- ${e.type}: ${e.displayName}`).join('\n') || '(none)'}`,
  ].join('\n\n');

  const result = await chat(
    { role: 'extract', system: EXPAND_SYSTEM, messages: [{ role: 'user', content: context }], json: true, maxTokens: 800 },
    { projectId, operation: 'EXPAND' },
  );
  const parsed = parseJsonLoose<{ queries: Array<{ query: string; rationale: string }> }>(result.text);
  const queries = (parsed?.queries ?? [])
    .filter((q) => q && typeof q.query === 'string' && q.query.trim().length > 1)
    .slice(0, 8)
    .map((q) => ({ query: q.query.trim(), rationale: String(q.rationale ?? 'AI-suggested').slice(0, 300) }));

  const analysis = await prisma.aiAnalysis.create({
    data: {
      projectId,
      kind: 'QUERY_EXPANSION',
      provider: result.provider,
      model: result.model,
      outputText: result.text,
      outputJson: { queries } as Prisma.InputJsonValue,
      citedEvidenceIds: [] as Prisma.InputJsonValue,
      ungroundedStatements: [] as Prisma.InputJsonValue,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      createdById: userId,
    },
  });
  await audit({
    projectId,
    actorId: userId,
    actorLabel: 'user:ai',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'ai_analysis',
    targetId: analysis.id,
    summary: `AI proposed ${queries.length} additional search queries`,
  });
  return { id: analysis.id, queries };
}

// ── report generation (§28) ────────────────────────────────────────────────

export async function generateReport(
  reportId: string,
): Promise<void> {
  const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId }, include: { project: true } });
  const projectId = report.projectId;
  await prisma.report.update({ where: { id: reportId }, data: { status: 'RUNNING' } });

  try {
    const sections = await assembleReportSections(projectId, report.title);
    const markdown = renderMarkdown(report.title, sections);
    const checksum = (await import('node:crypto')).createHash('sha256').update(markdown).digest('hex');

    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'COMPLETED',
        sectionsJson: sections as unknown as Prisma.InputJsonValue,
        checksum,
        completedAt: new Date(),
      },
    });
    await audit({
      projectId,
      actorLabel: 'SYSTEM',
      action: 'REPORT_GENERATED',
      targetType: 'report',
      targetId: reportId,
      summary: `Report "${report.title}" generated (${sections.length} sections, ${sections.filter((s) => s.aiGenerated).length} with AI narrative)`,
    });
  } catch (err) {
    await prisma.report.update({ where: { id: reportId }, data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}

export interface ReportSection {
  heading: string;
  body: string; // markdown
  aiGenerated: boolean;
  citedEvidenceIds: string[];
  ungrounded?: string[];
}

async function assembleReportSections(projectId: string, title: string): Promise<ReportSection[]> {
  const aiAvailable = chatStatus().available;

  const [project, searches, evidenceCount, dupCount, entities, claims, contradictions, timeline, sources, coverageRuns] =
    await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
      prisma.search.findMany({ where: { projectId }, include: { _count: { select: { evidence: true } }, queries: { where: { executed: true }, select: { text: true } } } }),
      prisma.evidence.count({ where: { projectId, isDuplicate: false } }),
      prisma.evidence.count({ where: { projectId, isDuplicate: true } }),
      prisma.entity.findMany({ where: { projectId, mergedIntoId: null }, include: { _count: { select: { evidenceLinks: true } } }, orderBy: { evidenceLinks: { _count: 'desc' } }, take: 40 }),
      prisma.claim.findMany({ where: { projectId }, orderBy: { confidenceScore: 'desc' } }),
      prisma.contradiction.findMany({ where: { projectId }, include: { claimA: true, claimB: true } }),
      prisma.timelineEvent.findMany({ where: { projectId }, orderBy: { occurredAt: 'asc' }, take: 60, include: { evidence: { select: { id: true } } } }),
      prisma.source.findMany({ where: { evidence: { some: { projectId } } }, orderBy: { qualityScore: 'desc' }, take: 25 }),
      prisma.searchRun.groupBy({ by: ['connectorId', 'status'], where: { search: { projectId } }, _count: true }),
    ]);

  const sections: ReportSection[] = [];
  const push = (heading: string, body: string, extra: Partial<ReportSection> = {}) =>
    sections.push({ heading, body, aiGenerated: false, citedEvidenceIds: [], ...extra });

  // Scope
  push(
    'Scope',
    [
      `**Subject / project:** ${project.name}`,
      project.objective ? `**Objective:** ${project.objective}` : null,
      `**Languages:** ${project.defaultLanguages}`,
      project.dateRangeStart || project.dateRangeEnd
        ? `**Date range:** ${project.dateRangeStart?.toISOString().slice(0, 10) ?? '—'} to ${project.dateRangeEnd?.toISOString().slice(0, 10) ?? '—'}`
        : null,
      `**Report generated:** ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );

  // Methodology
  push(
    'Methodology',
    `Public-information research only. Sources were queried through official APIs and public endpoints; ` +
      `no authentication, privacy controls, or anti-bot measures were bypassed. Results were normalized, deduplicated ` +
      `(exact URL, canonical URL, content hash, and SimHash near-duplicate with syndication clustering), and retained as ` +
      `immutable evidence records with provenance. Entities were extracted deterministically (rule/gazetteer based — not ` +
      `a trained model). Claims were extracted with shallow entity-anchored patterns and scored by an explicit ` +
      `factor-based confidence model. Contradictions between claims are recorded and left for analyst resolution — the ` +
      `system does not silently choose between conflicting sources.`,
  );

  // Search coverage (§46)
  const coverageByConnector = new Map<string, { completed: number; skipped: number; failed: number }>();
  for (const row of coverageRuns) {
    const e = coverageByConnector.get(row.connectorId) ?? { completed: 0, skipped: 0, failed: 0 };
    if (row.status === 'COMPLETED') e.completed += row._count;
    else if (row.status === 'SKIPPED') e.skipped += row._count;
    else if (row.status === 'FAILED') e.failed += row._count;
    coverageByConnector.set(row.connectorId, e);
  }
  push(
    'Search Coverage',
    [
      `Total searches: ${searches.length}. Executed queries: ${[...new Set(searches.flatMap((s) => s.queries.map((q) => q.text)))].length}.`,
      '',
      '| Connector | Completed runs | Not run / skipped | Failed |',
      '|---|--:|--:|--:|',
      ...[...coverageByConnector.entries()].map(([c, v]) => `| ${c} | ${v.completed} | ${v.skipped} | ${v.failed} |`),
    ].join('\n'),
  );

  // Entities
  push(
    'Entities',
    [
      `${entities.length} distinct entities (after resolution). Most-referenced:`,
      '',
      '| Type | Entity | Evidence refs |',
      '|---|---|--:|',
      ...entities.slice(0, 25).map((e) => `| ${e.type} | ${e.displayName} | ${e._count.evidenceLinks} |`),
    ].join('\n'),
  );

  // Timeline
  push(
    'Timeline',
    timeline.length === 0
      ? 'No dated events derived.'
      : timeline
          .map(
            (t) =>
              `- **${t.precision === 'YEAR' ? t.occurredAt.toISOString().slice(0, 4) : t.occurredAt.toISOString().slice(0, 10)}** — ${t.title}${
                t.evidence ? ` \`${t.evidence.id}\`` : ''
              }`,
          )
          .join('\n'),
  );

  // Claims
  push(
    'Claims',
    claims.length === 0
      ? 'No claims extracted.'
      : [
          '| Claim | Corroboration | Confidence | Tag |',
          '|---|---|---|---|',
          ...claims
            .slice(0, 40)
            .map((c) => `| ${c.subject} — ${c.predicate.replace(/_/g, ' ').toLowerCase()} — ${c.object} | ${c.corroboration} | ${c.confidenceLevel} (${(c.confidenceScore * 100) | 0}%) | ${c.epistemicTag} |`),
        ].join('\n'),
  );

  // Contradictions
  push(
    'Contradictions',
    contradictions.length === 0
      ? 'No contradictions detected between the extracted claims.'
      : contradictions
          .map(
            (c, i) =>
              `**CONTRADICTION-${String(i + 1).padStart(3, '0')}** (${c.status})\n\n- ${c.explanation}\n- A: ${c.claimA.text}\n- B: ${c.claimB.text}`,
          )
          .join('\n\n'),
  );

  // Source assessment (§12)
  push(
    'Source Assessment',
    [
      '| Source | Tier | Quality | Reasons |',
      '|---|---|--:|---|',
      ...sources.map(
        (s) =>
          `| ${s.label} | ${s.tier ?? '—'} | ${s.qualityScore != null ? s.qualityScore.toFixed(2) : '—'} | ${
            Array.isArray(s.qualityReasons) ? (s.qualityReasons as string[]).slice(0, 3).join('; ') : '—'
          } |`,
      ),
    ].join('\n'),
  );

  // Evidence appendix
  const topEvidence = await prisma.evidence.findMany({
    where: { projectId, isDuplicate: false },
    orderBy: [{ createdAt: 'desc' }],
    take: 60,
    select: { id: true, title: true, url: true, sourcePlatform: true, publishedAt: true },
  });
  push(
    'Evidence',
    [
      `${evidenceCount} unique evidence records (${dupCount} additional marked duplicate/syndicated).`,
      '',
      ...topEvidence.map(
        (e) => `- \`${e.id}\` [${e.sourcePlatform}] ${e.publishedAt ? e.publishedAt.toISOString().slice(0, 10) : ''} — ${e.title ?? e.url ?? '(untitled)'}${e.url ? ` <${e.url}>` : ''}`,
      ),
    ].join('\n'),
  );

  // Uncertainties / limitations
  push(
    'Uncertainties & Limitations',
    [
      '- Claim extraction uses shallow pattern matching, not a trained model; phrasing edge-cases are missed or imperfectly parsed.',
      '- Entity resolution auto-merges only on strong identifiers; some duplicate entities may remain unmerged.',
      `- ${contradictions.filter((c) => c.status === 'OPEN').length} contradiction(s) remain unresolved.`,
      chatStatus().available
        ? '- The narrative sections below were written by an AI model constrained to the cited evidence; any statement it could not ground is listed under the section.'
        : '- No AI provider is configured, so this report contains no AI-written narrative — only deterministic assembly of the collected evidence.',
      '- Absence of a finding means "not found in the searched sources", not "does not exist". See Search Coverage.',
    ].join('\n'),
  );

  // ── AI narrative sections (only if a provider is configured) ──────────────
  if (aiAvailable && evidenceCount > 0) {
    const evForNarrative = await prisma.evidence.findMany({
      where: { projectId, isDuplicate: false },
      orderBy: [{ createdAt: 'desc' }],
      take: 24,
      select: { id: true, title: true, excerpt: true, fullText: true, url: true, publishedAt: true, source: { select: { label: true, tier: true } } },
    });
    const { blocks, prompt } = buildEvidenceContext(evForNarrative);

    for (const [heading, ask] of [
      ['Executive Summary', 'Write the executive summary: what the collected public information shows about the subject, and how confident we can be.'],
      ['Key Findings', 'List the key findings as bullet points, most significant first, each with an epistemic tag and citations.'],
      ['Conclusion', 'Write a brief conclusion: the overall picture, the biggest open questions, and what further research would resolve them.'],
    ] as const) {
      try {
        const r = await chat(
          {
            role: 'synth',
            system: REPORT_NARRATIVE_SYSTEM,
            messages: [{ role: 'user', content: `REPORT: ${title}\n\nEVIDENCE:\n\n${prompt}\n\n---\nTASK: ${ask}` }],
            maxTokens: 1200,
          },
          { projectId, operation: 'REPORT_SECTION' },
        );
        const v = validateCitations(r.text, blocks);
        sections.unshift({
          heading,
          body: r.text,
          aiGenerated: true,
          citedEvidenceIds: v.evidenceIdsUsed,
          ungrounded: v.ungrounded,
        });
        await prisma.aiAnalysis.create({
          data: {
            projectId, kind: 'REPORT_SECTION', question: heading, provider: r.provider, model: r.model,
            outputText: r.text, outputJson: {} as Prisma.InputJsonValue,
            citedEvidenceIds: v.evidenceIdsUsed as Prisma.InputJsonValue,
            ungroundedStatements: v.ungrounded as Prisma.InputJsonValue,
            inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, estimatedCostUsd: r.estimatedCostUsd,
          },
        });
      } catch (err) {
        logger.warn({ err, heading }, 'AI report section failed');
        sections.unshift({
          heading,
          body: `_AI narrative for this section could not be generated: ${(err as Error).message}_`,
          aiGenerated: true,
          citedEvidenceIds: [],
        });
      }
    }
  } else {
    sections.unshift({
      heading: 'Executive Summary',
      body:
        '_No AI provider is configured — this report is a deterministic assembly of the collected evidence with no AI-written narrative. ' +
        'Configure `AI_PROVIDER` (see docs/AI.md) and regenerate for an evidence-grounded executive summary, key findings, and conclusion._',
      aiGenerated: false,
      citedEvidenceIds: [],
    });
  }

  return sections;
}

function renderMarkdown(title: string, sections: ReportSection[]): string {
  const lines = [`# ${title}`, '', `_Generated ${new Date().toISOString()} · OSINT Platform_`, ''];
  for (const s of sections) {
    lines.push(`## ${s.heading}${s.aiGenerated ? ' _(AI narrative — evidence-grounded)_' : ''}`, '', s.body, '');
    if (s.ungrounded && s.ungrounded.length > 0) {
      lines.push(
        '> ⚠️ **Statements the citation validator could not ground in the provided evidence** (not to be treated as fact):',
        ...s.ungrounded.map((u) => `> - ${u}`),
        '',
      );
    }
  }
  return lines.join('\n');
}

// ── evidence selection ─────────────────────────────────────────────────────

async function selectEvidenceForQuestion(projectId: string, question: string, limit: number) {
  const sem = await semanticSearch(projectId, question, limit).catch(() => null);
  if (sem?.available && sem.hits.length > 0) {
    const ids = sem.hits.map((h) => h.evidenceId);
    const rows = await prisma.evidence.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, excerpt: true, fullText: true, url: true, publishedAt: true, source: { select: { label: true, tier: true } } },
    });
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  // fallback: keyword contains + recency
  const terms = question.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
  return prisma.evidence.findMany({
    where: {
      projectId,
      isDuplicate: false,
      ...(terms.length ? { OR: terms.map((t) => ({ fullText: { contains: t } })) } : {}),
    },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: { id: true, title: true, excerpt: true, fullText: true, url: true, publishedAt: true, source: { select: { label: true, tier: true } } },
  });
}
