'use client';

import { useApi } from '@/lib/useApi';
import { Badge, ErrorState, PageHeader, Spinner } from '@/components/ui';
import { IconCheckCircle, IconClock, IconDatabase, IconShield, IconSparkle } from '@/components/icons';

interface Manifest {
  connectors: string[];
  ai: { provider: string; embeddings: string };
  jobDriver: string;
  notImplemented: string[];
  implemented?: string[];
}

export default function SystemPage() {
  const manifest = useApi<Manifest>('/manifest');
  const ready = useApi<{ status: string; db: string; connectors: number }>('/readyz');

  if (manifest.loading || ready.loading) return <Spinner size="md" />;
  if (manifest.error) return <ErrorState error={manifest.error} retry={manifest.reload} />;

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="System" description="Runtime configuration and an honest capability inventory — nothing here is dressed up." />

      <section className="card p-4">
        <div className="panel-header mb-3">
          <IconDatabase className="h-4 w-4 text-slate-500" />
          <h2 className="section-title">Runtime</h2>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-500">Database</dt>
          <dd className="text-slate-300">
            <Badge dot tone={ready.data?.db === 'ok' ? 'green' : 'red'}>{ready.data?.db ?? 'unknown'}</Badge>{' '}
            <span className="text-slate-500">SQLite — swap to PostgreSQL for production</span>
          </dd>
          <dt className="text-slate-500">Job driver</dt>
          <dd className="text-slate-300">
            {manifest.data?.jobDriver} <span className="text-slate-500">(in-process; Redis/BullMQ adapter is an interface only)</span>
          </dd>
          <dt className="text-slate-500">AI provider</dt>
          <dd className="text-slate-300">
            <Badge dot tone={manifest.data?.ai.provider === 'none' ? 'amber' : 'green'}>{manifest.data?.ai.provider}</Badge>
            {manifest.data?.ai.provider === 'none' && <span className="text-slate-500"> — heuristic extraction only; no synthesis / semantic search</span>}
          </dd>
          <dt className="text-slate-500">Embeddings</dt>
          <dd className="text-slate-300">{manifest.data?.ai.embeddings}</dd>
          <dt className="text-slate-500">Connectors loaded</dt>
          <dd className="text-slate-300">{manifest.data?.connectors.length}</dd>
        </dl>
      </section>

      {manifest.data?.implemented && manifest.data.implemented.length > 0 && (
        <section className="card p-4">
          <div className="panel-header mb-3">
            <IconCheckCircle className="h-4 w-4 text-emerald-500" />
            <h2 className="section-title">Implemented capabilities</h2>
          </div>
          <ul className="space-y-2 text-sm text-slate-400">
            {manifest.data.implemented.map((x) => (
              <li key={x} className="flex items-start gap-2">
                <IconCheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span className="leading-relaxed">{x}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-4">
        <div className="panel-header mb-3">
          <IconClock className="h-4 w-4 text-amber-500" />
          <h2 className="section-title">Not yet implemented (honest status — §51)</h2>
        </div>
        <ul className="space-y-1.5 text-sm text-slate-400">
          {manifest.data?.notImplemented.map((x) => (
            <li key={x} className="flex items-start gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-600" />
              <span className="leading-relaxed">{x}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-ink-800 pt-3 text-xs text-slate-600">
          See <span className="kbd">ROADMAP.md</span> for the full phase plan and the environment blockers (no PostgreSQL / Redis / AI
          keys in this deployment).
        </p>
      </section>

      <section className="card p-4">
        <div className="panel-header mb-3">
          <IconShield className="h-4 w-4 text-slate-500" />
          <h2 className="section-title">Legal &amp; privacy posture (§30)</h2>
        </div>
        <ul className="space-y-1.5 text-sm text-slate-400">
          {[
            'Official APIs and public endpoints only — no scraping of authenticated or access-controlled surfaces.',
            'No CAPTCHA solving, no anti-bot evasion, no credential handling for third-party sites.',
            'No covert biometric identification; no ingestion of leaked personal databases.',
            'SSRF-guarded outbound fetches; robots.txt respected for direct page retrieval.',
            'Per-project data retention windows and evidence deletion (audit-logged).',
          ].map((x) => (
            <li key={x} className="flex items-start gap-2">
              <IconSparkle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-600" />
              <span className="leading-relaxed">{x}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
