import { prisma } from '../db.js';
import { checkAllConnectorHealth } from '../connectors/health.js';
import { runResearchRun } from '../orchestrator/pipeline.js';
import { ingestDocument } from '../orchestrator/DocumentIngest.js';
import { backfillEmbeddings } from '../orchestrator/SemanticIndex.js';
import { registerJobHandler } from './runner.js';

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
    return { status: search?.status === 'PARTIAL' ? 'PARTIAL' : 'COMPLETED', result: progress };
  });

  registerJobHandler('CONNECTOR_HEALTH', async () => {
    await checkAllConnectorHealth();
    return { status: 'COMPLETED' };
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

  // Placeholders that fail honestly rather than pretending to work (§51).
  for (const type of ['MONITORING_RUN', 'REPORT_GENERATE'] as const) {
    registerJobHandler(type, async () => {
      throw new Error(
        `Job type ${type} is not implemented yet (see ROADMAP.md). This job is marked FAILED rather than returning fabricated results.`,
      );
    });
  }
}
