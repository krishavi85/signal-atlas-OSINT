import { randomUUID } from 'node:crypto';
import {
  canonicalizeUrl,
  countIndependentSources,
  deduplicate,
  evidenceContentHash,
  extractEntitiesHeuristic,
  assessSourceQuality,
  type DedupItem,
  type NormalizedResult,
} from '@osint/core';
import { ConnectorUnsupportedError, type Connector } from '@osint/connectors';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { nextEvidenceId } from '../lib/ids.js';
import { getReport, makeConnectorContext, registry } from '../connectors/runtime.js';
import { planQueries } from './QueryPlanner.js';
import { autoResolveProject } from './EntityResolver.js';
import { buildRelationshipsForProject } from './RelationshipBuilder.js';
import { runClaimEngine } from './ClaimEngine.js';
import { buildTimelineForProject } from './TimelineEngine.js';

export interface ResearchProgress {
  phase:
    | 'PLANNING'
    | 'SEARCHING'
    | 'DEDUPLICATING'
    | 'PERSISTING_EVIDENCE'
    | 'EXTRACTING_ENTITIES'
    | 'SOURCE_QUALITY'
    | 'RESOLVING_ENTITIES'
    | 'CORRELATING'
    | 'EXTRACTING_CLAIMS'
    | 'BUILDING_TIMELINE'
    | 'DONE';
  sourcesPlanned: number;
  sourcesCompleted: number;
  resultsDiscovered: number;
  uniqueResults: number;
  evidenceRecords: number;
  entitiesExtracted: number;
  claimsExtracted: number;
  connectorStatuses: Array<{ connectorId: string; status: string; note?: string }>;
}

export type ProgressReporter = (p: ResearchProgress) => Promise<void> | void;

// Per-connector query cap by depth — DEEP genuinely runs more of the planned
// queries per connector (bounded, so cost stays predictable even at DEEP).
const MAX_QUERIES_PER_CONNECTOR_BY_DEPTH: Record<string, number> = { QUICK: 1, STANDARD: 4, DEEP: 8 };
const HITS_PER_QUERY = 15;

