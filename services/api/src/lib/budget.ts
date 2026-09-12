import { prisma } from '../db.js';

export interface BudgetDecision {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

/** Pure decision logic (§38): given today's count-so-far, is one more request allowed? */
export function decideBudget(usedAfterThisAttempt: number, maxPerDay: number, resetAt: string): BudgetDecision {
  return {
    allowed: usedAfterThisAttempt <= maxPerDay,
    used: usedAfterThisAttempt,
    limit: maxPerDay,
    remaining: Math.max(0, maxPerDay - usedAfterThisAttempt),
    resetAt,
  };
}

export function nextUtcMidnight(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
}

/**
 * Record one request attempt against a connector's daily budget and report
 * whether it's within the cap. Persisted in the DB (not the in-process token
 * bucket) so the budget survives restarts and protects a real provider quota
 * — e.g. Google CSE's documented 100 free queries/day — from being exceeded
 * even across process restarts or multiple workers.
 */
export async function consumeDailyBudget(connectorId: string, maxPerDay: number): Promise<BudgetDecision> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `${connectorId}:${day}`;
  const row = await prisma.connectorBudgetUsage.upsert({
    where: { key },
    create: { key, connectorId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return decideBudget(row.count, maxPerDay, nextUtcMidnight(now).toISOString());
}
