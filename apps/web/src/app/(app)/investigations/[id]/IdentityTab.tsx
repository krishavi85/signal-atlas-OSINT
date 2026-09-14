'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface IdentityStatus {
  available: boolean;
  reason?: string;
  source?: string;
  fetchedAt?: string;
  siteCount?: number;
  categories?: string[];
}

interface ScanRow {
  id: string;
  username: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalChecked: number;
  foundCount: number;
  error: string | null;
  createdAt: string;
}

interface ResultRow {
  id: string;
  platform: string;
  category: string | null;
  url: string;
  status: 'FOUND' | 'NOT_FOUND' | 'UNKNOWN' | 'ERROR';
  httpStatus: number | null;
  protection: string | null;
  error: string | null;
  evidenceId: string | null;
}

const STATUS_TONE = { FOUND: 'green', NOT_FOUND: 'neutral', UNKNOWN: 'amber', ERROR: 'red' } as const;

export function IdentityTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const status = useApi<IdentityStatus>('/identity/status');
  const scans = useApi<ScanRow[]>(`/projects/${projectId}/identity/scans`);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);

  const hasActiveScan = (scans.data ?? []).some((s) => s.status === 'QUEUED' || s.status === 'RUNNING');
  useEffect(() => {
    if (!hasActiveScan) return;
    const t = setInterval(() => void scans.reload(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveScan]);

  async function startScan() {
    if (!username.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ scanId: string }>(`/projects/${projectId}/identity/scan`, {
        method: 'POST',
        body: JSON.stringify({ username: username.trim() }),
      });
      setUsername('');
      setSelectedScanId(res.scanId);
      await scans.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start scan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <div className="space-y-4">
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-200">Username enumeration (§31)</h3>
          {status.loading ? (
            <Spinner />
          ) : status.data?.available ? (
            <p className="mt-1 text-xs text-slate-500">
              Checks a candidate username's public profile URL against <span className="text-slate-300">{status.data.siteCount}</span> platforms
              (WhatsMyName dataset) — one unauthenticated GET/POST per site, classified from the response. No login, no CAPTCHA
              solving, no scraping beyond that single public page.
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-400">Dataset unavailable: {status.data?.reason}</p>
          )}
          {canEdit && status.data?.available && (
            <div className="mt-3 flex gap-2">
              <input
                className="input"
                placeholder="username to check"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startScan()}
                disabled={busy}
              />
              <button className="btn-primary" onClick={startScan} disabled={busy || !username.trim()}>
                {busy ? 'Starting…' : 'Scan'}
              </button>
            </div>
          )}
          {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
        </div>

        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-200">Scan history</h3>
          {scans.loading ? (
            <Spinner />
          ) : !scans.data || scans.data.length === 0 ? (
            <p className="mt-2 text-xs text-slate-600">No scans yet.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {scans.data.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setSelectedScanId(s.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      selectedScanId === s.id ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:bg-ink-850'
                    }`}
                  >
                    <Badge
                      dot
                      tone={s.status === 'COMPLETED' ? 'green' : s.status === 'FAILED' ? 'red' : 'amber'}
                    >
                      {s.status}
                    </Badge>
                    <span className="truncate font-medium">{s.username}</span>
                    <span className="ml-auto shrink-0 text-slate-600">
                      {s.foundCount}/{s.totalChecked}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>{selectedScanId ? <ScanDetail scanId={selectedScanId} canEdit={canEdit} /> : <EmptyState title="Select or start a scan" hint="Results appear here as each platform is checked." />}</div>
    </div>
  );
}

function ScanDetail({ scanId, canEdit }: { scanId: string; canEdit: boolean }) {
  const { data, loading, error, reload } = useApi<{ scan: ScanRow; results: ResultRow[] }>(`/identity/scans/${scanId}`, [scanId]);
  const [addingId, setAddingId] = useState<string | null>(null);

  const scanRunning = data?.scan.status === 'QUEUED' || data?.scan.status === 'RUNNING';
  useEffect(() => {
    if (!scanRunning) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRunning, scanId]);

  if (loading && !data) return <Spinner size="md" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  const { scan, results } = data;
  const running = scan.status === 'QUEUED' || scan.status === 'RUNNING';
  const found = results.filter((r) => r.status === 'FOUND');
  const rest = results.filter((r) => r.status !== 'FOUND');

  async function addEvidence(resultId: string) {
    setAddingId(resultId);
    try {
      await api(`/identity/results/${resultId}/add-evidence`, { method: 'POST' });
      await reload();
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-2 p-3 text-xs">
        <span className="font-semibold text-slate-200">{scan.username}</span>
        <Badge dot tone={scan.status === 'COMPLETED' ? 'green' : scan.status === 'FAILED' ? 'red' : 'amber'}>
          {scan.status}
        </Badge>
        <span className="text-slate-500">
          {scan.totalChecked} checked, {scan.foundCount} found
        </span>
        {running && (
          <span className="ml-auto flex items-center gap-1.5 text-slate-500">
            <Spinner /> checking…
          </span>
        )}
        {scan.error && <span className="w-full text-red-400">{scan.error}</span>}
      </div>

      {found.length > 0 && (
        <div className="card p-3">
          <p className="mb-2 text-xs font-semibold text-slate-300">Found ({found.length})</p>
          <ul className="space-y-1.5">
            {found.map((r) => (
              <ResultItem key={r.id} r={r} canEdit={canEdit} busy={addingId === r.id} onAdd={() => addEvidence(r.id)} />
            ))}
          </ul>
        </div>
      )}

      {rest.length > 0 && (
        <details className="card p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-slate-400">Not found / unknown / errored ({rest.length})</summary>
          <ul className="mt-2 space-y-1">
            {rest.map((r) => (
              <ResultItem key={r.id} r={r} canEdit={canEdit} busy={false} onAdd={() => {}} />
            ))}
          </ul>
        </details>
      )}

      {results.length === 0 && !running && <EmptyState title="No results" />}
    </div>
  );
}

function ResultItem({ r, canEdit, busy, onAdd }: { r: ResultRow; canEdit: boolean; busy: boolean; onAdd: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-ink-800 px-2 py-1.5 text-xs">
      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
      <span className="font-medium text-slate-200">{r.platform}</span>
      {r.category && <span className="text-slate-600">{r.category}</span>}
      {r.protection && <span className="text-amber-500" title="This site returns anti-bot/challenge pages; treat this result as unreliable">⚠ {r.protection}</span>}
      <a href={r.url} target="_blank" rel="noreferrer" className="ml-auto truncate text-accent hover:underline">
        {r.url}
      </a>
      {r.status === 'FOUND' && canEdit && (
        <button className="btn-ghost shrink-0 px-2 py-0.5" onClick={onAdd} disabled={busy || Boolean(r.evidenceId)}>
          {r.evidenceId ? 'in evidence' : busy ? 'adding…' : 'add to evidence'}
        </button>
      )}
      {r.error && <span className="w-full text-red-400/80">{r.error}</span>}
    </li>
  );
}
