'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface TLEvent {
  id: string;
  occurredAt: string;
  precision: string;
  title: string;
  description: string | null;
  eventType: string;
  confidenceLevel: string;
  evidence: { id: string; url: string | null; sourcePlatform: string } | null;
}

const RANGES: Record<string, number | null> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
  '5y': 365 * 5,
  All: null,
};

export function TimelineTab({ projectId }: { projectId: string }) {
  const [range, setRange] = useState<keyof typeof RANGES>('All');
  const [eventType, setEventType] = useState('');
  const days = RANGES[range];
  const after = days ? new Date(Date.now() - days * 86400000).toISOString() : undefined;
  const qs = new URLSearchParams({ limit: '800' });
  if (after) qs.set('after', after);
  if (eventType) qs.set('eventType', eventType);

  const { data, error, loading, reload } = useApi<{
    events: TLEvent[];
    byType: Record<string, number>;
    span: { first: string; last: string } | null;
  }>(`/projects/${projectId}/timeline?${qs}`, [range, eventType]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md bg-ink-950 p-1 text-xs">
          {Object.keys(RANGES).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r as keyof typeof RANGES)}
              className={`rounded px-2 py-1 ${range === r ? 'bg-ink-800 text-slate-100' : 'text-slate-500'}`}
            >
              {r}
            </button>
          ))}
        </div>
        <select className="input w-44" value={eventType} onChange={(e) => setEventType(e.target.value)}>
          <option value="">All event types</option>
          {Object.keys(data?.byType ?? {}).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {data?.span && (
          <span className="text-xs text-slate-500">
            {new Date(data.span.first).toLocaleDateString()} → {new Date(data.span.last).toLocaleDateString()}
          </span>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.events.length === 0 ? (
        <EmptyState title="No dated events" hint="Timeline events come from evidence publication dates and dated claims." />
      ) : (
        <ol className="relative border-l border-ink-700 pl-5">
          {data.events.map((e) => (
            <li key={e.id} className="mb-4">
              <span className="absolute -left-[6.5px] mt-1.5 h-3 w-3 rounded-full border-2 border-ink-950 bg-accent" />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-slate-500">
                  {e.precision === 'YEAR' ? e.occurredAt.slice(0, 4) : e.occurredAt.slice(0, 10)}
                </span>
                <Badge tone="blue">{e.eventType}</Badge>
                <span className="text-slate-200">{e.title}</span>
                {e.evidence?.url && (
                  <a href={e.evidence.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline">
                    {e.evidence.id}
                  </a>
                )}
              </div>
              {e.description && <p className="mt-0.5 text-xs text-slate-500">{e.description}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
