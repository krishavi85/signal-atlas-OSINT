'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  objective: string | null;
  status: string;
  myRole: string;
  updatedAt: string;
  _count: { evidence: number; entities: number; searches: number; monitoringJobs: number };
}

export default function InvestigationsPage() {
  const { data, error, loading, reload } = useApi<Project[]>('/projects');
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormErr(null);
    try {
      const p = await api<{ id: string }>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, objective: objective || undefined, defaultLanguages: ['en'] }),
      });
      router.push(`/investigations/${p.id}`);
    } catch (e2) {
      setFormErr(e2 instanceof Error ? e2.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Investigations</h1>
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New investigation'}
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="card space-y-3 p-4">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label">Objective (optional)</label>
            <textarea className="input" rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} />
          </div>
          {formErr && <p className="text-xs text-red-400">{formErr}</p>}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No investigations yet" hint="Create one to start collecting evidence." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.map((p) => (
            <Link key={p.id} href={`/investigations/${p.id}`} className="card block p-4 transition-colors hover:border-ink-600">
              <div className="flex items-start justify-between">
                <h2 className="font-medium text-slate-100">{p.name}</h2>
                <Badge tone={p.status === 'ACTIVE' ? 'green' : p.status === 'PAUSED' ? 'amber' : 'neutral'}>{p.status}</Badge>
              </div>
              {p.objective && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{p.objective}</p>}
              <div className="mt-3 flex gap-3 text-[11px] text-slate-500">
                <span>{p._count.evidence} evidence</span>
                <span>{p._count.entities} entities</span>
                <span>{p._count.searches} searches</span>
                <span className="ml-auto">{p.myRole}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