export async function runResearchRun(
  searchId: string,
  report: ProgressReporter,
  signal?: AbortSignal,
): Promise<ResearchProgress> {
  const search = await prisma.search.findUniqueOrThrow({
    where: { id: searchId },
    include: { project: true },
  });

  const progress: ResearchProgress = {
    phase: 'PLANNING',
    sourcesPlanned: 0,
    sourcesCompleted: 0,
    resultsDiscovered: 0,
    uniqueResults: 0,
    evidenceRecords: 0,
    entitiesExtracted: 0,
    claimsExtracted: 0,
    connectorStatuses: [],
  };
  const tick = async () => report({ ...progress });

  await prisma.search.update({ where: { id: searchId }, data: { status: 'RUNNING' } });

  // Seed the search subject as a known entity so claims can be anchored to it
  // even when the heuristic extractors would not pick the bare name out of prose
  // (§6, §7). The user told us the subject — that is a high-precision signal.
  await seedSubjectEntity(search.projectId, search.originalQuery, search.subjectType);

  // ── 1. plan ────────────────────────────────────────────────────────────────
  const { queries, parsedWarnings } = planQueries({
    originalQuery: search.originalQuery,
    subjectType: search.subjectType,
    depth: (search.depth as 'QUICK' | 'STANDARD' | 'DEEP') ?? 'STANDARD',
  });
  const queryRows = await Promise.all(
    queries.map((q) =>
      prisma.query.create({
        data: {
          searchId,
          text: q.query,
          kind: q.kind,
          rationale: q.rationale,
          generatedBy: q.generatedBy,
        },
      }),
    ),
  );
  if (parsedWarnings.length) logger.warn({ searchId, parsedWarnings }, 'boolean query warnings');

  // ── 2. select connectors ───────────────────────────────────────────────────
  const requested = Array.isArray(search.requestedConnectors)
    ? (search.requestedConnectors as string[])
    : null;
  const dbConnectors = await prisma.connector.findMany();
  const enabledMap = new Map(dbConnectors.map((c) => [c.id, c.enabled]));

  const candidates: Array<{ connector: Connector; skipReason: string | null }> = [];
  for (const connector of registry.all()) {
    if (requested && !requested.includes(connector.id)) continue;
    if (enabledMap.get(connector.id) === false) {
      candidates.push({ connector, skipReason: 'Connector disabled by administrator' });
      continue;
    }
    const ctx = await makeConnectorContext(connector.id, { signal });
    const rep = getReport(connector, ctx);
    if (rep.effective.SEARCH_SUPPORTED !== true) {
      const gap = rep.gaps.find((g) => g.capability === 'ALL' || g.capability === 'SEARCH_SUPPORTED');
      candidates.push({
        connector,
        skipReason: gap?.message ?? 'Connector does not support search in its current configuration',
      });
      continue;
    }
    candidates.push({ connector, skipReason: null });
  }

  progress.sourcesPlanned = candidates.length;
  progress.phase = 'SEARCHING';
  progress.connectorStatuses = candidates.map((c) => ({
    connectorId: c.connector.id,
    status: c.skipReason ? 'SKIPPED' : 'QUEUED',
    note: c.skipReason ?? undefined,
  }));
  await tick();

  // ── 3. search / collect / normalize ────────────────────────────────────────
  const collected: Array<{ tempId: string; connectorId: string; result: NormalizedResult }> = [];

  for (const { connector, skipReason } of candidates) {
    const statusEntry = progress.connectorStatuses.find((s) => s.connectorId === connector.id)!;
    if (skipReason) {
      await prisma.searchRun.create({
        data: { searchId, connectorId: connector.id, status: 'SKIPPED', skippedReason: truncate(skipReason, 500) },
      });
      progress.sourcesCompleted += 1;
      await tick();
      continue;
    }

    if (signal?.aborted) break;
    const ctx = await makeConnectorContext(connector.id, { signal });
    const rep = getReport(connector, ctx);
    const supportsDate = rep.effective.DATE_FILTER_SUPPORTED === true;
    const supportsLang = rep.effective.LANGUAGE_FILTER_SUPPORTED === true;
    statusEntry.status = 'RUNNING';
    await tick();

    let connectorHits = 0;
    let connectorEvidence = 0;
    const chosenQueries = queryRows.slice(0, MAX_QUERIES_PER_CONNECTOR_BY_DEPTH[search.depth] ?? 4);

    for (const q of chosenQueries) {
      if (signal?.aborted) break;
      const run = await prisma.searchRun.create({
        data: { searchId, queryId: q.id, connectorId: connector.id, status: 'RUNNING', startedAt: new Date() },
      });
      try {
        const outcome = await connector.search(
          {
            query: q.text,
            limit: HITS_PER_QUERY,
            dateAfter: supportsDate ? search.dateAfter?.toISOString() ?? null : null,
            dateBefore: supportsDate ? search.dateBefore?.toISOString() ?? null : null,
            language: supportsLang ? search.languages.split(',')[0] ?? null : null,
            scope: buildScope(connector.id, search.project),
          },
          ctx,
        );
        await prisma.query.update({ where: { id: q.id }, data: { executed: true } });

        let normalizedCount = 0;
        for (const hit of outcome.hits) {
          try {
            const parsed = await connector.parse(hit, ctx);
            const normalized = await connector.normalize(parsed, { discoveryQuery: q.text }, ctx);
            collected.push({ tempId: randomUUID(), connectorId: connector.id, result: normalized });
            normalizedCount += 1;
          } catch (err) {
            logger.warn({ err, connector: connector.id, hit: hit.externalId }, 'normalize failed for hit');
          }
        }
        connectorHits += outcome.hits.length;
        progress.resultsDiscovered += outcome.hits.length;
        await prisma.searchRun.update({
          where: { id: run.id },
          data: {
            status: 'COMPLETED',
            rawHitCount: outcome.hits.length,
            uniqueCount: normalizedCount,
            notices: outcome.notices.length ? (outcome.notices as object) : undefined,
            finishedAt: new Date(),
          },
        });
        await tick();
      } catch (err) {
        const unsupported = err instanceof ConnectorUnsupportedError;
        await prisma.searchRun.update({
          where: { id: run.id },
          data: {
            status: unsupported ? 'SKIPPED' : 'FAILED',
            skippedReason: unsupported ? err.message : undefined,
            error: unsupported ? undefined : truncate(err instanceof Error ? err.message : String(err), 1000),
            finishedAt: new Date(),
          },
        });
        logger.warn({ err, connector: connector.id, query: q.text }, 'connector search failed');
      }
    }

    statusEntry.status = 'COMPLETED';
    statusEntry.note = `${connectorHits} hits`;
    progress.sourcesCompleted += 1;
    connectorEvidence; // reserved
    await tick();
  }

  // ── 4. deduplicate ─────────────────────────────────────────────────────────
  progress.phase = 'DEDUPLICATING';
  await tick();
  const dedupItems: DedupItem[] = collected.map((c) => ({ id: c.tempId, result: c.result }));
  const decisions = deduplicate(dedupItems);
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const resultsById = new Map(collected.map((c) => [c.tempId, c.result]));
  progress.uniqueResults = decisions.filter((d) => !d.isDuplicate).length;
  await tick();

  // ── 5. persist evidence ────────────────────────────────────────────────────
  progress.phase = 'PERSISTING_EVIDENCE';
  await tick();

  const tempToEvidenceId = new Map<string, string>();
  const persistedEvidence: Array<{ id: string; result: NormalizedResult; isDuplicate: boolean }> = [];

  // Order so representatives are inserted before their duplicates.
  const ordered = [...collected].sort((a, b) => {
    const da = decisionById.get(a.tempId)!;
    const db = decisionById.get(b.tempId)!;
    return Number(da.isDuplicate) - Number(db.isDuplicate);
  });

  for (const item of ordered) {
    const decision = decisionById.get(item.tempId)!;
    const r = item.result;
    const canon = r.url ? canonicalizeUrl(r.url) : null;

    // upsert source
    let sourceId: string | null = null;
    if (canon?.registrableDomain) {
      const src = await prisma.source.upsert({
        where: { kind_label: { kind: 'DOMAIN', label: canon.registrableDomain } },
        create: {
          kind: 'DOMAIN',
          label: canon.registrableDomain,
          registrableDomain: canon.registrableDomain,
          platform: r.sourcePlatform,
          url: `${new URL(r.url!).protocol}//${canon.host}`,
        },
        update: { lastSeenAt: new Date() },
      });
      sourceId = src.id;
    } else {
      const src = await prisma.source.upsert({
        where: { kind_label: { kind: 'PLATFORM', label: r.sourcePlatform } },
        create: { kind: 'PLATFORM', label: r.sourcePlatform, platform: r.sourcePlatform },
        update: { lastSeenAt: new Date() },
      });
      sourceId = src.id;
    }

    const { id: evidenceId, year, seq } = await nextEvidenceId();
    const duplicateOfId = decision.duplicateOf ? tempToEvidenceId.get(decision.duplicateOf) ?? null : null;

    await prisma.evidence.create({
      data: {
        id: evidenceId,
        year,
        seq,
        projectId: search.projectId,
        sourceId,
        connectorId: item.connectorId,
        searchId,
        discoveryQuery: r.discoveryQuery,
        sourcePlatform: r.sourcePlatform,
        url: r.url,
        canonicalUrl: r.canonicalUrl ?? canon?.canonical ?? null,
        title: r.title,
        author: r.author,
        publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
        retrievedAt: new Date(r.retrievedAt),
        excerpt: r.excerpt,
        fullText: r.fullText,
        language: r.language,
        rawMetadata: r.rawMetadata as object,
        mediaJson: r.media.length ? (r.media as object) : undefined,
        contentHash: decision.contentHash || evidenceContentHash(r),
        simhash: decision.simhash,
        isDuplicate: decision.isDuplicate,
        duplicateOfId,
        duplicateReason: decision.reason,
        clusterId: decision.clusterId,
        analysisStatus: 'NORMALIZED',
      },
    });
    tempToEvidenceId.set(item.tempId, evidenceId);
    persistedEvidence.push({ id: evidenceId, result: r, isDuplicate: decision.isDuplicate });
    progress.evidenceRecords += 1;
    if (progress.evidenceRecords % 10 === 0) await tick();
  }

  const dupCount = persistedEvidence.filter((e) => e.isDuplicate).length;
  await audit({
    projectId: search.projectId,
    actorLabel: `JOB:search:${searchId}`,
    action: 'EVIDENCE_ADDED',
    targetType: 'search',
    targetId: searchId,
    summary: `Persisted ${persistedEvidence.length} evidence records (${dupCount} marked duplicate/syndicated)`,
  });

  // ── 6. entity extraction (deterministic) ───────────────────────────────────
  progress.phase = 'EXTRACTING_ENTITIES';
  await tick();

  for (const ev of persistedEvidence) {
    if (ev.isDuplicate) continue;
    const text = [ev.result.title, ev.result.excerpt, ev.result.fullText].filter(Boolean).join('\n\n');
    if (!text) continue;
    progress.entitiesExtracted += await extractEntitiesForEvidence(
      search.projectId,
      ev.id,
      text,
      ev.result.url ?? null,
    );
  }

  // ── 7. source-quality assessment (§12) ─────────────────────────────────────
  progress.phase = 'SOURCE_QUALITY';
  await tick();
  await assessSourcesForSearch(search.projectId);

  // ── 8. intelligence layer (§7, §8, §10, §11, §15, §45) ─────────────────────
  progress.phase = 'RESOLVING_ENTITIES';
  await tick();
  try {
    await autoResolveProject(search.projectId);
  } catch (err) {
    logger.warn({ err, searchId }, 'auto entity resolution failed (non-fatal)');
  }

  progress.phase = 'CORRELATING';
  await tick();
  try {
    await buildRelationshipsForProject(search.projectId);
  } catch (err) {
    logger.warn({ err, searchId }, 'relationship builder failed (non-fatal)');
  }

  progress.phase = 'EXTRACTING_CLAIMS';
  await tick();
  try {
    const claimResult = await runClaimEngine(search.projectId);
    progress.claimsExtracted = claimResult.claimsExtracted;
    await tick();
  } catch (err) {
    logger.warn({ err, searchId }, 'claim engine failed (non-fatal)');
  }

  progress.phase = 'BUILDING_TIMELINE';
  await tick();
  try {
    await buildTimelineForProject(search.projectId);
  } catch (err) {
    logger.warn({ err, searchId }, 'timeline engine failed (non-fatal)');
  }

  // ── 9. finalize ────────────────────────────────────────────────────────────
  const anyFailed = await prisma.searchRun.count({ where: { searchId, status: 'FAILED' } });
  const anyCompleted = await prisma.searchRun.count({ where: { searchId, status: 'COMPLETED' } });
  const finalStatus = anyCompleted === 0 ? 'FAILED' : anyFailed > 0 ? 'PARTIAL' : 'COMPLETED';

  await prisma.search.update({
    where: { id: searchId },
    data: { status: finalStatus, completedAt: new Date() },
  });

  const independentSources = countIndependentSources(
    decisions,
    new Map([...resultsById.entries()]),
  );

  await audit({
    projectId: search.projectId,
    actorLabel: `JOB:search:${searchId}`,
    action: 'SEARCH_EXECUTED',
    targetType: 'search',
    targetId: searchId,
    summary: `Search "${search.originalQuery}" → ${finalStatus}. ${progress.resultsDiscovered} hits, ${progress.uniqueResults} unique, ${progress.evidenceRecords} evidence, ${progress.entitiesExtracted} entity links, ~${independentSources} independent sources.`,
    metadata: {
      queries: queryRows.map((q) => q.text),
      connectorsPlanned: progress.sourcesPlanned,
      connectorsCompleted: progress.sourcesCompleted,
    },
  });

  progress.phase = 'DONE';
  await tick();
  return progress;
}

