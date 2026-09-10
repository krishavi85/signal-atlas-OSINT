import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * DB-backed response cache (§39). Keyed by connector + a hash of the request
 * shape. TTL per entry. `refresh` bypasses reads but still writes.
 */
export function cacheKey(connectorId: string, parts: unknown): string {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
  return `${connectorId}:${h}`;
}

export function makeCache(connectorId: string, opts: { refresh?: boolean } = {}) {
  return {
    async get(key: string): Promise<string | null> {
      if (opts.refresh) return null;
      const row = await prisma.responseCache.findUnique({ where: { key } });
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) {
        await prisma.responseCache.delete({ where: { key } }).catch(() => {});
        return null;
      }
      return row.value;
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await prisma.responseCache
        .upsert({
          where: { key },
          create: { key, connectorId, value, expiresAt },
          update: { value, expiresAt },
        })
        .catch((err) => logger.warn({ err }, 'cache write failed'));
    },
  };
}

export async function purgeExpiredCache(): Promise<number> {
  const res = await prisma.responseCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
