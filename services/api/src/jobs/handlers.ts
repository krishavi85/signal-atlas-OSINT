import { prisma } from '../db.js';
import { checkAllConnectorHealth } from '../connectors/health.js';
import { runResearchRun } from '../orchestrator/pipeline.js';
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

  // Placeholders that fail honestly rather than pretending to work (§51).
  for (const type of ['DOCUMENT_INGEST', 'MONITORING_RUN', 'REPORT_GENERATE', 'AI_ANALYSIS'] as const) {
    registerJobHandler(type, async () => {
      throw new Error(
        `Job type ${type} is not implemented yet (see ROADMAP.md). This job will be marked FAILED rather than returning fabricated results.`,
      );
    });
  }
}
