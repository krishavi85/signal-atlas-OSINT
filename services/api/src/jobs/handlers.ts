import { prisma } from '../db.js';
import { checkAllConnectorHealth } from '../connectors/health.js';
import { runResearchRun } from '../orchestrator/pipeline.js';
import { ingestDocument } from '../orchestrator/DocumentIngest.js';
import { backfillEmbeddings } from '../orchestrator/SemanticIndex.js';
import { generateReport } from '../orchestrator/AIResearchEngine.js';
import { collectMediaForProject, processProjectMedia } from '../orchestrator/MediaEngine.js';
import { enqueueJob, registerJobHandler } from './runner.js';

/** Wire concrete job handlers into the runner. Called once at startup. */
export function registerAllJobHandlers(): void {
  registerJobHandler('RESEARCH_RUN', async (ctx) => {
    const searchId = String(ctx.payload.searchId ?? '');
    if (!searchId) throw new Error('RESEARCH_RUN payload missing searchId');
    await prisma.search.update({ where: { id: searchId }, data: { jobId: ctx.jobId } }).catch(() => {});
    const progress = await runResearchRun(
      searchId,
      async (p) => {
        await ctx.reportProgress({
          phase: p.phase,
          sourcesPlanned: p.sourcesPlanned,
          sourcesCompleted: p.sourcesCompleted,
          resultsDiscovered: p.resultsDiscovered,
          uniqueResults: p.uniqueResults,
          evidenceRecords: p.evidenceRecords,
          entitiesExtracted: p.entitiesExtracted,
          claimsExtracted: p.claimsExtracted,
          connectorStatuses: p.connectorStatuses,
        });
      },
      ctx.signal,
    );
    const search = await prisma.search.findUnique({ where: { id: searchId } });
    // collect media referenced by the new evidence and queue processing (§19)
    if (search?.projectId) {
      const n = await collectMediaForProject(search.projectId).catch(() => 0);
      if (n > 0) await enqueueJob({ type: 'MEDIA_PROCESS', projectId: search.projectId, payload: { projectId: search.projectId } }).catch(() => {});
    }
    return { status: search?.status === 'PARTIAL' ? 'PARTIAL' : 'COMPLETED', result: progress };
  });

  registerJobHandler('CONNECTOR_HEALTH', async () => {
    await checkAllConnectorHealth();
    return { status: 'COMPLETED' };
  });

  registerJobHandler('MEDIA_PROCESS', async (ctx) => {
    const projectId = String(ctx.payload.projectId ?? '');
    if (!projectId) throw new Error('MEDIA_PROCESS payload missing projectId');
    await collectMediaForProject(projectId);
    const result = await processProjectMedia(projectId, { vision: Boolean(ctx.payload.vision) });
    await ctx.reportProgress(result as unknown as Record<string, unknown>);
    return { status: result.errors > 0 && result.processed === 0 ? 'PARTIAL' : 'COMPLETED', result };
  });

  registerJobHandler('DOCUMENT_INGEST', async (ctx) => {
    const documentId = String(ctx.payload.documentId ?? '');
    if (!documentId) throw new Error('DOCUMENT_INGEST payload missing documentId');
    const result = await ingestDocument(documentId);
    await ctx.reportProgress({ evidenceId: result.evidenceId, entitiesExtracted: result.entities });
    return { status: 'COMPLETED', result };
  });

  registerJobHandler('AI_ANALYSIS', async (ctx) => {
    // Currently the only AI_ANALYSIS job is semantic-index backfill (§23).
    const op = String(ctx.payload.op ?? '');
    if (op === 'EMBED') {
      const projectId = String(ctx.payload.projectId ?? '');
      const result = await backfillEmbeddings(projectId);
      await ctx.reportProgress(result);
      if (result.embedded === 0 && result.skipped && result.skipped !== 'up to date') {
        throw new Error(`Embedding backfill could not run: ${result.skipped}`);
      }
      return { status: 'COMPLETED', result };
    }
    throw new Error(`Unknown AI_ANALYSIS op "${op}"`);
  });

  registerJobHandler('REPORT_GENERATE', async (ctx) => {
    const reportId = String(ctx.payload.reportId ?? '');
    if (!reportId) throw new Error('REPORT_GENERATE payload missing reportId');
    await generateReport(reportId);
    return { status: 'COMPLETED', result: { reportId } };
  });

  // Placeholder that fails honestly rather than pretending to work (§51).
  registerJobHandler('MONITORING_RUN', async () => {
    throw new Error(
      'MONITORING_RUN is not implemented yet (Phase 7, see ROADMAP.md). Marked FAILED rather than returning fabricated results.',
    );
  });
}
