'use client';

import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface AuditRow {
  id: string;
  action: string;
  actorLabel: string;
  summary: string;
  createdAt: string;
  actor: { email: string; displayName: string } | null;
  metadataJson: Record<string, unknown> | null;
}

export function AuditTab({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useApi<{ items: AuditRow[]; nextCursor: string | null }>(
    `/projects/${projectId}/audit?limit=150`,
  );
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data || data.items.length === 0) return <EmptyState title="No audit entries" />;

  return (
    <div className="space-y-1">
      <p className="mb-2 text-xs text-slate-500">
        Append-only record of every search, connector call, evidence change, entity merge and AI analysis (§29).
      </p>
      {data.items.map((a) => (
        <div key={a.id} className="card flex items-start gap-3 p-2.5 text-sm">
          <span className="whitespace-nowrap text-[11px] text-slate-600">{new Date(a.createdAt).toLocaleString()}</span>
          <Badge>{a.action}</Badge>
          <span className="text-slate-300">{a.summary}</span>
          <span className="ml-auto whitespace-nowrap text-[11px] text-slate-600">{a.actor?.email ?? a.actorLabel}</span>
        </div>
      ))}
    </div>
  );
}
