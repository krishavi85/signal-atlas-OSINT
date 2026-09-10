'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner, confidenceTone } from '@/components/ui';

interface ClaimRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  text: string;
  claimDate: string | null;
  epistemicTag: string;
  corroboration: string;
  confidenceScore: number;
  confidenceLevel: string;
  verificationStatus: string;
  _count: { evidenceLinks: number; contradictionsA: number; contradictionsB: number };
}

function corrTone(c: string): 'green' | 'amber' | 'red' | 'blue' | 'neutral' {
  if (c === 'INDEPENDENTLY_CORROBORATED') return 'green';
  if (c === 'MULTIPLE_SOURCES') return 'blue';
  if (c === 'CONTRADICTED') return 'red';
  if (c === 'SINGLE_SOURCE' || c === 'UNVERIFIED' || c === 'OUTDATED') return 'amber';
  return 'neutral';
}

export function ClaimsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [corr, setCorr] = useState('');
  const { data, error, loading, reload } = useApi<ClaimRow[]>(
    `/projects/${projectId}/claims?limit=200${corr ? `&corroboration=${corr}` : ''}`,
    [corr],
  );
  const contradictions = useApi<
    Array<{ id: string; explanation: string; status: string; claimA: { text: string }; claimB: { text: string } }>
  >(`/projects/${projectId}/contradictions`);
  const [openWhy, setOpenWhy] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      {contradictions.data && contradictions.data.length > 0 && (
        <section className="card border-red-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-red-300">Contradictions (§45) — resolved by an analyst, never auto-picked</h3>
          <ul className="space-y-2 text-sm">
            {contradictions.data.map((c) => (
              <li key={c.id} className="rounded border border-red-900/60 bg-red-950/20 p-2">
                <p className="text-red-300">{c.explanation}</p>
                <p className="mt-1 text-xs text-slate-400">A: {c.claimA.text}</p>
                <p className="text-xs text-slate-400">B: {c.claimB.text}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Badge tone={c.status === 'OPEN' ? 'amber' : 'neutral'}>{c.status}</Badge>
                  {canEdit && c.status === 'OPEN' && (
                    <>
                      {(['RESOLVED_A', 'RESOLVED_B', 'UNRESOLVABLE', 'DISMISSED'] as const).map((s) => (
                        <button
                          key={s}
                          className="btn-ghost py-0.5 text-[11px]"
                          onClick={async () => {
                            await api(`/contradictions/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: s }) });
                            void contradictions.reload();
                            void reload();
                          }}
                        >
                          {s.replace('RESOLVED_', 'keep ')}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center gap-2">
        <select className="input w-56" value={corr} onChange={(e) => setCorr(e.target.value)}>
          <option value="">All corroboration classes</option>
          {['INDEPENDENTLY_CORROBORATED', 'MULTIPLE_SOURCES', 'SINGLE_SOURCE', 'CONTRADICTED', 'UNVERIFIED', 'OUTDATED'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          Claims are extracted deterministically (entity-anchored patterns, not ML) and scored by the corroboration +
          confidence engines.
        </p>
      </div>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No claims extracted yet" hint="Run a search over sources with descriptive text (e.g. Wikipedia, news)." />
      ) : (
        <ul className="space-y-2">
          {data.map((c) => (
            <li key={c.id} className="card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={c.epistemicTag === 'FACT' ? 'green' : c.epistemicTag === 'CLAIM' ? 'neutral' : 'violet'}>
                  {c.epistemicTag}
                </Badge>
                <span className="font-medium text-slate-100">{c.subject}</span>
                <span className="text-slate-500">{c.predicate.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="text-slate-200">{c.object}</span>
                {c.claimDate && <span className="text-[11px] text-slate-600">({c.claimDate.slice(0, 10)})</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <Badge tone={corrTone(c.corroboration)}>{c.corroboration}</Badge>
                  <Badge tone={confidenceTone(c.confidenceLevel)}>
                    {c.confidenceLevel} {(c.confidenceScore * 100) | 0}%
                  </Badge>
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-600">
                <span>{c._count.evidenceLinks} evidence</span>
                {c._count.contradictionsA + c._count.contradictionsB > 0 && (
                  <span className="text-red-400">{c._count.contradictionsA + c._count.contradictionsB} contradiction(s)</span>
                )}
                <button className="text-accent hover:underline" onClick={() => setOpenWhy(openWhy === c.id ? null : c.id)}>
                  {openWhy === c.id ? 'hide WHY' : 'WHY?'}
                </button>
              </div>
              {openWhy === c.id && <WhyPanel claimId={c.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WhyPanel({ claimId }: { claimId: string }) {
  const { data, loading } = useApi<{
    reasoning: string;
    confidenceFactors: Array<{ key: string; value: number; weight: number; explanation: string }>;
    supportingEvidence: Array<{ evidenceId: string; url: string | null; sourceTier: string | null; excerpt: string | null }>;
  }>(`/claims/${claimId}/why`, [claimId]);
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <div className="mt-2 space-y-2 rounded border border-ink-800 bg-ink-950 p-3 text-xs">
      <p className="text-slate-300">{data.reasoning}</p>
      <div>
        <p className="mb-1 font-semibold text-slate-400">Confidence factors (§44)</p>
        <ul className="space-y-0.5">
          {data.confidenceFactors.map((f, i) => (
            <li key={i} className="flex gap-2">
              <span className={`w-10 font-mono ${f.value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {f.value >= 0 ? '+' : ''}
                {f.value.toFixed(2)}
              </span>
              <span className="text-slate-500">{f.explanation}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 font-semibold text-slate-400">Supporting evidence</p>
        <ul className="space-y-0.5">
          {data.supportingEvidence.map((e, i) => (
            <li key={i} className="truncate">
              <span className="font-mono text-[10px] text-slate-600">{e.evidenceId}</span>{' '}
              {e.sourceTier && <Badge>{e.sourceTier}</Badge>}{' '}
              <span className="text-slate-500">{e.excerpt}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
