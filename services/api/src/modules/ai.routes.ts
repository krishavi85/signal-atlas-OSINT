import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { loadEnv } from '../env.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { enqueueJob } from '../jobs/runner.js';
import { chatStatus } from '../ai/chat.js';
import { embeddingStatus } from '../ai/embeddings.js';
import { summarizeProject, expandQueriesAI } from '../orchestrator/AIResearchEngine.js';

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/ai/status', async () => {
    const env = loadEnv();
    const chat = chatStatus();
    const emb = embeddingStatus();
    const monthSpend = await prisma.aiUsage.aggregate({
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
      where: { createdAt: { gte: new Date(new Date().setUTCDate(1)) } },
    });
    return {
      chat,
      embeddings: emb,
      budget: {
        monthlyUsd: env.BUDGET_MONTHLY_USD,
        dailyTokens: env.BUDGET_LLM_TOKENS_DAY,
        spentThisMonthUsd: Number((monthSpend._sum.estimatedCostUsd ?? 0).toFixed(4)),
        tokensThisMonth: (monthSpend._sum.inputTokens ?? 0) + (monthSpend._sum.outputTokens ?? 0),
      },
    };
  });

  // Evidence-grounded Q&A (§13, §14). Synchronous — the model call is the only slow part.
  app.post('/projects/:id/ai/ask', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const { question } = z.object({ question: z.string().min(3).max(500) }).parse(req.body);
    const u = currentUser(req);
    const result = await summarizeProject(id, question, u.id);
    if ('available' in result) return result; // { available:false, reason, setup }
    return prisma.aiAnalysis.findUniqueOrThrow({ where: { id: result.id } });
  });

  app.get('/projects/:id/ai/analyses', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ kind: z.string().optional(), limit: z.coerce.number().min(1).max(50).default(20) }).parse(req.query);
    return prisma.aiAnalysis.findMany({
      where: { projectId: id, ...(q.kind ? { kind: q.kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
  });

  app.get('/ai-analyses/:analysisId', async (req) => {
    const { analysisId } = z.object({ analysisId: z.string() }).parse(req.params);
    const a = await prisma.aiAnalysis.findUnique({ where: { id: analysisId } });
    if (!a) throw notFound('Analysis not found');
    await assertProjectAccess(req, a.projectId);
    const citedIds = Array.isArray(a.citedEvidenceIds) ? (a.citedEvidenceIds as string[]) : [];
    const evidence = await prisma.evidence.findMany({
      where: { id: { in: citedIds } },
      select: { id: true, title: true, url: true, sourcePlatform: true, publishedAt: true },
    });
    return { ...a, evidence };
  });

  // AI query expansion (§5). Suggestions are NOT auto-executed.
  app.post('/projects/:id/ai/expand-queries', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const result = await expandQueriesAI(id, u.id);
    return result;
  });

  // ── Reports (§28) ─────────────────────────────────────────────────────────
  app.post('/projects/:id/reports', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const body = z
      .object({ title: z.string().min(1).max(200).optional(), format: z.enum(['MARKDOWN', 'HTML', 'JSON']).default('MARKDOWN') })
      .parse(req.body ?? {});
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    const report = await prisma.report.create({
      data: {
        projectId: id,
        title: body.title ?? `${project.name} — Intelligence Report`,
        format: body.format,
        status: 'QUEUED',
        generatedById: u.id,
      },
    });
    const jobId = await enqueueJob({ type: 'REPORT_GENERATE', projectId: id, payload: { reportId: report.id } });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'REPORT_GENERATED',
      targetType: 'report', targetId: report.id, summary: `Queued report "${report.title}"`,
    });
    reply.status(202).send({ reportId: report.id, jobId });
  });

  app.get('/projects/:id/reports', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    return prisma.report.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, format: true, status: true, checksum: true, error: true, createdAt: true, completedAt: true },
    });
  });

  app.get('/reports/:reportId', async (req) => {
    const { reportId } = z.object({ reportId: z.string() }).parse(req.params);
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFound('Report not found');
    await assertProjectAccess(req, report.projectId);
    return report;
  });

  app.get('/reports/:reportId/export', async (req, reply) => {
    const { reportId } = z.object({ reportId: z.string() }).parse(req.params);
    const fmt = z.object({ format: z.enum(['md', 'markdown', 'html', 'json', 'pdf', 'docx']).default('md') }).parse(req.query).format;
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFound('Report not found');
    await assertProjectAccess(req, report.projectId);
    if (report.status !== 'COMPLETED') throw badRequest(`Report is ${report.status}`);
    const sections = (report.sectionsJson ?? []) as Array<{ heading: string; body: string; aiGenerated: boolean; ungrounded?: string[] }>;

    if (fmt === 'json') {
      reply.header('content-disposition', `attachment; filename="report-${reportId}.json"`);
      return reply.type('application/json').send(JSON.stringify({ report, sections }, null, 2));
    }
    const generatedAt = report.completedAt?.toISOString() ?? new Date().toISOString();
    if (fmt === 'pdf') {
      const { renderReportPdf } = await import('../lib/reportRenderers.js');
      const pdf = await renderReportPdf(report.title, generatedAt, sections);
      reply.header('content-disposition', `attachment; filename="report-${reportId}.pdf"`);
      return reply.type('application/pdf').send(pdf);
    }
    if (fmt === 'docx') {
      const { renderReportDocx } = await import('../lib/reportRenderers.js');
      const docxBuf = await renderReportDocx(report.title, generatedAt, sections);
      reply.header('content-disposition', `attachment; filename="report-${reportId}.docx"`);
      return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(docxBuf);
    }
    const md = [`# ${report.title}`, '', `_Generated ${report.completedAt?.toISOString()} · checksum ${report.checksum?.slice(0, 16)}_`, '']
      .concat(
        sections.flatMap((s) => [
          `## ${s.heading}${s.aiGenerated ? ' _(AI narrative — evidence-grounded)_' : ''}`,
          '',
          s.body,
          '',
          ...(s.ungrounded?.length ? ['> ⚠️ Ungrounded statements (not fact):', ...s.ungrounded.map((u) => `> - ${u}`), ''] : []),
        ]),
      )
      .join('\n');
    if (fmt === 'html') {
      reply.header('content-disposition', `attachment; filename="report-${reportId}.html"`);
      return reply.type('text/html').send(mdToHtml(report.title, md));
    }
    reply.header('content-disposition', `attachment; filename="report-${reportId}.md"`);
    return reply.type('text/markdown').send(md);
  });
}

