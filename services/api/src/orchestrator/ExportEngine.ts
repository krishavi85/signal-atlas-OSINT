import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { toCsv } from '../lib/csv.js';

/**
 * Export engine (§48). Every export is assembled directly from the database —
 * nothing is cached or pre-rendered, so an export always reflects current
 * state, and every file in a package gets a checksum in the manifest.
 */

export async function exportEvidenceJson(projectId: string): Promise<string> {
  const rows = await prisma.evidence.findMany({
    where: { projectId },
    include: { source: { select: { label: true, tier: true, qualityScore: true } }, connector: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return JSON.stringify(rows, null, 2);
}

export async function exportSourcesCsv(projectId: string): Promise<string> {
  const rows = await prisma.source.findMany({ where: { evidence: { some: { projectId } } }, include: { _count: { select: { evidence: true } } } });
  return toCsv(
    rows.map((s) => ({
      label: s.label, kind: s.kind, platform: s.platform, registrableDomain: s.registrableDomain,
      tier: s.tier, qualityScore: s.qualityScore, evidenceCount: s._count.evidence,
      firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt,
    })),
    ['label', 'kind', 'platform', 'registrableDomain', 'tier', 'qualityScore', 'evidenceCount', 'firstSeenAt', 'lastSeenAt'],
  );
}

export async function exportEntitiesCsv(projectId: string): Promise<string> {
  const rows = await prisma.entity.findMany({
    where: { projectId, mergedIntoId: null },
    include: { _count: { select: { evidenceLinks: true, relationshipsFrom: true, relationshipsTo: true } }, aliases: { select: { value: true } } },
  });
  return toCsv(
    rows.map((e) => ({
      id: e.id, type: e.type, displayName: e.displayName, canonicalValue: e.canonicalValue,
      resolutionConfidence: e.resolutionConfidence, evidenceCount: e._count.evidenceLinks,
      relationshipCount: e._count.relationshipsFrom + e._count.relationshipsTo,
      aliases: e.aliases.map((a) => a.value),
    })),
    ['id', 'type', 'displayName', 'canonicalValue', 'resolutionConfidence', 'evidenceCount', 'relationshipCount', 'aliases'],
  );
}

export async function exportRelationshipsCsv(projectId: string): Promise<string> {
  const rows = await prisma.relationship.findMany({
    where: { projectId },
    include: { from: { select: { displayName: true, type: true } }, to: { select: { displayName: true, type: true } } },
  });
  return toCsv(
    rows.map((r) => ({
      fromType: r.from.type, from: r.from.displayName, type: r.type, toType: r.to.type, to: r.to.displayName,
      directed: r.directed, confidence: r.confidence, evidenceIds: r.evidenceIds, createdBy: r.createdBy, createdAt: r.createdAt,
    })),
    ['fromType', 'from', 'type', 'toType', 'to', 'directed', 'confidence', 'evidenceIds', 'createdBy', 'createdAt'],
  );
}

export async function exportTimelineCsv(projectId: string): Promise<string> {
  const rows = await prisma.timelineEvent.findMany({ where: { projectId }, orderBy: { occurredAt: 'asc' } });
  return toCsv(
    rows.map((t) => ({
      occurredAt: t.occurredAt, precision: t.precision, eventType: t.eventType, title: t.title,
      description: t.description, confidenceLevel: t.confidenceLevel, evidenceId: t.evidenceId,
    })),
    ['occurredAt', 'precision', 'eventType', 'title', 'description', 'confidenceLevel', 'evidenceId'],
  );
}

export async function exportClaimsCsv(projectId: string): Promise<string> {
  const rows = await prisma.claim.findMany({ where: { projectId }, include: { _count: { select: { evidenceLinks: true } } } });
  return toCsv(
    rows.map((c) => ({
      subject: c.subject, predicate: c.predicate, object: c.object, claimDate: c.claimDate, text: c.text,
      epistemicTag: c.epistemicTag, corroboration: c.corroboration, confidenceLevel: c.confidenceLevel,
      confidenceScore: c.confidenceScore, verificationStatus: c.verificationStatus, evidenceCount: c._count.evidenceLinks,
    })),
    ['subject', 'predicate', 'object', 'claimDate', 'text', 'epistemicTag', 'corroboration', 'confidenceLevel', 'confidenceScore', 'verificationStatus', 'evidenceCount'],
  );
}

export async function exportAuditLogCsv(projectId: string): Promise<string> {
  const rows = await prisma.auditLog.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, include: { actor: { select: { email: true } } } });
  return toCsv(
    rows.map((a) => ({ createdAt: a.createdAt, action: a.action, actor: a.actor?.email ?? a.actorLabel, targetType: a.targetType, targetId: a.targetId, summary: a.summary })),
    ['createdAt', 'action', 'actor', 'targetType', 'targetId', 'summary'],
  );
}

export interface PackageFile {
  name: string;
  content: Buffer;
  sha256: string;
}

/**
 * Build the full evidence package (§48): every CSV/JSON export, plus the most
 * recent completed report in every format if one exists, bundled with a
 * manifest.json of sha256 checksums.
 */
export async function buildEvidencePackage(projectId: string): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const manifest: Array<{ file: string; sha256: string; bytes: number }> = [];

  const add = (name: string, content: string | Buffer) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    zip.file(name, buf);
    manifest.push({ file: name, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
  };

  const [evidenceJson, sourcesCsv, entitiesCsv, relationshipsCsv, timelineCsv, claimsCsv, auditCsv, project] = await Promise.all([
    exportEvidenceJson(projectId),
    exportSourcesCsv(projectId),
    exportEntitiesCsv(projectId),
    exportRelationshipsCsv(projectId),
    exportTimelineCsv(projectId),
    exportClaimsCsv(projectId),
    exportAuditLogCsv(projectId),
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
  ]);

  add('evidence.json', evidenceJson);
  add('sources.csv', sourcesCsv);
  add('entities.csv', entitiesCsv);
  add('relationships.csv', relationshipsCsv);
  add('timeline.csv', timelineCsv);
  add('claims.csv', claimsCsv);
  add('audit-log.csv', auditCsv);

  const latestReport = await prisma.report.findFirst({ where: { projectId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } });
  if (latestReport?.sectionsJson) {
    const { renderReportPdf, renderReportDocx } = await import('../lib/reportRenderers.js');
    const sections = latestReport.sectionsJson as unknown as Parameters<typeof renderReportPdf>[2];
    const generatedAt = latestReport.completedAt?.toISOString() ?? new Date().toISOString();
    const [pdf, docx] = await Promise.all([
      renderReportPdf(latestReport.title, generatedAt, sections),
      renderReportDocx(latestReport.title, generatedAt, sections),
    ]);
    add('report.pdf', pdf);
    add('report.docx', docx);
  }

  add(
    'manifest.json',
    JSON.stringify(
      {
        project: { id: project.id, name: project.name },
        generatedAt: new Date().toISOString(),
        files: manifest,
        note: 'sha256 checksums computed over the exact bytes in this archive.',
      },
      null,
      2,
    ),
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
