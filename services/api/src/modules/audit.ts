import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Append-only audit log (§29). Every mutation of consequence routes through
 * `audit()`. Reads answer: "How did the system reach this conclusion?"
 */
export type AuditAction =
  | 'USER_REGISTERED'
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_PAUSED'
  | 'PROJECT_RESUMED'
  | 'PROJECT_ARCHIVED'
  | 'MEMBER_ADDED'
  | 'MEMBER_REMOVED'
  | 'CONNECTOR_CONFIGURED'
  | 'CONNECTOR_HEALTH_CHECKED'
  | 'SEARCH_EXECUTED'
  | 'CONNECTOR_USED'
  | 'EVIDENCE_ADDED'
  | 'EVIDENCE_REMOVED'
  | 'EVIDENCE_DEDUPED'
  | 'ENTITY_EXTRACTED'
  | 'ENTITY_MERGED'
  | 'ENTITY_SEPARATED'
  | 'RELATIONSHIP_ADDED'
  | 'CLAIM_EXTRACTED'
  | 'AI_ANALYSIS_EXECUTED'
  | 'REPORT_GENERATED'
  | 'MONITORING_RUN'
  | 'DOCUMENT_INGESTED'
  | 'USER_MODIFICATION';

export interface AuditParams {
  projectId?: string | null;
  actorId?: string | null;
  actorLabel: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function audit(p: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        projectId: p.projectId ?? null,
        actorId: p.actorId ?? null,
        actorLabel: p.actorLabel,
        action: p.action,
        targetType: p.targetType,
        targetId: p.targetId,
        summary: p.summary,
        metadataJson: p.metadata ? (p.metadata as object) : undefined,
      },
    });
  } catch (err) {
    // Audit must never break the primary operation, but a failure is itself notable.
    logger.error({ err, action: p.action }, 'audit write failed');
  }
}
