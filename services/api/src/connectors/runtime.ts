import {
  buildDefaultRegistry,
  type Connector,
  type ConnectorContext,
} from '@osint/connectors';
import { prisma } from '../db.js';
import { KNOWN_CONNECTOR_ENV_KEYS, loadEnv } from '../env.js';
import { decryptJson } from '../lib/crypto.js';
import { makeCache } from '../lib/cache.js';
import { consumeDailyBudget } from '../lib/budget.js';
import { logger } from '../logger.js';
import { safeFetch } from '../lib/safeFetch.js';

const env = loadEnv();
export const registry = buildDefaultRegistry();

/**
 * Resolve the effective config for a connector: environment variables provide
 * defaults; DB-stored encrypted credentials (set via the UI) override them.
 * Secrets are only ever assembled here, in the API process — never sent to the
 * client (§40).
 */
export async function resolveConnectorConfig(connectorId: string): Promise<Record<string, string | undefined>> {
  const base: Record<string, string | undefined> = {};
  for (const key of KNOWN_CONNECTOR_ENV_KEYS) base[key] = env.raw[key];

  const row = await prisma.connector.findUnique({ where: { id: connectorId } });
  if (row?.credentialsEnc) {
    try {
      Object.assign(base, decryptJson<Record<string, string>>(row.credentialsEnc));
    } catch (err) {
      logger.error({ err, connectorId }, 'failed to decrypt connector credentials');
    }
  }
  if (row?.configJson && typeof row.configJson === 'object') {
    for (const [k, v] of Object.entries(row.configJson as Record<string, unknown>)) {
      if (typeof v === 'string') base[k] = v;
    }
  }
  return base;
}

export interface ContextOptions {
  signal?: AbortSignal;
  refreshCache?: boolean;
}

export async function makeConnectorContext(connectorId: string, opts: ContextOptions = {}): Promise<ConnectorContext> {
  const config = await resolveConnectorConfig(connectorId);
  return {
    config,
    userAgent: env.HTTP_USER_AGENT,
    contactEmail: env.HTTP_CONTACT_EMAIL,
    log: (level, msg, extra) => logger[level]({ connector: connectorId, ...extra }, msg),
    safeFetch: (url, init) => safeFetch(url, init),
    cache: makeCache(connectorId, { refresh: opts.refreshCache }),
    budget: { consume: (maxPerDay: number) => consumeDailyBudget(connectorId, maxPerDay) },
    signal: opts.signal,
  };
}

/** Sync the code-defined connectors into the DB so config/health can attach. */
export async function ensureConnectorsSeeded(): Promise<void> {
  for (const c of registry.all()) {
    const report = getReport(c);
    await prisma.connector.upsert({
      where: { id: c.id },
      create: { id: c.id, displayName: c.displayName, category: report.category },
      update: { displayName: c.displayName, category: report.category },
    });
  }
  // pseudo-connectors that are not Connector classes but need a row for the
  // Evidence.connectorId FK (user uploads).
  await prisma.connector.upsert({
    where: { id: 'document' },
    create: { id: 'document', displayName: 'Uploaded document', category: 'user-input' },
    update: {},
  });
}

export function getReport(c: Connector, ctx: ConnectorContext | null = null) {
  const fn = c.capabilities as (x?: ConnectorContext | null) => ReturnType<Connector['capabilities']>;
  return fn.call(c, ctx);
}

/** Capability reports for every connector using resolved runtime config. */
export async function allConnectorReports() {
  const out = [];
  for (const c of registry.all()) {
    const ctx = await makeConnectorContext(c.id);
    out.push(getReport(c, ctx));
  }
  return out;
}
