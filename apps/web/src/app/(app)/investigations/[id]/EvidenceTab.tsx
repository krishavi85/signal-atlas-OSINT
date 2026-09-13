'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface EvidenceRow {
  id: string;
  title: string | null;
  url: string | null;
  author: string | null;
  sourcePlatform: string;
  publishedAt: string | null;
  retrievedAt: string;
  excerpt: string | null;
  language: string | null;
  isDuplicate: boolean;
  duplicateReason: string | null;
  verificationStatus: string;
  discoveryQuery: string;
  contentHash: string;
  source: { label: string; tier: string | null; qualityScore: number | null } | null;
  connector: { displayName: string } | null;
  _count: { entities: number; duplicates: number; claimLinks: number };
}

export function EvidenceTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState('');
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'keyword' | 'semantic'>('keyword');

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (platform) params.set('platform', platform);
  if (includeDuplicates) params.set('includeDuplicates', 'true');
  params.set('limit', '60');

  const { data, error, loading, reload } = useApi<{
    items: EvidenceRow[];
    facets: { platform: Array<{ value: string; count: number }> };
  }>(`/projects/${projectId}/evidence?${params.toString()}`, [q, platform, includeDuplicates]);

  const semantic = useApi<{
    available: boolean;
    reason?: string;
    setup?: string;
    indexed?: number;
    total?: number;
    results?: Array<{ id: string; title: string | null; url: string | null; sourcePlatform: string; excerpt: string | null; score: number }>;
  }>(mode === 'semantic' && q.length > 1 ? `/projects/${projectId}/semantic-search?q=${encodeURIComponent(q)}` : null, [mode, q]);
  const semStatus = useApi<{ available: boolean; reason?: string; setup?: string; indexed: number; total: number }>(
    mode === 'semantic' ? `/projects/${projectId}/semantic-status` : null,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        {canEdit && <FetchUrlForm projectId={projectId} onQueued={reload} />}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-md bg-ink-950 p-1 text-xs">
            {(['keyword', 'semantic'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-1 capitalize ${mode === m ? 'bg-ink-800 text-slate-100' : 'text-slate-500'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            className="input max-w-xs"
            placeholder={mode === 'semantic' ? 'Describe what you are looking for…' : 'Full-text search collected evidence…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {mode === 'keyword' && (
            <>
              <select className="input w-40" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">All platforms</option>
                {data?.facets.platform.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.value} ({f.count})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <input type="checkbox" checked={includeDuplicates} onChange={(e) => setIncludeDuplicates(e.target.checked)} />
                show duplicates
              </label>
            </>
          )}
        </div>

        {mode === 'semantic' && (
          <SemanticPanel projectId={projectId} canEdit={canEdit} status={semStatus.data ?? undefined} statusLoading={semStatus.loading} results={semantic} onSelect={setSelected} selected={selected} />
        )}
        {mode === 'keyword' &&
          (loading ? (
            <Spinner />
          ) : error ? (
            <ErrorState error={error} retry={reload} />
          ) : !data || data.items.length === 0 ? (
            <EmptyState title="No evidence matches" hint="Run a search or relax the filters." />
          ) : (
            <ul className="space-y-2">
              {data.items.map((e) => (
              <li
                key={e.id}
                onClick={() => setSelected(e.id)}
                className={`card cursor-pointer p-3 text-sm transition-colors hover:border-ink-600 ${selected === e.id ? 'border-accent' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-600">{e.id}</span>
                  <Badge tone="blue">{e.sourcePlatform}</Badge>
                  {e.isDuplicate && <Badge tone="amber">{e.duplicateReason ?? 'duplicate'}</Badge>}
                  {e.source?.tier && <Badge>{e.source.tier}</Badge>}
                  <span className="ml-auto text-[11px] text-slate-600">
                    {e.publishedAt ? new Date(e.publishedAt).toLocaleDateString() : 'no date'}
                  </span>
                </div>
                <p className="mt-1 font-medium text-slate-200">{e.title ?? e.url ?? '(untitled)'}</p>
                {e.excerpt && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{e.excerpt}</p>}
                <div className="mt-1.5 flex gap-3 text-[11px] text-slate-600">
                  <span>{e._count.entities} entities</span>
                  <span>{e._count.duplicates} copies</span>
                  <span>via &quot;{e.discoveryQuery}&quot;</span>
                </div>
              </li>
              ))}
            </ul>
          ))}
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        {selected ? (
          <EvidenceInspector evidenceId={selected} canEdit={canEdit} onDeleted={() => { setSelected(null); void reload(); }} />
        ) : (
          <div className="card p-4 text-sm text-slate-500">Select an evidence record to inspect its provenance.</div>
        )}
      </aside>
    </div>
  );
}

function FetchUrlForm({ projectId, onQueued }: { projectId: string; onQueued: () => void }) {
  const [url, setUrl] = useState('');
  const [render, setRender] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await api(`/projects/${projectId}/evidence/fetch-url`, { method: 'POST', body: JSON.stringify({ url, render }) });
      setStatus(render ? 'Queued — rendering JS via headless Chromium can take a bit longer.' : 'Queued.');
      setUrl('');
      setTimeout(onQueued, 3000);
      setTimeout(onQueued, 9000);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to queue fetch');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-2 p-3 text-sm">
      <p className="text-xs font-semibold text-slate-300">Fetch a URL into evidence</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[16rem] flex-1"
          type="url"
          required
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} />
          render JS (headless browser)
        </label>
        <button className="btn-primary py-1.5 text-xs" disabled={busy || !url}>
          {busy ? 'Queuing…' : 'Fetch'}
        </button>
      </div>
      {status && <p className="text-[11px] text-slate-500">{status}</p>}
    </form>
  );
}

function EvidenceInspector({ evidenceId, canEdit, onDeleted }: { evidenceId: string; canEdit: boolean; onDeleted: () => void }) {
  const { data, loading, error } = useApi<
    EvidenceRow & {
      rawMetadata: Record<string, unknown>;
      entities: Array<{ entity: { id: string; type: string; displayName: string }; confidence: number; method: string }>;
      duplicates: Array<{ id: string; url: string | null; duplicateReason: string | null }>;
      duplicateOf: { id: string; url: string | null; title: string | null } | null;
    }
  >(`/evidence/${evidenceId}`, [evidenceId]);
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="card p-4"><Spinner /></div>;
  if (error) return <div className="card p-4"><ErrorState error={error} /></div>;
  if (!data) return null;

  return (
    <div className="card space-y-3 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-slate-500">{data.id}</span>
        {canEdit && (
          <button
            className="btn-ghost py-0.5 text-xs text-red-400"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Delete this evidence record? The id is retained in the audit log.')) return;
              setBusy(true);
              try {
                await api(`/evidence/${data.id}`, { method: 'DELETE' });
                onDeleted();
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
      <p className="font-medium text-slate-100">{data.title ?? '(untitled)'}</p>
      {data.url && (
        <a href={data.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-accent hover:underline">
          {data.url}
        </a>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Field k="Platform" v={data.sourcePlatform} />
        <Field k="Connector" v={data.connector?.displayName ?? '—'} />
        <Field k="Author" v={data.author ?? '—'} />
        <Field k="Published" v={data.publishedAt ? new Date(data.publishedAt).toLocaleString() : '—'} />
        <Field k="Retrieved" v={new Date(data.retrievedAt).toLocaleString()} />
        <Field k="Discovery query" v={data.discoveryQuery} />
        <Field k="Content hash" v={data.contentHash.slice(0, 24) + '…'} />
        <Field k="Verification" v={data.verificationStatus} />
        <Field k="Source tier" v={data.source?.tier ?? '—'} />
      </dl>

      {data.isDuplicate && data.duplicateOf && (
        <p className="rounded border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-300">
          Marked <strong>{data.duplicateReason}</strong> of{' '}
          <span className="font-mono">{data.duplicateOf.id}</span>. Not counted toward corroboration.
        </p>
      )}

      {data.excerpt && <p className="rounded bg-ink-950 p-2 text-xs text-slate-400">{data.excerpt}</p>}

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-400">
          Extracted entities ({data.entities.length}) — deterministic (heuristic), not ML
        </p>
        <ul className="flex flex-wrap gap-1">
          {data.entities.map((e, i) => (
            <li key={i}>
              <Badge tone="violet">
                {e.entity.type}: {e.entity.displayName} ({(e.confidence * 100) | 0}%)
              </Badge>
            </li>
          ))}
          {data.entities.length === 0 && <span className="text-xs text-slate-600">none</span>}
        </ul>
      </div>

      {data.duplicates.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400">Other copies ({data.duplicates.length})</p>
          <ul className="space-y-0.5 text-xs text-slate-500">
            {data.duplicates.map((d) => (
              <li key={d.id} className="truncate">
                <span className="font-mono">{d.id}</span> {d.url}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SemanticPanel({
  projectId,
  canEdit,
  status,
  statusLoading,
  results,
  onSelect,
  selected,
}: {
  projectId: string;
  canEdit: boolean;
  status?: { available: boolean; reason?: string; setup?: string; indexed: number; total: number };
  statusLoading: boolean;
  results: ReturnType<typeof useApi<any>>;
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  const [reindexing, setReindexing] = useState(false);
  if (statusLoading) return <Spinner />;

  if (status && !status.available) {
    return (
      <div className="rounded-lg border border-amber-900 bg-amber-950/20 p-4 text-sm text-amber-300">
        <p className="font-medium">Semantic search is unavailable</p>
        <p className="mt-1 text-amber-400">{status.reason}</p>
        {status.setup && <p className="mt-1 text-xs text-amber-500">{status.setup}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Keyword search still works. No lexical results are dressed up as semantic (§51).
        </p>
      </div>
    );
  }

  const r = results.data;
  return (
    <div className="space-y-2">
      {status && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>
            index: {status.indexed}/{status.total} evidence embedded
          </span>
          {canEdit && status.indexed < status.total && (
            <button
              className="btn-ghost py-0.5"
              disabled={reindexing}
              onClick={async () => {
                setReindexing(true);
                try {
                  await api(`/projects/${projectId}/semantic-reindex`, { method: 'POST' });
                } finally {
                  setReindexing(false);
                }
              }}
            >
              {reindexing ? 'queued…' : 'build index'}
            </button>
          )}
        </div>
      )}
      {results.loading ? (
        <Spinner label="Embedding query & ranking…" />
      ) : !r ? (
        <EmptyState title="Enter a description" hint="e.g. 'discussion of funding or financial trouble'" />
      ) : !r.available ? (
        <div className="rounded border border-amber-900 bg-amber-950/20 p-3 text-xs text-amber-300">{r.reason}</div>
      ) : (r.results ?? []).length === 0 ? (
        <EmptyState title="No semantically similar evidence" hint={`${r.indexed ?? 0} records indexed`} />
      ) : (
        <ul className="space-y-2">
          {r.results!.map((e: any) => (
            <li
              key={e.id}
              onClick={() => onSelect(e.id)}
              className={`card cursor-pointer p-3 text-sm hover:border-ink-600 ${selected === e.id ? 'border-accent' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-600">{e.id}</span>
                <Badge tone="blue">{e.sourcePlatform}</Badge>
                <Badge tone="violet">similarity {(e.score * 100).toFixed(0)}%</Badge>
              </div>
              <p className="mt-1 font-medium text-slate-200">{e.title ?? e.url ?? '(untitled)'}</p>
              {e.excerpt && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{e.excerpt}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-slate-600">{k}</dt>
      <dd className="truncate text-slate-300">{v}</dd>
    </>
  );
}
