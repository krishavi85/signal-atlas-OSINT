'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { Badge, EmptyState, ErrorState, LatencySparkline, PageHeader, Spinner, healthTone } from '@/components/ui';
import { IconAlertTriangle, IconChevronDown, IconPlug } from '@/components/icons';

interface ConnectorRow {
  connectorId: string;
  displayName: string;
  category: string;
  declared: Record<string, boolean>;
  effective: Record<string, boolean>;
  gaps: Array<{ capability: string; code: string; message: string; requiredConfig?: string[]; docs?: string }>;
  enabled: boolean;
  hasStoredCredentials: boolean;
  rateLimit: { limit: number | null; remaining: number | null; retryAfterMs: number };
  health: { state: string; latencyMs: number | null; message: string; checkedAt: string; lastError: string | null } | null;
}

interface HealthHistoryRow {
  state: string;
  latencyMs: number | null;
  checkedAt: string;
  lastError: string | null;
}

interface ConnectorDetail {
  healthHistory: HealthHistoryRow[];
}

const CAP_LABELS: Record<string, string> = {
  SEARCH_SUPPORTED: 'Search',
  FETCH_SUPPORTED: 'Fetch',
  MONITORING_SUPPORTED: 'Monitoring',
  HISTORICAL_SEARCH_SUPPORTED: 'Historical',
  PUBLIC_PROFILE_SUPPORTED: 'Profiles',
  POST_SEARCH_SUPPORTED: 'Posts',
  MEDIA_SUPPORTED: 'Media',
  BOOLEAN_QUERY_SUPPORTED: 'Boolean',
  DATE_FILTER_SUPPORTED: 'Date filter',
  LANGUAGE_FILTER_SUPPORTED: 'Language',
  AUTH_REQUIRED: 'Auth req.',
  RATE_LIMITED: 'Rate limited',
};

export default function ConnectorsPage() {
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi<ConnectorRow[]>('/connectors');
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: detail, loading: detailLoading } = useApi<ConnectorDetail>(
    expanded ? `/connectors/${expanded}` : null,
    [expanded],
  );

  async function healthCheck(id: string) {
    setBusy(id);
    try {
      await api(`/connectors/${id}/health-check`, { method: 'POST' });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner size="md" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  const byCategory = data.reduce<Record<string, ConnectorRow[]>>((acc, c) => {
    (acc[c.category] ??= []).push(c);
    return acc;
  }, {});
  const onlineCount = data.filter((c) => c.health?.state === 'ONLINE').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connectors"
        description="Capability registry (§31) and health (§32). Unavailable operations are shown honestly with the exact missing dependency — nothing returns fabricated data."
        actions={
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <IconPlug className="h-3.5 w-3.5" />
            {onlineCount}/{data.length} online
          </span>
        }
      />

      {Object.entries(byCategory).map(([cat, rows]) => (
        <section key={cat} className="space-y-2">
          <h2 className="eyebrow">{cat}</h2>
          {rows.map((c) => (
            <div key={c.connectorId} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge dot tone={healthTone(c.health?.state)}>
                  {c.health?.state ?? 'UNKNOWN'}
                </Badge>
                <span className="font-medium text-slate-100">{c.displayName}</span>
                <code className="mono-id">{c.connectorId}</code>
                {c.health?.latencyMs != null && <span className="text-[11px] text-slate-600">{c.health.latencyMs}ms</span>}
                {c.hasStoredCredentials && <Badge tone="blue">credentials stored</Badge>}
                <button
                  className="btn-ghost ml-auto py-1 text-xs"
                  disabled={busy === c.connectorId}
                  onClick={() => healthCheck(c.connectorId)}
                >
                  {busy === c.connectorId ? 'Checking…' : 'Health check'}
                </button>
                <button
                  className="btn-ghost flex items-center gap-1 py-1 text-xs"
                  onClick={() => setExpanded(expanded === c.connectorId ? null : c.connectorId)}
                >
                  <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded === c.connectorId ? 'rotate-180' : ''}`} />
                  History
                </button>
              </div>

              {c.health?.message && <p className="mt-1.5 text-xs text-slate-500">{c.health.message}</p>}

              <div className="mt-2.5 flex flex-wrap gap-1">
                {Object.keys(CAP_LABELS).map((cap) => {
                  const declared = c.declared[cap];
                  const effective = c.effective[cap];
                  if (!declared) return null;
                  return (
                    <Badge key={cap} tone={effective ? 'green' : 'neutral'}>
                      {CAP_LABELS[cap]} {effective ? '✓' : '—'}
                    </Badge>
                  );
                })}
              </div>

              {c.gaps.length > 0 && (
                <ul className="mt-2.5 space-y-1.5 text-xs">
                  {c.gaps.map((g, i) => (
                    <li key={i} className="flex items-start gap-1.5 rounded-lg border border-amber-900/50 bg-amber-950/20 p-2.5 text-amber-300">
                      <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span>
                        <span className="mr-1 font-mono text-[10px] text-amber-500">{g.code}</span>
                        {g.message}
                        {g.requiredConfig && (
                          <span className="mt-0.5 block text-amber-500/90">
                            Set: {g.requiredConfig.join(', ')}
                            {me?.role === 'ADMIN' && ' (via PUT /api/v1/connectors/' + c.connectorId + '/credentials)'}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {expanded === c.connectorId && (
                <div className="mt-3 border-t border-ink-800 pt-3">
                  {detailLoading && <Spinner label="Loading history…" />}
                  {!detailLoading && detail && detail.healthHistory.length === 0 && (
                    <p className="text-xs text-slate-600">No health checks recorded yet.</p>
                  )}
                  {!detailLoading && detail && detail.healthHistory.length > 0 && (
                    <>
                      <p className="eyebrow mb-1.5">
                        Latency, last {detail.healthHistory.length} checks (oldest → newest)
                      </p>
                      <LatencySparkline points={[...detail.healthHistory].reverse()} />
                      {detail.healthHistory.some((h) => h.lastError) && (
                        <ul className="mt-2.5 space-y-1 text-xs text-slate-500">
                          {detail.healthHistory
                            .filter((h) => h.lastError)
                            .slice(0, 5)
                            .map((h, i) => (
                              <li key={i} className="truncate">
                                <span className="text-slate-600">{new Date(h.checkedAt).toLocaleString()}</span>{' '}
                                <span className="text-red-400/90">{h.lastError}</span>
                              </li>
                            ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {data.length === 0 && <EmptyState title="No connectors registered" />}
    </div>
  );
}
