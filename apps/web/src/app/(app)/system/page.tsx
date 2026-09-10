'use client';

import { useApi } from '@/lib/useApi';
import { Badge, ErrorState, Spinner } from '@/components/ui';

interface Manifest {
  connectors: string[];
  ai: { provider: string; embeddings: string };
  jobDriver: string;
  notImplemented: string[];
}

export default function SystemPage() {
  const manifest = useApi<Manifest>('/manifest');
  const ready = useApi<{ status: string; db: string; connectors: number }>('/readyz');

  if (manifest.loading || ready.loading) return <Spinner />;
  if (manifest.error) return <ErrorState error={manifest.error} retry={manifest.reload} />;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold text-slate-100">System</h1>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Runtime</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Database</dt>
          <dd className="text-slate-300">
            <Badge tone={ready.data?.db === 'ok' ? 'green' : 'red'}>{ready.data?.db ?? 'unknown'}</Badge> (SQLite — swap to
            PostgreSQL for production)
          </dd>
          <dt className="text-slate-500">Job driver</dt>
          <dd className="text-slate-300">{manifest.data?.jobDriver} (in-process; Redis/BullMQ adapter is an interface only)</dd>
          <dt className="text-slate-500">AI provider</dt>
          <dd className="text-slate-300">
            <Badge tone={manifest.data?.ai.provider === 'none' ? 'amber' : 'green'}>{manifest.data?.ai.provider}</Badge>
            {manifest.data?.ai.provider === 'none' && ' — heuristic extraction only; no synthesis / semantic search'}
          </dd>
          <dt className="text-slate-500">Embeddings</dt>
          <dd className="text-slate-300">{manifest.data?.ai.embeddings}</dd>
          <dt className="text-slate-500">Connectors loaded</dt>
          <dd className="text-slate-300">{manifest.data?.connectors.length}</dd>
        </dl>
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Not yet implemented (honest status — §51)</h2>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          {manifest.data?.notImplemented.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-600">
          See <code>ROADMAP.md</code> for the full phase plan and the environment blockers (no PostgreSQL / Redis / AI
          keys in this deployment).
        </p>
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Legal &amp; privacy posture (§30)</h2>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Official APIs and public endpoints only — no scraping of authenticated or access-controlled surfaces.</li>
          <li>No CAPTCHA solving, no anti-bot evasion, no credential handling for third-party sites.</li>
          <li>No covert biometric identification; no ingestion of leaked personal databases.</li>
          <li>SSRF-guarded outbound fetches; robots.txt respected for direct page retrieval.</li>
          <li>Per-project data retention windows and evidence deletion (audit-logged).</li>
        </ul>
      </section>
    </div>
  );
}
