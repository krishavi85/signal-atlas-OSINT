import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertProjectAccess } from './projects.js';
import {
  buildEvidencePackage,
  exportAuditLogCsv,
  exportClaimsCsv,
  exportEntitiesCsv,
  exportEvidenceJson,
  exportRelationshipsCsv,
  exportSourcesCsv,
  exportTimelineCsv,
} from '../orchestrator/ExportEngine.js';

/**
 * Individual exports + the full evidence package (§48). Every export reads
 * live from the database — no caching — so it always reflects current state.
 */
export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  const csvExports: Record<string, (projectId: string) => Promise<string>> = {
    sources: exportSourcesCsv,
    entities: exportEntitiesCsv,
    relationships: exportRelationshipsCsv,
    timeline: exportTimelineCsv,
    claims: exportClaimsCsv,
    'audit-log': exportAuditLogCsv,
  };

  app.get('/projects/:id/export/evidence.json', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const json = await exportEvidenceJson(id);
    reply.header('content-disposition', 'attachment; filename="evidence.json"');
    return reply.type('application/json').send(json);
  });

  app.get('/projects/:id/export/:kind.csv', async (req, reply) => {
    const { id, kind } = z.object({ id: z.string(), kind: z.enum(['sources', 'entities', 'relationships', 'timeline', 'claims', 'audit-log']) }).parse(
      req.params,
    );
    await assertProjectAccess(req, id);
    const csv = await csvExports[kind]!(id);
    reply.header('content-disposition', `attachment; filename="${kind}.csv"`);
    return reply.type('text/csv').send(csv);
  });

  app.get('/projects/:id/export/package.zip', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const zip = await buildEvidencePackage(id);
    reply.header('content-disposition', 'attachment; filename="evidence-package.zip"');
    return reply.type('application/zip').send(zip);
  });
}
