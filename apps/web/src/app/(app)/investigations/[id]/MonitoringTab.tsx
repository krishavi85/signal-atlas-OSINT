'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface MonitoringJob {
  id: string;
  name: string;
  query: string;
  scheduleCron: string;
  languages: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  connectorIds: string[] | null;
  _count: { results: number };
}

const SCHEDULES = ['HOURLY', 'EVERY_6H', 'EVERY_12H', 'DAILY', 'WEEKLY'] as const;

export function MonitoringTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data, error, loading, reload } = useApi<MonitoringJob[]>(`/projects/${projectId}/monitoring`);
  const presets = useApi<{ presets: Array<{ key: string; cron: string; nextRun: string }>; connectors: string[] }>('/monitoring/presets');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [schedule, setSchedule] = useState<(typeof SCHEDULES)[number]>('DAILY');
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/projects/${projectId}/monitoring`, {
        method: 'POST',
        body: JSON.stringify({ name, query, schedule, connectorIds: connectorIds.length ? connectorIds : undefined }),
      });
      setCreating(false);
      setName('');
      setQuery('');
      setConnectorIds([]);
      await reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card p-3 text-xs text-slate-500">
        Monitoring jobs re-run a query on a schedule (§17) and compare results against the evidence already
        collected. Republished/unchanged content is suppressed; a genuinely new page is a <Badge tone="green">new</Badge>{' '}
        finding; the same URL with different content is a <Badge tone="amber">changed</Badge> finding (§16). Nothing
        is alerted twice for the same content.
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Monitoring jobs</h3>
        {canEdit && (
          <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : 'New monitor'}
          </button>
        )}
      </div>

      {creating && (
        <form onSubmit={create} className="card space-y-3 p-4">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Mentions of Acme Robotics" />
          </div>
          <div>
            <label className="label">Query</label>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} required placeholder='"Acme Robotics" OR "Acme Corp"' />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Schedule</label>
              <select className="input" value={schedule} onChange={(e) => setSchedule(e.target.value as typeof schedule)}>
                {SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ').toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Connectors (blank = all available)</label>
              <select
                multiple
                className="input h-24"
                value={connectorIds}
                onChange={(e) => setConnectorIds([...e.target.selectedOptions].map((o) => o.value))}
              >
                {presets.data?.connectors.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create monitor'}
          </button>
        </form>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No monitoring jobs" hint="Create one to watch for new public mentions on a schedule." />
      ) : (
        <ul className="space-y-2">
          {data.map((j) => (
            <li key={j.id} className="card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={j.enabled ? 'green' : 'neutral'}>{j.enabled ? 'enabled' : 'paused'}</Badge>
                <span className="font-medium text-slate-100">{j.name}</span>
                <code className="text-xs text-slate-500">{j.query}</code>
                <span className="ml-auto flex items-center gap-2 text-[11px] text-slate-600">
                  <span title={j.scheduleCron}>{humanCron(j.scheduleCron)}</span>
                  {canEdit && (
                    <>
                      <button
                        className="btn-ghost py-0.5"
                        onClick={async () => {
                          await api(`/monitoring/${j.id}/run`, { method: 'POST' });
                          setTimeout(() => void reload(), 2000);
                        }}
                      >
                        run now
                      </button>
                      <button
                        className="btn-ghost py-0.5"
                        onClick={async () => {
                          await api(`/monitoring/${j.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !j.enabled }) });
                          void reload();
                        }}
                      >
                        {j.enabled ? 'pause' : 'resume'}
                      </button>
                      <button
                        className="text-red-400 hover:underline"
                        onClick={async () => {
                          if (!confirm(`Delete monitor "${j.name}"?`)) return;
                          await api(`/monitoring/${j.id}`, { method: 'DELETE' });
                          void reload();
                        }}
                      >
                        delete
                      </button>
                    </>
                  )}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-slate-600">
                <span>last run: {j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never'}</span>
                <span>next run: {j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—'}</span>
                <span>{j._count.results} run(s) recorded</span>
                {j.lastError && <span className="text-red-400">error: {j.lastError}</span>}
                <button className="text-accent hover:underline" onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
                  {expanded === j.id ? 'hide history' : 'show history'}
                </button>
              </div>
              {expanded === j.id && <ResultHistory jobId={j.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function humanCron(cron: string): string {
  const found = Object.entries({
    '0 * * * *': 'hourly',
    '0 */6 * * *': 'every 6h',
    '0 */12 * * *': 'every 12h',
    '0 8 * * *': 'daily',
    '0 8 * * 1': 'weekly',
  }).find(([k]) => k === cron);
  return found ? found[1] : cron;
}

function ResultHistory({ jobId }: { jobId: string }) {
  const { data, loading } = useApi<
    Array<{ id: string; runAt: string; newEvidenceCount: number; changedCount: number; suppressedDuplicateCount: number; summary: string; error: string | null }>
  >(`/monitoring/${jobId}/results`, [jobId]);
  if (loading) return <Spinner />;
  if (!data || data.length === 0) return <p className="mt-2 text-xs text-slate-600">No runs yet.</p>;
  return (
    <ul className="mt-3 space-y-1.5 border-t border-ink-800 pt-2 text-xs">
      {data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2">
          <span className="text-slate-600">{new Date(r.runAt).toLocaleString()}</span>
          {r.error ? (
            <Badge tone="red">failed</Badge>
          ) : (
            <>
              {r.newEvidenceCount > 0 && <Badge tone="green">{r.newEvidenceCount} new</Badge>}
              {r.changedCount > 0 && <Badge tone="amber">{r.changedCount} changed</Badge>}
              {r.suppressedDuplicateCount > 0 && <Badge>{r.suppressedDuplicateCount} suppressed</Badge>}
            </>
          )}
          <span className="text-slate-500">{r.error ?? r.summary}</span>
        </li>
      ))}
    </ul>
  );
}
