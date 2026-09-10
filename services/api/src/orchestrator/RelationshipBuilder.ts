import { canonicalizeUrl } from '@osint/core';
import { prisma } from '../db.js';
import { audit } from '../modules/audit.js';

/**
 * RelationshipBuilder (§8).
 *
 * Produces ONLY evidence-traceable edges. Deliberately conservative:
 *  - co-occurrence in one evidence item => MENTIONED_WITH (an explicit
 *    "appeared together" edge, NOT a personal-relationship claim — §8)
 *  - evidence author matching a SOCIAL_ACCOUNT/PERSON entity => POSTED_BY
 *  - a DOMAIN entity equal to the evidence's source domain, co-occurring with an
 *    ORG/COMPANY/BRAND => SHARES_DOMAIN (weak)
 *
 * Every edge stores the evidence ids that justify it and a LOW/MEDIUM
 * confidence. Edges are upserted; evidence ids accumulate across runs.
 */

const MAX_PAIRS_PER_EVIDENCE = 25;
const MEANINGFUL_TYPES = new Set([
  'PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'SOCIAL_ACCOUNT', 'DOMAIN', 'LOCATION', 'EVENT',
]);

interface EdgeAccu {
  fromId: string;
  toId: string;
  type: string;
  directed: boolean;
  evidenceIds: Set<string>;
  weight: number;
}

export async function buildRelationshipsForProject(projectId: string): Promise<number> {
  const evidence = await prisma.evidence.findMany({
    where: { projectId, isDuplicate: false },
    select: {
      id: true,
      author: true,
      url: true,
      entities: {
        select: { entityId: true, entity: { select: { id: true, type: true, canonicalValue: true, mergedIntoId: true } } },
      },
    },
  });

  const edges = new Map<string, EdgeAccu>();
  const key = (a: string, b: string, t: string) => `${a}|${b}|${t}`;
  const add = (fromId: string, toId: string, type: string, directed: boolean, evId: string, weight: number) => {
    if (fromId === toId) return;
    // canonical ordering for undirected edges to avoid duplicates
    let a = fromId;
    let b = toId;
    if (!directed && a > b) [a, b] = [b, a];
    const k = key(a, b, type);
    const e = edges.get(k) ?? { fromId: a, toId: b, type, directed, evidenceIds: new Set(), weight: 0 };
    e.evidenceIds.add(evId);
    e.weight += weight;
    edges.set(k, e);
  };

  for (const ev of evidence) {
    const ents = ev.entities
      .map((x) => x.entity)
      .filter((e) => e.mergedIntoId === null && MEANINGFUL_TYPES.has(e.type));
    const resolvedId = (id: string) => id; // mergedIntoId already filtered

    // co-mention edges
    let pairs = 0;
    for (let i = 0; i < ents.length && pairs < MAX_PAIRS_PER_EVIDENCE; i++) {
      for (let j = i + 1; j < ents.length && pairs < MAX_PAIRS_PER_EVIDENCE; j++) {
        add(resolvedId(ents[i]!.id), resolvedId(ents[j]!.id), 'MENTIONED_WITH', false, ev.id, 1);
        pairs++;
      }
    }

    // author -> account/person
    if (ev.author) {
      const authorNorm = ev.author.toLowerCase().replace(/^(u\/|@)/, '').trim();
      const authorEntity = ents.find(
        (e) =>
          (e.type === 'SOCIAL_ACCOUNT' || e.type === 'PERSON') &&
          e.canonicalValue.toLowerCase().replace(/^@/, '') === authorNorm,
      );
      if (authorEntity) {
        for (const other of ents) {
          if (other.id !== authorEntity.id && (other.type === 'COMPANY' || other.type === 'ORGANIZATION' || other.type === 'BRAND' || other.type === 'PRODUCT')) {
            add(authorEntity.id, other.id, 'POSTED_BY', true, ev.id, 1);
          }
        }
      }
    }

    // domain co-occurrence
    const domain = ev.url ? canonicalizeUrl(ev.url)?.registrableDomain : null;
    if (domain) {
      const domainEntity = ents.find((e) => e.type === 'DOMAIN' && e.canonicalValue.toLowerCase() === domain);
      if (domainEntity) {
        for (const org of ents) {
          if (['COMPANY', 'ORGANIZATION', 'BRAND'].includes(org.type)) {
            add(org.id, domainEntity.id, 'SHARES_DOMAIN', true, ev.id, 1);
          }
        }
      }
    }
  }

  let written = 0;
  for (const e of edges.values()) {
    // require >=2 supporting evidence for co-mention to reduce noise
    if (e.type === 'MENTIONED_WITH' && e.evidenceIds.size < 2 && e.weight < 2) continue;
    const evidenceIds = [...e.evidenceIds];
    const confidence = e.type === 'MENTIONED_WITH' ? (evidenceIds.length >= 3 ? 'MEDIUM' : 'LOW') : 'LOW';
    await prisma.relationship.upsert({
      where: { projectId_fromId_toId_type: { projectId, fromId: e.fromId, toId: e.toId, type: e.type } },
      create: {
        projectId,
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        directed: e.directed,
        evidenceIds,
        confidence,
        createdBy: 'SYSTEM',
      },
      update: { evidenceIds, confidence },
    });
    written++;
  }

  await audit({
    projectId,
    actorLabel: 'SYSTEM',
    action: 'RELATIONSHIP_ADDED',
    targetType: 'project',
    targetId: projectId,
    summary: `Relationship builder: ${written} evidence-traceable edges (co-mention / posted-by / shares-domain)`,
  });
  return written;
}
