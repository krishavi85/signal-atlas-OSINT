import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { makeConnectorContext, registry } from './runtime.js';

/**
 * Run healthCheck() for one or all connectors and persist the result (§32).
 * Returns the latest health rows.
 */
export async function checkConnectorHealth(connectorId: string): Promise<void> {
  const connector = registry.get(connectorId);
  if (!connector) throw new Error(`Unknown connector ${connectorId}`);
  const ctx = await makeConnectorContext(connectorId);
  let health;
  try {
    health = await connector.healthCheck(ctx);
  } catch (err) {
    health = {
      state: 'OFFLINE' as const,
      checkedAt: new Date().toISOString(),
      latencyMs: null,
      lastSuccessAt: null,
      lastError: err instanceof Error ? err.message : String(err),
      requestsRemaining: null,
      message: 'healthCheck threw',
    };
  }
  await prisma.connectorHealthCheck.create({
    data: {
      connectorId,
      state: health.state,
      latencyMs: health.latencyMs ?? null,
      lastSuccessAt: health.lastSuccessAt ? new Date(health.lastSuccessAt) : null,
      lastError: health.lastError,
      requestsRemaining: health.requestsRemaining ?? null,
      message: health.message,
    },
  });
  logger.debug({ connectorId, state: health.state, latencyMs: health.latencyMs }, 'connector health');
}

export async function checkAllConnectorHealth(): Promise<void> {
  await Promise.allSettled(registry.ids().map((id) => checkConnectorHealth(id)));
  await audit({
    actorLabel: 'SYSTEM',
    action: 'CONNECTOR_HEALTH_CHECKED',
    summary: `Ran health checks for ${registry.ids().length} connectors`,
  });
}

export async function latestHealth(connectorId: string) {
  return prisma.connectorHealthCheck.findFirst({
    where: { connectorId },
    orderBy: { checkedAt: 'desc' },
  });
}

export async function healthHistory(connectorId: string, limit = 50) {
  return prisma.connectorHealthCheck.findMany({
    where: { connectorId },
    orderBy: { checkedAt: 'desc' },
    take: limit,
  });
}
