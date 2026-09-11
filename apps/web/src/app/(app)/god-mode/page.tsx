'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, Spinner } from '@/components/ui';
import { IconZap } from '@/components/icons';

const SUBJECT_TYPES = ['', 'PERSON', 'ORGANIZATION', 'COMPANY', 'BRAND', 'PRODUCT', 'DOMAIN', 'USERNAME', 'TOPIC'];

/**
 * God Mode (§55) — one autonomous run from TARGET / OBJECTIVE / DATE RANGE /
 * SOURCES / DEPTH / LANGUAGES, composing every engine end to end.
 */
export default function GodModePage() {
  const router = useRouter();
  const projects = useApi<Array<{ id: string; name: string; status: string }>>('/projects');
  const connectors = useApi<Array<{ connectorId: string; displayName: string; effective: Record<string, boolean> }>>('/connectors');

  const [target, setTarget] = useState('');
  const [objective, setObjective] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [depth, setDepth] = useState<'QUICK' | 'STANDARD' | 'DEEP'>('DEEP');
  const [dateAfter, setDateAfter] = useState('');
  const [projectId, setProjectId] = useState('');
  const [newName, setNewName] = useState('');
  const [useAllSources, setUseAllSources] = useState(true);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const searchableConnectors = connectors.data?.filter((c) => c.effective.SEARCH_SUPPORTED) ?? [];

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      let pid = projectId;
      if (!pid) {
        const p = await api<{ id: string }>('/projects', {
          method: 'POST',
          body: JSON.stringify({ name: newName || `God Mode: ${target}`.slice(0, 80), objective: objective || undefined, defaultLanguages: ['en'] }),
        });
        pid = p.id;
      }
      const res = await api<{ godModeRunId: string }>(`/projects/${pid}/god-mode`, {
        method: 'POST',
        body: JSON.stringify({
          target,
          objective: objective || undefined,
          subjectType: subjectType || undefined,
          depth,
          languages: ['en'],
          dateRangeStart: dateAfter ? new Date(dateAfter).toISOString() : undefined,
          connectorIds: useAllSources ? undefined : connectorIds,
        }),
      });
      router.push(`/god-mode/${res.godModeRunId}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to launch');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl animate-in space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-signal-cyan text-ink-975 shadow-glow">
          <IconZap className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">God Mode</h1>
          <p className="mt-0.5 text-sm leading-relaxed text-slate-500">
            One autonomous investigation: plan → search every lawful configured source → collect evidence → resolve
            entities → extract claims → correlate → build a timeline → flag contradictions → generate a report →
            recommend next steps. Nothing here bypasses a platform&apos;s access controls, and every uncertainty is
            reported, not hidden (§55, §56).
          </p>
        </div>
      </div>

      <form onSubmit={launch} className="card space-y-4 p-5">
        <div>
          <label className="label">Target</label>
          <input className="input text-base" autoFocus value={target} onChange={(e) => setTarget(e.target.value)} required placeholder="e.g. BeatShore" />
        </div>
        <div>
          <label className="label">Objective (optional)</label>
          <textarea
            className="input"
            rows={2}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Discover and analyze public information, mentions, accounts, and relevant relationships."
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Subject type</label>
            <select className="input" value={subjectType} onChange={(e) => setSubjectType(e.target.value)}>
              {SUBJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t || 'Auto'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Depth</label>
            <select className="input" value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
              {(['QUICK', 'STANDARD', 'DEEP'] as const).map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Date range start</label>
            <input className="input" type="date" value={dateAfter} onChange={(e) => setDateAfter(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">Sources</label>
          <label className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={useAllSources} onChange={(e) => setUseAllSources(e.target.checked)} />
            All configured lawful public sources
          </label>
          {!useAllSources && (
            <select
              multiple
              className="input h-28"
              value={connectorIds}
              onChange={(e) => setConnectorIds([...e.target.selectedOptions].map((o) => o.value))}
            >
              {searchableConnectors.map((c) => (
                <option key={c.connectorId} value={c.connectorId}>
                  {c.displayName}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="label">Investigation</label>
          {projects.loading ? (
            <Spinner />
          ) : (
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">＋ New investigation</option>
              {projects.data
                ?.filter((p) => p.status === 'ACTIVE')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          )}
          {!projectId && (
            <input className="input mt-2" placeholder="New investigation name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          )}
        </div>

        {err && <p className="text-xs text-red-400">{err}</p>}
        <button className="btn-primary w-full" disabled={busy || !target.trim()}>
          {busy ? 'Launching…' : 'Launch God Mode'}
        </button>
      </form>

      {projects.data && projects.data.length === 0 && <EmptyState title="No investigations yet" hint="Launching will create one." />}

      <p className="text-center text-[11px] text-slate-600">
        <Badge>lawful public information only</Badge> — DEEP mode runs an extra round of AI-suggested follow-up
        searches only when an AI provider is configured; otherwise it runs a deeper single pass and says so.
      </p>
    </div>
  );
}
