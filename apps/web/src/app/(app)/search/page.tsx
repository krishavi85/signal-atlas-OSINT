'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, Spinner } from '@/components/ui';

/**
 * Universal Search (§4) — a single entry point that dispatches into an
 * investigation. Requires choosing/creating a project because every finding
 * must be filed as evidence in a case.
 */
export default function UniversalSearchPage() {
  const router = useRouter();
  const projects = useApi<Array<{ id: string; name: string; status: string }>>('/projects');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [newName, setNewName] = useState('');
  const [depth, setDepth] = useState('STANDARD');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      let pid = projectId;
      if (!pid) {
        const p = await api<{ id: string }>('/projects', {
          method: 'POST',
          body: JSON.stringify({ name: newName || `Search: ${query}`.slice(0, 80), defaultLanguages: ['en'] }),
        });
        pid = p.id;
      }
      await api(`/projects/${pid}/search`, {
        method: 'POST',
        body: JSON.stringify({ query, depth }),
      });
      router.push(`/investigations/${pid}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Universal Search</h1>
        <p className="text-xs text-slate-500">
          One query across every lawful configured source. Results are filed as source-backed evidence in an
          investigation.
        </p>
      </div>

      <form onSubmit={go} className="card space-y-4 p-5">
        <div>
          <label className="label">Query</label>
          <input
            className="input text-base"
            autoFocus
            placeholder='name · org · username · domain · "phrase" · #hashtag · topic'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            required
          />
          <p className="mt-1 text-[11px] text-slate-600">
            Boolean: <code>AND OR NOT &quot;exact&quot; site:example.com -spam.com after:2025-01-01 lang:en</code>
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">File into</label>
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
          </div>
          <div>
            <label className="label">Depth</label>
            <select className="input" value={depth} onChange={(e) => setDepth(e.target.value)}>
              {['QUICK', 'STANDARD', 'DEEP'].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
        </div>

        {!projectId && (
          <div>
            <label className="label">New investigation name (optional)</label>
            <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
        )}

        {err && <p className="text-xs text-red-400">{err}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Starting…' : 'Search'}
        </button>
      </form>

      {projects.data && projects.data.length === 0 && (
        <EmptyState title="No investigations yet" hint="Your first search will create one." />
      )}

      <p className="text-center text-[11px] text-slate-600">
        <Badge>lawful public information only</Badge> — this platform does not bypass logins, privacy settings, or
        anti-bot controls.
      </p>
    </div>
  );
}
