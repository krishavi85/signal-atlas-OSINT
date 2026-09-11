'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui';
import { IconDatabase, IconFolder, IconPlus, IconRadar, IconUsers } from '@/components/icons';

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
      <PageHeader
        title="Investigations"
        description="Cases collect evidence, entities, claims, and reports under one lawful research scope."
        actions={
          <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
            <IconPlus className="h-3.5 w-3.5" /> New investigation
          </button>
        }
      />

      {creating && (
        <form onSubmit={create} className="card animate-in space-y-3 p-4">
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
        <Spinner size="md" />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<IconFolder className="h-5 w-5" />} title="No investigations yet" hint="Create one to start collecting evidence." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Link key={p.id} href={`/investigations/${p.id}`} className="card-interactive group block p-4">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium text-slate-100 group-hover:text-white">{p.name}</h2>
                <Badge dot tone={p.status === 'ACTIVE' ? 'green' : p.status === 'PAUSED' ? 'amber' : 'neutral'}>
                  {p.status}
                </Badge>
              </div>
              {p.objective ? (
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-500">{p.objective}</p>
              ) : (
                <p className="mt-1.5 text-xs italic text-slate-700">No objective set</p>
              )}
              <div className="mt-3.5 flex items-center gap-3 border-t border-ink-800 pt-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1">
                  <IconDatabase className="h-3 w-3" /> {p._count.evidence}
                </span>
                <span className="flex items-center gap-1">
                  <IconUsers className="h-3 w-3" /> {p._count.entities}
                </span>
                <span className="flex items-center gap-1">
                  <IconRadar className="h-3 w-3" /> {p._count.searches}
                </span>
                <span className="ml-auto rounded-full bg-ink-800 px-2 py-0.5 font-medium text-slate-400">{p.myRole.toLowerCase()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