/**
 * Translate a project's per-connector scope config (§4, §17) into the
 * `scope` map a connector's search() understands. Nothing is invented — a
 * connector that needs scope it wasn't given (e.g. RSS with no feeds) returns
 * an empty result set with an explanatory notice.
 */
function buildScope(
  connectorId: string,
  project: { connectorScopesJson?: unknown },
): Record<string, string> | undefined {
  const scopes = (project.connectorScopesJson ?? {}) as Record<string, Record<string, unknown>>;
  const cfg = scopes[connectorId];
  if (connectorId === 'rss') {
    const feeds = Array.isArray(cfg?.feeds) ? (cfg!.feeds as string[]) : [];
    return { feeds: feeds.join(',') };
  }
  if (connectorId === 'reddit') {
    const subs = Array.isArray(cfg?.subreddits) ? (cfg!.subreddits as string[]) : [];
    return subs.length ? { subreddit: subs.join('+') } : undefined;
  }
  if (connectorId === 'github' && typeof cfg?.type === 'string') return { type: cfg.type as string };
  if (connectorId === 'youtube' && typeof cfg?.type === 'string') return { type: cfg.type as string };
  if (connectorId === 'hackernews' && typeof cfg?.tags === 'string') return { tags: cfg.tags as string };
  if (connectorId === 'facebook-graph' && Array.isArray(cfg?.pageIds) && cfg!.pageIds.length) {
    return { pageId: String((cfg!.pageIds as string[])[0]) };
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Filter out DOMAIN/URL/SOCIAL_ACCOUNT "entities" that are really infrastructure
 * noise — the connector's own host, well-known platforms, CDNs, link shorteners —
 * so the graph and claim engine focus on investigative subjects.
 */
const PLATFORM_HOSTS = new Set([
  'wikipedia.org', 'wikimedia.org', 'wikidata.org', 'ycombinator.com', 'news.ycombinator.com',
  'github.com', 'githubusercontent.com', 'reddit.com', 'redd.it', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 't.co', 'facebook.com', 'fb.com', 'instagram.com', 'archive.org',
  'web.archive.org', 'doi.org', 'google.com', 'goo.gl', 'bit.ly', 'medium.com', 'substack.com',
  'statcounter.com', 'gs.statcounter.com', 'creativecommons.org', 'gnu.org', 'w3.org',
]);
const SUBJECT_TYPE_MAP: Record<string, string> = {
  PERSON: 'PERSON',
  ORGANIZATION: 'ORGANIZATION',
  COMPANY: 'COMPANY',
  BRAND: 'BRAND',
  PRODUCT: 'PRODUCT',
  DOMAIN: 'DOMAIN',
  USERNAME: 'USERNAME',
};

/** Create/keep an Entity for the search subject (skips Boolean/complex queries). */
export async function seedSubjectEntity(
  projectId: string,
  originalQuery: string,
  subjectType: string | null,
): Promise<void> {
  const q = originalQuery.trim().replace(/^["']|["']$/g, '');
  if (!q || q.length > 80) return;
  if (/\b(AND|OR|NOT)\b|["()]|site:|-\w+\.\w/.test(q)) return; // not a plain name
  const type = subjectType ? SUBJECT_TYPE_MAP[subjectType.toUpperCase()] ?? null : null;
  if (!type) return; // only seed when the user specified a subject type
  await prisma.entity.upsert({
    where: { projectId_type_canonicalValue: { projectId, type, canonicalValue: q.toLowerCase() } },
    create: {
      projectId,
      type,
      canonicalValue: q.toLowerCase(),
      displayName: q,
      resolutionConfidence: 'MEDIUM',
      aliases: { create: { value: q, kind: 'NAME', source: 'USER' } },
    },
    update: { resolutionConfidence: 'MEDIUM' },
  });
}

/**
 * Deterministic entity extraction for a single evidence record (shared by the
 * search pipeline and the document-ingest pipeline). Returns the number of
 * evidence↔entity links created.
 */
export async function extractEntitiesForEvidence(
  projectId: string,
  evidenceId: string,
  text: string,
  selfUrl: string | null,
): Promise<number> {
  const selfDomain = selfUrl ? canonicalizeUrl(selfUrl)?.registrableDomain ?? null : null;
  const entities = extractEntitiesHeuristic(text)
    .filter((e) => !isNoiseEntity(e.type, e.canonicalValue, selfDomain))
    .slice(0, 60);
  let links = 0;
  for (const e of entities) {
    const entity = await prisma.entity.upsert({
      where: {
        projectId_type_canonicalValue: { projectId, type: e.type, canonicalValue: e.canonicalValue.toLowerCase() },
      },
      create: { projectId, type: e.type, canonicalValue: e.canonicalValue.toLowerCase(), displayName: e.canonicalValue },
      update: { updatedAt: new Date() },
    });
    const created = await prisma.evidenceEntity
      .create({
        data: {
          evidenceId,
          entityId: entity.id,
          originalText: e.originalText.slice(0, 500),
          contextText: e.context.slice(0, 1000),
          offsetStart: e.offset,
          confidence: e.confidence,
          method: e.method,
          origin: 'DETERMINISTIC_EXTRACTION',
        },
      })
      .then(() => true)
      .catch(() => false);
    if (created) links++;
  }
  await prisma.evidence.update({ where: { id: evidenceId }, data: { analysisStatus: 'ENTITIES_EXTRACTED' } });
  return links;
}

function isNoiseEntity(type: string, value: string, selfDomain: string | null): boolean {
  if (type === 'DOMAIN' || type === 'URL') {
    const host = value.replace(/^https?:\/\//, '').split('/')[0]?.toLowerCase() ?? value;
    const reg = host.split('.').slice(-2).join('.');
    if (selfDomain && (host === selfDomain || reg === selfDomain)) return true;
    if (PLATFORM_HOSTS.has(host) || PLATFORM_HOSTS.has(reg)) return true;
  }
  return false;
}

/** Recompute source tiers/scores from accumulated evidence for a project (§12). */
export async function assessSourcesForSearch(projectId: string): Promise<void> {
  const sources = await prisma.source.findMany({
    where: { evidence: { some: { projectId } } },
    include: { _count: { select: { evidence: true } }, evidence: { where: { projectId }, take: 50 } },
  });
  for (const src of sources) {
    const domain = src.registrableDomain ?? '';
    const isGov = /\.gov(\.[a-z]{2})?$/.test(domain) || /\.gouv\./.test(domain) || domain.endsWith('.gov');
    const isEdu = /\.edu(\.[a-z]{2})?$/.test(domain) || domain.endsWith('.ac.uk');
    const hasDates = src.evidence.some((e) => e.publishedAt !== null);
    const hasAuthors = src.evidence.some((e) => (e.author ?? '').length > 0);
    const distinctClusters = new Set(src.evidence.map((e) => e.clusterId).filter(Boolean)).size;

    const q = assessSourceQuality({
      isGovernmentDomain: isGov,
      isEducationDomain: isEdu,
      isSocialUserPost: ['reddit', 'youtube', 'instagram', 'facebook', 'hackernews'].includes(src.platform ?? ''),
      hasNamedAuthor: hasAuthors,
      hasPublicationDate: hasDates,
      independentCorroborationCount: Math.max(0, distinctClusters - 1),
    });
    await prisma.source.update({
      where: { id: src.id },
      data: { tier: q.tier, qualityScore: q.score, qualityReasons: q.reasons as object },
    });
  }
}
