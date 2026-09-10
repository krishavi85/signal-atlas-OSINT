'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamUrl } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface PreviewResult {
  plannedQueries: Array<{ query: string; kind: string; rationale: string; generatedBy?: string }>;
  parsedWarnings: string[];
  coverage: Array<{ connectorId: string; displayName: string; willRun: boolean; status: string; reason: string | null }>;
}

interface SearchRow {
  id: string;
  originalQuery: string;
  status: string;
  depth: string;
  createdAt: string;
  _count: { evidence: number; runs: number; queries: number };
}

interface Progress {
  phase?: string;
  sourcesPlanned?: number;
  sourcesCompleted?: number;
  resultsDiscovered?: number;
  uniqueResults?: number;
  evidenceRecords?: number;
  entitiesExtracted?: number;
  connectorStatuses?: Array<{ connectorId: string; status: string; note?: string }>;
}

const DEPTHS = ['QUICK', 'STANDARD', 'DEEP'] as const;

export function SearchTab({ projectId, canEdit, projectActive }: { projectId: string; canEdit: boolean; projectActive: boolean }) {
  const [query, setQuery] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>('STANDARD');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const history = useApi<SearchRow[]>(`/projects/${projectId}/searches`);

  const runPreview = useCallback(async () => {
    if (!query.trim()) return;
    setPreviewing(true);
    setErr(null);
    try {
      setPreview(
        await api<PreviewResult>(`/projects/${projectId}/search/preview`, {
          method: 'POST',
          body: JSON.stringify({ query, subjectType: subjectType || undefined, depth }),
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [query, subjectType, depth, projectId]);

  useEffect(() => {
    if (!activeSearchId) return;
    const es = new EventSource(streamUrl(projectId));
    esRef.current = es;
    es.addEventListener('job', (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data);
        if (data.progress) setProgress(data.progress);
        if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(data.status)) {
          setRunning(false);
          void history.reload();
        }
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      /* EventSource auto-reconnects; poll fallback below */
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSearchId, projectId]);

  // polling fallback for progress / completion
  useEffect(() => {
    if (!activeSearchId || !running) return;
    const t = setInterval(async () => {
      try {
        const s = await api<{ status: string; job: { progressJson: Progress } | null }>(`/searches/${activeSearchId}`);
        if (s.job?.progressJson) setProgress(s.job.progressJson);
        if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(s.status)) {
          setRunning(false);
          void history.reload();
        }
      } catch {
        /* ignore */
      }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSearchId, running]);

  async function run() {
    setRunning(true);
    setErr(null);
    setProgress(null);
    try {
      const res = await api<{ searchId: string }>(`/projects/${projectId}/search`, {
        method: 'POST',
        body: JSON.stringify({ query, subjectType: subjectType || undefined, depth }),
      });
      setActiveSearchId(res.searchId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start search');
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      {!canEdit && <p className="text-xs text-amber-400">You have viewer access — running searches requires EDITOR.</p>}
      {!projectActive && <p className="text-xs text-amber-400">Investigation is paused. Resume it to run searches.</p>}

      <div className="card space-y-3 p-4">
        <div>
          <label className="label">Query (supports AND / OR / NOT / &quot;phrase&quot; / site: / -domain / after:YYYY-MM-DD)</label>
          <input
            className="input"
            placeholder='e.g.  "Acme Robotics" AND (funding OR acquisition) after:2025-01-01'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="label">Subject type</label>
            <select className="input w-44" value={subjectType} onChange={(e) => setSubjectType(e.target.value)}>
              <option value="">Auto</option>
              {['PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'DOMAIN', 'USERNAME', 'TOPIC'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Depth</label>
            <select className="input w-32" value={depth} onChange={(e) => setDepth(e.target.value as (typeof DEPTHS)[number])}>
              {DEPTHS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button className="btn-ghost" onClick={runPreview} disabled={previewing || !query.trim()}>
              {previewing ? 'Planning…' : 'Preview plan'}
            </button>
            <button className="btn-primary" onClick={run} disabled={!canEdit || !projectActive || running || !query.trim()}>
              {running ? 'Running…' : 'Run search'}
            </button>
          </div>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>

      {preview && !running && (
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-200">Planned queries</h3>
          {preview.parsedWarnings.length > 0 && (
            <p className="text-xs text-amber-400">{preview.parsedWarnings.join(' · ')}</p>
          )}
          <ul className="space-y-1 text-sm">
            {preview.plannedQueries.map((q, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <Badge tone={q.kind === 'ORIGINAL' ? 'blue' : 'neutral'}>{q.kind}</Badge>
                <code className="text-slate-200">{q.query}</code>
                <span className="text-[11px] text-slate-600">— {q.rationale}</span>
              </li>
            ))}
          </ul>
          <h3 className="pt-2 text-sm font-semibold text-slate-200">Source coverage (§46)</h3>
          <ul className="grid gap-1 text-sm md:grid-cols-2">
            {preview.coverage.map((c) => (
              <li key={c.connectorId} className="flex items-center gap-2">
                <Badge tone={c.willRun ? 'green' : 'neutral'}>{c.willRun ? 'WILL RUN' : c.status}</Badge>
                <span className="text-slate-300">{c.displayName}</span>
                {c.reason && <span className="truncate text-[11px] text-slate-600" title={c.reason}>{c.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {running && (
        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2">
            <Spinner label={`Phase: ${progress?.phase ?? 'starting'}`} />
            {activeSearchId && (
              <button
                className="btn-ghost ml-auto py-1"
                onClick={() => {
                  void api(`/searches/${activeSearchId}/cancel`, { method: 'POST' });
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm md:grid-cols-6">
            <ProgressStat label="Sources" value={`${progress?.sourcesCompleted ?? 0}/${progress?.sourcesPlanned ?? 0}`} />
            <ProgressStat label="Hits" value={progress?.resultsDiscovered ?? 0} />
            <ProgressStat label="Unique" value={progress?.uniqueResults ?? 0} />
            <ProgressStat label="Evidence" value={progress?.evidenceRecords ?? 0} />
            <ProgressStat label="Entities" value={progress?.entitiesExtracted ?? 0} />
          </div>
          {progress?.connectorStatuses && (
            <ul className="space-y-0.5 text-xs">
              {progress.connectorStatuses.map((c) => (
                <li key={c.connectorId} className="flex items-center gap-2">
                  <Badge tone={c.status === 'COMPLETED' ? 'green' : c.status === 'SKIPPED' ? 'amber' : 'neutral'}>{c.status}</Badge>
                  <span className="text-slate-400">{c.connectorId}</span>
                  {c.note && <span className="truncate text-slate-600">{c.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SearchHistory data={history.data} loading={history.loading} error={history.error} reload={history.reload} />
    </div>
  );
}

function ProgressStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-2 text-center">
      <p className="text-[10px] uppercase text-slate-600">{label}</p>
      <p className="font-mono text-slate-200">{value}</p>
    </div>
  );
}

function SearchHistory({
  data,
  loading,
  error,
  reload,
}: {
  data: SearchRow[] | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data || data.length === 0) return <EmptyState title="No searches run yet" />;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-200">Search history</h3>
      {data.map((s) => (
        <div key={s.id} className="card p-3 text-sm">
          <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
            <Badge
              tone={s.status === 'COMPLETED' ? 'green' : s.status === 'PARTIAL' ? 'amber' : s.status === 'FAILED' ? 'red' : 'neutral'}
            >
              {s.status}
            </Badge>
            <code className="text-slate-200">{s.originalQuery}</code>
            <span className="text-[11px] text-slate-600">{s.depth}</span>
            <span className="ml-auto text-[11px] text-slate-500">
              {s._count.evidence} evidence · {s._count.queries} queries
            </span>
          </button>
          {openId === s.id && <SearchDetail searchId={s.id} />}
        </div>
      ))}
    </div>
  );
}

function SearchDetail({ searchId }: { searchId: string }) {
  const { data, loading } = useApi<{
    coverage: Array<{ connectorId: string; state: string; hits: number; note?: string }>;
    queries: Array<{ text: string; kind: string; executed: boolean }>;
  }>(`/searches/${searchId}`);
  const results = useApi<{ items: Array<{ id: string; title: string | null; url: string | null; sourcePlatform: string; publishedAt: string | null; isDuplicate: boolean; source: { tier: string | null } | null }> }>(
    `/searches/${searchId}/results?limit=25`,
  );
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <div className="mt-3 space-y-3 border-t border-ink-800 pt-3">
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-400">Coverage</p>
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {data.coverage.map((c) => (
            <li key={c.connectorId}>
              <Badge tone={c.state === 'COMPLETED' ? 'green' : c.state === 'PARTIAL' ? 'amber' : c.state === 'NOT_RUN' ? 'neutral' : 'red'}>
                {c.connectorId}: {c.state} ({c.hits})
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-400">Results</p>
        <ul className="space-y-1 text-xs">
          {results.data?.items.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-slate-600">{r.id}</span>
              <Badge tone="blue">{r.sourcePlatform}</Badge>
              {r.isDuplicate && <Badge tone="amber">dup</Badge>}
              {r.url ? (
                <a href={r.url} target="_blank" rel="noreferrer" className="truncate text-slate-300 hover:text-accent">
                  {r.title ?? r.url}
                </a>
              ) : (
                <span className="truncate text-slate-300">{r.title ?? '(untitled)'}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
