'use client';

import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner, Stat } from '@/components/ui';

interface OverviewData {
  counts: { evidence: number; duplicatesSuppressed: number; entities: number; timelineEvents: number; openContradictions: number };
  entityByType: Array<{ type: string; count: number }>;
  claimsByCorroboration: Array<{ corroboration: string; count: number }>;
  latestSearch: { id: string; originalQuery: string; status: string; _count: { evidence: number } } | null;
  topSources: Array<{ label: string; tier: string | null; qualityScore: number | null; platform: string | null; _count: { evidence: number } }>;
}

export function Overview({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useApi<OverviewData>(`/projects/${projectId}/overview`);
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Evidence" value={data.counts.evidence} />
        <Stat label="Duplicates suppressed" value={data.counts.duplicatesSuppressed} />
        <Stat label="Entities" value={data.counts.entities} />
        <Stat label="Timeline events" value={data.counts.timelineEvents} />
        <Stat label="Open contradictions" value={data.counts.openContradictions} tone={data.counts.openContradictions ? 'text-red-400' : undefined} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Entities by type</h3>
          {data.entityByType.length === 0 ? (
            <EmptyState title="No entities extracted yet" />
          ) : (
            <ul className="space-y-1 text-sm">
              {data.entityByType
                .sort((a, b) => b.count - a.count)
                .map((e) => (
                  <li key={e.type} className="flex justify-between">
                    <span className="text-slate-400">{e.type}</span>
                    <span className="font-mono text-slate-300">{e.count}</span>
                  </li>
                ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Claims by corroboration</h3>
          {data.claimsByCorroboration.length === 0 ? (
            <EmptyState title="No claims extracted yet" hint="Claims come from sources with descriptive prose (Wikipedia, news, uploaded documents)." />
          ) : (
            <ul className="space-y-1 text-sm">
              {data.claimsByCorroboration.map((c) => (
                <li key={c.corroboration} className="flex justify-between">
                  <span className="text-slate-400">{c.corroboration}</span>
                  <span className="font-mono text-slate-300">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Top sources by quality</h3>
        {data.topSources.length === 0 ? (
          <EmptyState title="No sources yet" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase text-slate-600">
              <tr>
                <th className="py-1">Source</th>
                <th>Tier</th>
                <th className="text-right">Quality</th>
                <th className="text-right">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {data.topSources.map((s) => (
                <tr key={s.label} className="border-t border-ink-800">
                  <td className="py-1.5 text-slate-300">{s.label}</td>
                  <td>{s.tier ? <Badge>{s.tier}</Badge> : <span className="text-slate-600">—</span>}</td>
                  <td className="text-right font-mono text-slate-400">{s.qualityScore != null ? s.qualityScore.toFixed(2) : '—'}</td>
                  <td className="text-right font-mono text-slate-400">{s._count.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
