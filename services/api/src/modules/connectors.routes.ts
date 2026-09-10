import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { encryptJson } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { checkConnectorHealth, healthHistory, latestHealth } from '../connectors/health.js';
import { allConnectorReports, getReport, makeConnectorContext, registry } from '../connectors/runtime.js';

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // §31 capability registry + §32 health, merged view
  app.get('/connectors', async () => {
    const reports = await allConnectorReports();
    const health = await prisma.connectorHealthCheck.findMany({ orderBy: { checkedAt: 'desc' } });
    const latestByConnector = new Map<string, (typeof health)[number]>();
    for (const h of health) if (!latestByConnector.has(h.connectorId)) latestByConnector.set(h.connectorId, h);
    const rows = await prisma.connector.findMany();
    const configured = new Map(rows.map((r) => [r.id, r]));

    return reports.map((r) => {
      const c = registry.get(r.connectorId)!;
      return {
        ...r,
        enabled: configured.get(r.connectorId)?.enabled ?? true,
        hasStoredCredentials: Boolean(configured.get(r.connectorId)?.credentialsEnc),
        rateLimit: c.rateLimitStatus(),
        health: latestByConnector.get(r.connectorId) ?? null,
      };
    });
  });

  app.get('/connectors/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = registry.get(id);
    if (!c) throw notFound('Connector not found');
    const ctx = await makeConnectorContext(id);
    return {
      ...getReport(c, ctx),
      rateLimit: c.rateLimitStatus(),
      health: await latestHealth(id),
      healthHistory: await healthHistory(id, 50),
    };
  });

  app.post('/connectors/:id/health-check', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!registry.get(id)) throw notFound('Connector not found');
    await checkConnectorHealth(id);
    return latestHealth(id);
  });

  // Store connector credentials (admin only). Body is an object of key->value;
  // values are encrypted at rest and never returned.
  app.put('/connectors/:id/credentials', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!registry.get(id)) throw notFound('Connector not found');
    const body = z.record(z.string()).parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest('Provide at least one credential key');
    const u = currentUser(req);

    await prisma.connector.upsert({
      where: { id },
      create: { id, displayName: registry.get(id)!.displayName, category: getReport(registry.get(id)!).category, credentialsEnc: encryptJson(body) },
      update: { credentialsEnc: encryptJson(body) },
    });
    await audit({
      actorId: u.id, actorLabel: `user:${u.email}`, action: 'CONNECTOR_CONFIGURED',
      targetType: 'connector', targetId: id,
      summary: `Set credentials for connector "${id}"`, metadata: { keys: Object.keys(body) },
    });
    await checkConnectorHealth(id);
    return { ok: true, connectorId: id, storedKeys: Object.keys(body), health: await latestHealth(id) };
  });

  app.delete('/connectors/:id/credentials', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const u = currentUser(req);
    await prisma.connector.update({ where: { id }, data: { credentialsEnc: null } }).catch(() => {});
    await audit({ actorId: u.id, actorLabel: `user:${u.email}`, action: 'CONNECTOR_CONFIGURED', targetType: 'connector', targetId: id, summary: `Cleared credentials for "${id}"` });
    reply.status(204).send();
  });

  app.patch('/connectors/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return prisma.connector.upsert({
      where: { id },
      create: { id, displayName: registry.get(id)?.displayName ?? id, category: getReport(registry.get(id)!).category, enabled },
      update: { enabled },
    });
  });
}
