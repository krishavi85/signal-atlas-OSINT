'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner, Stat, healthTone } from '@/components/ui';

interface Dashboard {
  activeProjects: number;
  runningJobs: number;
  failedJobs: number;
  unverifiedClaims: number;
  contradictions: number;
  recentEvidence: Array<{ id: string; title: string | null; url: string | null; sourcePlatform: string; projectId: string; createdAt: string }>;
  sourceHealth: Array<{ connectorId: string; displayName: string; available: boolean; health: string; gaps: string[] }>;
  monitoring: Array<{ id: string; name: string; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null; lastError: string | null; projectId: string }>;
}

export default function HomePage() {
  const { data, error, loading, reload } = useApi<Dashboard>('/dashboard');

  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-100">Home</h1>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Active investigations" value={data.activeProjects} />
        <Stat label="Running jobs" value={data.runningJobs} tone="text-accent" />
        <Stat label="Failed jobs" value={data.failedJobs} tone={data.failedJobs ? 'text-red-400' : undefined} />
        <Stat label="Unverified claims" value={data.unverifiedClaims} tone={data.unverifiedClaims ? 'text-amber-400' : undefined} />
        <Stat label="Open contradictions" value={data.contradictions} tone={data.contradictions ? 'text-red-400' : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Recent evidence</h2>
          {data.recentEvidence.length === 0 ? (
            <EmptyState title="No evidence collected yet" hint="Run a search inside an investigation." />
          ) : (
            <ul className="space-y-2 text-sm">
              {data.recentEvidence.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500">{e.id}</span>
                  <Badge tone="blue">{e.sourcePlatform}</Badge>
                  <Link href={`/investigations/${e.projectId}`} className="truncate text-slate-300 hover:text-slate-100">
                    {e.title ?? e.url ?? '(untitled)'}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Source health</h2>
          <ul className="space-y-1.5 text-sm">
            {data.sourceHealth.map((s) => (
              <li key={s.connectorId} className="flex items-center justify-between">
                <span className="text-slate-300">{s.displayName}</span>
                <span className="flex items-center gap-2">
                  {s.gaps.length > 0 && <span className="text-[11px] text-slate-600" title={s.gaps.join(' ')}>needs config</span>}
                  <Badge tone={healthTone(s.health)}>{s.health}</Badge>
                </span>
              </li>
            ))}
          </ul>
          <Link href="/connectors" className="mt-3 inline-block text-xs text-accent hover:underline">
            Manage connectors →
          </Link>
        </section>
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Monitoring</h2>
        {data.monitoring.length === 0 ? (
          <EmptyState
            title="No monitoring jobs"
            hint="Monitoring engine (Phase 7) is scaffolded; scheduled runs are not executing yet."
          />
        ) : (
          <ul className="space-y-1 text-sm">
            {data.monitoring.map((m) => (
              <li key={m.id} className="flex items-center justify-between">
                <span className="text-slate-300">{m.name}</span>
                <Badge tone={m.enabled ? 'green' : 'neutral'}>{m.enabled ? 'enabled' : 'paused'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
