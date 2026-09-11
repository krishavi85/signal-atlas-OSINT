'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, ErrorState, Spinner } from '@/components/ui';
import {
  IconChevronRight,
  IconClock,
  IconDatabase,
  IconFileText,
  IconFolder,
  IconImage,
  IconLink,
  IconRadar,
  IconSearch,
  IconSettings,
  IconShield,
  IconSparkle,
  IconUsers,
} from '@/components/icons';
import { Overview } from './Overview';
import { SearchTab } from './SearchTab';
import { EvidenceTab } from './EvidenceTab';
import { EntitiesTab } from './EntitiesTab';
import { ClaimsTab } from './ClaimsTab';
import { TimelineTab } from './TimelineTab';
import { ConnectionsTab } from './ConnectionsTab';
import { MediaTab } from './MediaTab';
import { MonitoringTab } from './MonitoringTab';
import { DocumentsTab } from './DocumentsTab';
import { AnalystTab } from './AnalystTab';
import { AuditTab } from './AuditTab';

interface ProjectDetail {
  id: string;
  name: string;
  objective: string | null;
  status: string;
  myRole: string;
  _count: Record<string, number>;
}

const TABS = [
  { key: 'Overview', icon: IconRadar },
  { key: 'Search', icon: IconSearch },
  { key: 'Evidence', icon: IconDatabase },
  { key: 'Entities', icon: IconUsers },
  { key: 'Claims', icon: IconShield },
  { key: 'Timeline', icon: IconClock },
  { key: 'Connections', icon: IconLink },
  { key: 'Media', icon: IconImage },
  { key: 'Documents', icon: IconFileText },
  { key: 'Monitoring', icon: IconRadar },
  { key: 'Analyst', icon: IconSparkle },
  { key: 'Audit', icon: IconSettings },
] as const;
type Tab = (typeof TABS)[number]['key'];

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

  if (loading) return <Spinner size="md" label="Loading investigation…" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!project) return null;

  const canEdit = project.myRole === 'OWNER' || project.myRole === 'EDITOR';

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 flex items-center gap-1 text-xs text-slate-600">
          <Link href="/investigations" className="hover:text-slate-400">
            Investigations
          </Link>
          <IconChevronRight className="h-3 w-3" />
          <span className="text-slate-500">{project.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">{project.name}</h1>
          <Badge dot tone={project.status === 'ACTIVE' ? 'green' : project.status === 'PAUSED' ? 'amber' : 'neutral'}>
            {project.status}
          </Badge>
          <span className="text-xs text-slate-500">{project.myRole.toLowerCase()}</span>
          {canEdit && (
            <button className="btn-ghost ml-auto py-1 text-xs" onClick={toggleStatus} disabled={busy}>
              {project.status === 'ACTIVE' ? 'Pause' : 'Resume'}
            </button>
          )}
        </div>
        {project.objective && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-500">{project.objective}</p>}
      </div>

      <div className="relative -mx-1 border-b border-ink-800">
        <div className="scrollbar-none flex gap-0.5 overflow-x-auto px-1">
          {TABS.map(({ key, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`group -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                  active ? 'border-accent text-slate-100' : 'border-transparent text-slate-500 hover:border-ink-700 hover:text-slate-300'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${active ? 'text-accent-bright' : 'text-slate-600 group-hover:text-slate-500'}`} />
                {key}
              </button>
            );
          })}
        </div>
        <div className="pointer-events-none absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-ink-950 to-transparent" />
      </div>

      <div className="animate-in" key={tab}>
        {tab === 'Overview' && <Overview projectId={id} />}
        {tab === 'Search' && <SearchTab projectId={id} canEdit={canEdit} projectActive={project.status === 'ACTIVE'} />}
        {tab === 'Evidence' && <EvidenceTab projectId={id} canEdit={canEdit} />}
        {tab === 'Entities' && <EntitiesTab projectId={id} canEdit={canEdit} />}
        {tab === 'Claims' && <ClaimsTab projectId={id} canEdit={canEdit} />}
        {tab === 'Timeline' && <TimelineTab projectId={id} />}
        {tab === 'Connections' && <ConnectionsTab projectId={id} />}
        {tab === 'Media' && <MediaTab projectId={id} canEdit={canEdit} />}
        {tab === 'Documents' && <DocumentsTab projectId={id} canEdit={canEdit} />}
        {tab === 'Monitoring' && <MonitoringTab projectId={id} canEdit={canEdit} />}
        {tab === 'Analyst' && <AnalystTab projectId={id} canEdit={canEdit} />}
        {tab === 'Audit' && <AuditTab projectId={id} />}
      </div>
    </div>
  );
}
