import { formatEvidenceId } from '@osint/core';
import { prisma } from '../db.js';

/**
 * Allocate the next immutable evidence id (EVIDENCE-YYYY-NNNNNN) atomically
 * using the Counter table. Safe under the in-process job runner; for multi-node
 * deployments the UPDATE ... RETURNING is still atomic per row.
 */
export async function nextEvidenceId(tx: typeof prisma = prisma): Promise<{ id: string; year: number; seq: number }> {
  const year = new Date().getUTCFullYear();
  const name = `evidence-${year}`;
  const updated = await tx.counter.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return { id: formatEvidenceId(year, updated.value), year, seq: updated.value };
}
