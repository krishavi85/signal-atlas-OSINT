'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, ErrorState, Spinner } from '@/components/ui';
import { Overview } from './Overview';
import { SearchTab } from './SearchTab';
import { EvidenceTab } from './EvidenceTab';
import { EntitiesTab } from './EntitiesTab';
import { AuditTab } from './AuditTab';

interface ProjectDetail {
  id: string;
  name: string;
  objective: string | null;
  status: string;
  myRole: string;
  _count: Record<string, number>;
}

const TABS = ['Overview', 'Search', 'Evidence', 'Entities', 'Audit'] as const;
type Tab = (typeof TABS)[number];

export default function InvestigationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: project, error, loading, reload } = useApi<ProjectDetail>(`/projects/${id}`);
  const [tab, setTab] = useState<Tab>('Overview');
  const [busy, setBusy] = useState(false);

  async function toggleStatus() {
    if (!project) return;
    setBusy(true);
    try {
      await api(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: project.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }),
      });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!project) return null;

  const canEdit = project.myRole === 'OWNER' || project.myRole === 'EDITOR';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-slate-100">{project.name}</h1>
        <Badge tone={project.status === 'ACTIVE' ? 'green' : project.status === 'PAUSED' ? 'amber' : 'neutral'}>
          {project.status}
        </Badge>
        <span className="text-xs text-slate-500">{project.myRole}</span>
        {canEdit && (
          <button className="btn-ghost ml-auto py-1" onClick={toggleStatus} disabled={busy}>
            {project.status === 'ACTIVE' ? 'Pause' : 'Resume'}
          </button>
        )}
      </div>
      {project.objective && <p className="max-w-3xl text-sm text-slate-400">{project.objective}</p>}

      <div className="flex gap-1 border-b border-ink-800 text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 font-medium ${
              tab === t ? 'border-accent text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && <Overview projectId={id} />}
      {tab === 'Search' && <SearchTab projectId={id} canEdit={canEdit} projectActive={project.status === 'ACTIVE'} />}
      {tab === 'Evidence' && <EvidenceTab projectId={id} canEdit={canEdit} />}
      {tab === 'Entities' && <EntitiesTab projectId={id} canEdit={canEdit} />}
      {tab === 'Audit' && <AuditTab projectId={id} />}
    </div>
  );
}
