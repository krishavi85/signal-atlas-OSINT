'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface EntityRow {
  id: string;
  type: string;
  displayName: string;
  canonicalValue: string;
  resolutionConfidence: string;
  _count: { evidenceLinks: number; relationshipsFrom: number; relationshipsTo: number; aliases: number };
}

export function EntitiesTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams({ limit: '150' });
  if (type) params.set('type', type);
  if (q) params.set('q', q);
  const { data, error, loading, reload } = useApi<EntityRow[]>(`/projects/${projectId}/entities?${params.toString()}`, [type, q]);
  const [selected, setSelected] = useState<string | null>(null);

  const types = [...new Set((data ?? []).map((e) => e.type))].sort();

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Filter entities…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-44" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} retry={reload} />
        ) : !data || data.length === 0 ? (
          <EmptyState title="No entities yet" hint="Entities are extracted from evidence during a search." />
        ) : (
          <ul className="space-y-1">
            {data.map((e) => (
              <li
                key={e.id}
                onClick={() => setSelected(e.id)}
                className={`card flex cursor-pointer items-center gap-2 p-2.5 text-sm hover:border-ink-600 ${selected === e.id ? 'border-accent' : ''}`}
              >
                <Badge tone="violet">{e.type}</Badge>
                <span className="text-slate-200">{e.displayName}</span>
                <Badge tone={e.resolutionConfidence === 'VERIFIED' || e.resolutionConfidence === 'HIGH' ? 'green' : 'neutral'}>
                  {e.resolutionConfidence}
                </Badge>
                <span className="ml-auto text-[11px] text-slate-600">
                  {e._count.evidenceLinks} evidence · {e._count.relationshipsFrom + e._count.relationshipsTo} links
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        {selected ? (
          <EntityInspector entityId={selected} canEdit={canEdit} onChange={reload} />
        ) : (
          <div className="card p-4 text-sm text-slate-500">Select an entity to see evidence, relationships and merge candidates.</div>
        )}
      </aside>
    </div>
  );
}

function EntityInspector({ entityId, canEdit, onChange }: { entityId: string; canEdit: boolean; onChange: () => void }) {
  const { data, loading, error, reload } = useApi<{
    id: string;
    type: string;
    displayName: string;
    aliases: Array<{ value: string; kind: string }>;
    evidenceLinks: Array<{ evidence: { id: string; title: string | null; url: string | null; sourcePlatform: string } }>;
    relationshipsFrom: Array<{ type: string; to: { displayName: string; type: string } }>;
    relationshipsTo: Array<{ type: string; from: { displayName: string; type: string } }>;
    mergeLog: Array<{ action: string; reason: string; createdAt: string }>;
  }>(`/entities/${entityId}`, [entityId]);
  const candidates = useApi<Array<{ entity: { id: string; displayName: string; _count: { evidenceLinks: number } }; score: number; recommendation: string; factors: Array<{ explanation: string }> }>>(
    `/entities/${entityId}/merge-candidates`,
    [entityId],
  );
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="card p-4"><Spinner /></div>;
  if (error) return <div className="card p-4"><ErrorState error={error} /></div>;
  if (!data) return null;

  async function merge(sourceId: string) {
    const reason = prompt('Reason for merging (kept in the audit log):');
    if (!reason) return;
    setBusy(true);
    try {
      await api(`/entities/${entityId}/merge`, { method: 'POST', body: JSON.stringify({ sourceEntityId: sourceId, reason }) });
      await Promise.all([reload(), candidates.reload()]);
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Merge failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 p-4 text-sm">
      <p className="font-medium text-slate-100">
        <Badge tone="violet">{data.type}</Badge> {data.displayName}
      </p>
      {data.aliases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.aliases.map((a, i) => (
            <Badge key={i}>
              {a.kind}: {a.value}
            </Badge>
          ))}
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-400">Evidence ({data.evidenceLinks.length})</p>
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {data.evidenceLinks.map((l, i) => (
            <li key={i} className="flex gap-1.5 truncate">
              <span className="font-mono text-[10px] text-slate-600">{l.evidence.id}</span>
              <span className="truncate text-slate-400">{l.evidence.title ?? l.evidence.url}</span>
            </li>
          ))}
        </ul>
      </div>

      {(data.relationshipsFrom.length > 0 || data.relationshipsTo.length > 0) && (
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400">Relationships</p>
          <ul className="space-y-0.5 text-xs text-slate-400">
            {data.relationshipsFrom.map((r, i) => (
              <li key={`f${i}`}>
                → {r.type} → {r.to.displayName}
              </li>
            ))}
            {data.relationshipsTo.map((r, i) => (
              <li key={`t${i}`}>
                {r.from.displayName} → {r.type} → (this)
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-400">Merge candidates (§7 — scored, never automatic)</p>
        {candidates.loading ? (
          <Spinner />
        ) : !candidates.data || candidates.data.length === 0 ? (
          <p className="text-xs text-slate-600">No candidates ≥ 0.5 similarity.</p>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {candidates.data.map((c) => (
              <li key={c.entity.id} className="rounded border border-ink-800 p-2">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">{c.entity.displayName}</span>
                  <Badge tone={c.recommendation === 'LIKELY_SAME' ? 'green' : c.recommendation === 'REVIEW' ? 'amber' : 'neutral'}>
                    {(c.score * 100) | 0}% · {c.recommendation}
                  </Badge>
                  {canEdit && (
                    <button className="btn-ghost ml-auto py-0.5 text-[11px]" disabled={busy} onClick={() => merge(c.entity.id)}>
                      Merge in
                    </button>
                  )}
                </div>
                <ul className="mt-1 text-[11px] text-slate-600">
                  {c.factors.map((f, i) => (
                    <li key={i}>· {f.explanation}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.mergeLog.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400">Merge history (reversible)</p>
          <ul className="text-[11px] text-slate-500">
            {data.mergeLog.map((m, i) => (
              <li key={i}>
                {m.action}: {m.reason} — {new Date(m.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
