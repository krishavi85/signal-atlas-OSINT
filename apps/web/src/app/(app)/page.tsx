'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, PageHeader, Spinner, Stat, healthTone } from '@/components/ui';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBell,
  IconClock,
  IconDatabase,
  IconFolder,
  IconPlug,
  IconRadar,
  IconSearch,
  IconShield,
  IconZap,
} from '@/components/icons';

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

  if (loading) return <Spinner size="md" label="Loading dashboard…" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  const onlineSources = data.sourceHealth.filter((s) => s.health === 'ONLINE').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home"
        description="Active investigations, evidence intake, source health, and monitoring — at a glance."
        actions={
          <>
            <Link href="/search" className="btn-ghost">
              <IconSearch className="h-3.5 w-3.5" /> Universal Search
            </Link>
            <Link href="/god-mode" className="btn-primary">
              <IconZap className="h-3.5 w-3.5" /> God Mode
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Active investigations" value={data.activeProjects} icon={<IconFolder className="h-4 w-4" />} />
        <Stat
          label="Running jobs"
          value={data.runningJobs}
          tone={data.runningJobs ? 'text-accent-bright' : undefined}
          icon={<IconClock className="h-4 w-4" />}
        />
        <Stat
          label="Failed jobs"
          value={data.failedJobs}
          tone={data.failedJobs ? 'text-red-400' : undefined}
          icon={<IconAlertTriangle className="h-4 w-4" />}
        />
        <Stat
          label="Unverified claims"
          value={data.unverifiedClaims}
          tone={data.unverifiedClaims ? 'text-amber-400' : undefined}
          icon={<IconShield className="h-4 w-4" />}
        />
        <Stat
          label="Open contradictions"
          value={data.contradictions}
          tone={data.contradictions ? 'text-red-400' : undefined}
          icon={<IconAlertTriangle className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <div className="panel-header mb-3">
            <IconDatabase className="h-4 w-4 text-slate-500" />
            <h2 className="section-title flex-1">Recent evidence</h2>
          </div>
          {data.recentEvidence.length === 0 ? (
            <EmptyState title="No evidence collected yet" hint="Run a search inside an investigation, or launch God Mode." />
          ) : (
            <ul className="-mx-2 divide-y divide-ink-800/70">
              {data.recentEvidence.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/investigations/${e.projectId}`}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-ink-850/70"
                  >
                    <Badge tone="blue">{e.sourcePlatform}</Badge>
                    <span className="mono-id shrink-0">{e.id}</span>
                    <span className="truncate text-slate-300">{e.title ?? e.url ?? '(untitled)'}</span>
                    <IconArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-700" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <div className="panel-header mb-3">
            <IconPlug className="h-4 w-4 text-slate-500" />
            <h2 className="section-title flex-1">Source health</h2>
            <span className="text-[11px] text-slate-600">
              {onlineSources}/{data.sourceHealth.length} online
            </span>
          </div>
          <ul className="-mx-2">
            {data.sourceHealth.map((s) => (
              <li key={s.connectorId} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm">
                <span className="truncate text-slate-300">{s.displayName}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {s.gaps.length > 0 && (
                    <span className="hidden text-[11px] text-slate-600 sm:inline" title={s.gaps.join(' ')}>
                      needs config
                    </span>
                  )}
                  <Badge dot tone={healthTone(s.health)}>
                    {s.health}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
          <Link href="/connectors" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-bright">
            Manage connectors <IconArrowRight className="h-3 w-3" />
          </Link>
        </section>
      </div>

      <section className="card p-4">
        <div className="panel-header mb-3">
          <IconBell className="h-4 w-4 text-slate-500" />
          <h2 className="section-title flex-1">Monitoring</h2>
        </div>
        {data.monitoring.length === 0 ? (
          <EmptyState
            icon={<IconRadar className="h-5 w-5" />}
            title="No monitoring jobs"
            hint="Create one from an investigation's Monitoring tab to watch for new public mentions on a schedule."
          />
        ) : (
          <ul className="-mx-2 divide-y divide-ink-800/70">
            {data.monitoring.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 px-2 py-2 text-sm">
                <Link href={`/investigations/${m.projectId}`} className="truncate text-slate-300 hover:text-slate-100">
                  {m.name}
                </Link>
                <Badge dot tone={m.enabled ? 'green' : 'neutral'}>{m.enabled ? 'enabled' : 'paused'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
