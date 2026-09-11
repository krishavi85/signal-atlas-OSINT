import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { registry } from '../connectors/runtime.js';

/**
 * Observability (§50): a genuine Prometheus text-exposition endpoint computed
 * from live counts — no external metrics library, no placeholder numbers.
 * Unauthenticated by convention (matches /healthz, /readyz) since scrapers
 * typically can't carry a bearer token; it exposes only aggregate counts, no
 * investigation content.
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    const [jobsByStatus, evidenceTotal, evidenceDup, projectsByStatus, healthRows, usersTotal, monitoringEnabled] = await Promise.all([
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.evidence.count({ where: { isDuplicate: false } }),
      prisma.evidence.count({ where: { isDuplicate: true } }),
      prisma.project.groupBy({ by: ['status'], _count: true }),
      prisma.connectorHealthCheck.findMany({ orderBy: { checkedAt: 'desc' }, select: { connectorId: true, state: true } }),
      prisma.user.count(),
      prisma.monitoringJob.count({ where: { enabled: true } }),
    ]);
    // most-recent row per connector (healthRows is already ordered desc)
    const connectorHealthLatest = new Map<string, string>();
    for (const h of healthRows) if (!connectorHealthLatest.has(h.connectorId)) connectorHealthLatest.set(h.connectorId, h.state);

    const lines: string[] = [];
    const gauge = (name: string, help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    };

    gauge('osint_jobs_total', 'Background jobs by status');
    for (const j of jobsByStatus) lines.push(`osint_jobs_total{status="${j.status}"} ${j._count}`);

    gauge('osint_evidence_total', 'Evidence records, by duplicate status');
    lines.push(`osint_evidence_total{duplicate="false"} ${evidenceTotal}`, `osint_evidence_total{duplicate="true"} ${evidenceDup}`);

    gauge('osint_projects_total', 'Investigations by status');
    for (const p of projectsByStatus) lines.push(`osint_projects_total{status="${p.status}"} ${p._count}`);

    gauge('osint_connector_health', 'Latest connector health state (1 = current state)');
    for (const id of registry.ids()) {
      lines.push(`osint_connector_health{connector="${id}",state="${connectorHealthLatest.get(id) ?? 'UNKNOWN'}"} 1`);
    }

    gauge('osint_users_total', 'Registered user accounts');
    lines.push(`osint_users_total ${usersTotal}`);

    gauge('osint_monitoring_jobs_enabled', 'Active monitoring jobs');
    lines.push(`osint_monitoring_jobs_enabled ${monitoringEnabled}`);

    gauge('osint_process_uptime_seconds', 'API process uptime');
    lines.push(`osint_process_uptime_seconds ${process.uptime().toFixed(0)}`);

    const mem = process.memoryUsage();
    gauge('osint_process_memory_bytes', 'API process memory usage by type');
    lines.push(`osint_process_memory_bytes{type="rss"} ${mem.rss}`, `osint_process_memory_bytes{type="heapUsed"} ${mem.heapUsed}`);

    reply.type('text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });
}
