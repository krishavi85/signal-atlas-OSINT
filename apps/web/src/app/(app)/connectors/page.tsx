'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { Badge, EmptyState, ErrorState, Spinner, healthTone } from '@/components/ui';

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

  async function healthCheck(id: string) {
    setBusy(id);
    try {
      await api(`/connectors/${id}/health-check`, { method: 'POST' });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  const byCategory = data.reduce<Record<string, ConnectorRow[]>>((acc, c) => {
    (acc[c.category] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Connectors</h1>
        <p className="text-xs text-slate-500">
          Capability registry (§31) and health (§32). Unavailable operations are shown honestly with the exact missing
          dependency — nothing returns fabricated data.
        </p>
      </div>

      {Object.entries(byCategory).map(([cat, rows]) => (
        <section key={cat} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</h2>
          {rows.map((c) => (
            <div key={c.connectorId} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-100">{c.displayName}</span>
                <code className="text-[11px] text-slate-600">{c.connectorId}</code>
                <Badge tone={healthTone(c.health?.state)}>{c.health?.state ?? 'UNKNOWN'}</Badge>
                {c.health?.latencyMs != null && <span className="text-[11px] text-slate-600">{c.health.latencyMs}ms</span>}
                {c.hasStoredCredentials && <Badge tone="blue">credentials stored</Badge>}
                <button
                  className="btn-ghost ml-auto py-1 text-xs"
                  disabled={busy === c.connectorId}
                  onClick={() => healthCheck(c.connectorId)}
                >
                  {busy === c.connectorId ? 'Checking…' : 'Health check'}
                </button>
              </div>

              {c.health?.message && <p className="mt-1 text-xs text-slate-500">{c.health.message}</p>}

              <div className="mt-2 flex flex-wrap gap-1">
                {Object.keys(CAP_LABELS).map((cap) => {
                  const declared = c.declared[cap];
                  const effective = c.effective[cap];
                  if (!declared) return null;
                  return (
                    <Badge key={cap} tone={effective ? 'green' : 'red'}>
                      {CAP_LABELS[cap]} {effective ? '✓' : '✕'}
                    </Badge>
                  );
                })}
              </div>

              {c.gaps.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {c.gaps.map((g, i) => (
                    <li key={i} className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-amber-300">
                      <span className="font-mono text-[10px] text-amber-500">{g.code}</span> {g.message}
                      {g.requiredConfig && (
                        <span className="mt-0.5 block text-amber-500">
                          Set: {g.requiredConfig.join(', ')}
                          {me?.role === 'ADMIN' && ' (via PUT /api/v1/connectors/' + c.connectorId + '/credentials)'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ))}
      {data.length === 0 && <EmptyState title="No connectors registered" />}
    </div>
  );
}