/** Minimal, safe Markdown→HTML (headings, bold, lists, tables, code, blockquote). */
function mdToHtml(title: string, md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  let inTable = false;
  for (const raw of lines) {
    const line = raw;
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (/^-+$/.test(cells.join('').replace(/[:\s|]/g, ''))) continue;
      if (!inTable) {
        out.push('<table><tbody>');
        inTable = true;
      }
      out.push('<tr>' + cells.map((c) => `<td>${inline(esc(c))}</td>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(esc(line.replace(/^\s*[-*]\s+/, '')))}</li>`);
      continue;
    } else if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1]!.length}>${inline(esc(h[2]!))}</h${h[1]!.length}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inline(esc(line.replace(/^>\s?/, '')))}</blockquote>`);
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    out.push(`<p>${inline(esc(line))}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inTable) out.push('</tbody></table>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}table{border-collapse:collapse;width:100%;margin:1rem 0}td{border:1px solid #ddd;padding:.4rem .6rem;font-size:13px}blockquote{border-left:3px solid #e0b000;background:#fffbe6;margin:.5rem 0;padding:.5rem .8rem;font-size:14px}code{background:#f0f0f0;padding:.1rem .3rem;border-radius:3px}h2{border-bottom:1px solid #eee;padding-bottom:.2rem;margin-top:2rem}</style></head><body>${out.join('\n')}</body></html>`;
  function inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(EVIDENCE-\d{4}-\d{6})\]/g, '<code>$1</code>')
      .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  }
}
