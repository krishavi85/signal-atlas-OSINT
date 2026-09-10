'use client';

import { useState } from 'react';
import { api, tokenStore } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface AiStatus {
  chat: { available: boolean; provider: string; models: { synth: string | null }; reason?: string; setup?: string };
  embeddings: { available: boolean };
  budget: { monthlyUsd: number; spentThisMonthUsd: number; tokensThisMonth: number };
}

interface Analysis {
  id: string;
  kind: string;
  question: string | null;
  provider: string;
  model: string;
  outputText: string;
  outputJson: any;
  citedEvidenceIds: string[];
  ungroundedStatements: string[];
  createdAt: string;
  evidence?: Array<{ id: string; title: string | null; url: string | null; sourcePlatform: string }>;
}

export function AnalystTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const status = useApi<AiStatus>('/ai/status');
  const analyses = useApi<Analysis[]>(`/projects/${projectId}/ai/analyses?kind=SUMMARY`);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const aiUnavailable = Boolean(status.data && !status.data.chat.available);

  async function ask() {
    if (!question.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<Analysis & { available?: boolean; reason?: string }>(`/projects/${projectId}/ai/ask`, {
        method: 'POST',
        body: JSON.stringify({ question }),
      });
      if ('available' in res && res.available === false) {
        setErr(res.reason ?? 'AI unavailable');
      } else {
        setOpenId(res.id);
        await analyses.reload();
        setQuestion('');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {status.loading ? (
        <Spinner />
      ) : status.error ? (
        <ErrorState error={status.error} />
      ) : (
        <div className="card p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-300">AI research analyst</span>
            <Badge tone={status.data?.chat.available ? 'green' : 'amber'}>
              {status.data?.chat.available ? `${status.data.chat.provider} · ${status.data.chat.models.synth}` : 'not configured'}
            </Badge>
            <Badge tone={status.data?.embeddings.available ? 'green' : 'neutral'}>
              embeddings {status.data?.embeddings.available ? 'on' : 'off'}
            </Badge>
            {status.data && status.data.budget.monthlyUsd > 0 && (
              <span className="text-slate-500">
                budget ${status.data.budget.spentThisMonthUsd.toFixed(2)} / ${status.data.budget.monthlyUsd}
              </span>
            )}
          </div>
          {aiUnavailable && (
            <p className="mt-1 text-amber-400">
              {status.data?.chat.reason} {status.data?.chat.setup} — reports still generate deterministically from the
              evidence; only the AI narrative is skipped (§51).
            </p>
          )}
        </div>
      )}

      {/* Ask the evidence */}
      <section className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Ask the evidence (§13, §14)</h3>
        <p className="mt-1 text-xs text-slate-500">
          The model answers only from cited evidence blocks. Every factual sentence is checked against its citations;
          anything it can&apos;t ground is flagged, not shown as fact.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder="e.g. What do the sources say about the company's funding and leadership?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={!canEdit || aiUnavailable}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
          />
          <button className="btn-primary" onClick={ask} disabled={!canEdit || aiUnavailable || busy || !question.trim()}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
      </section>

      {/* History */}
      {analyses.loading ? (
        <Spinner />
      ) : analyses.data && analyses.data.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-200">Previous answers</h3>
          {analyses.data.map((a) => (
            <div key={a.id} className="card p-3 text-sm">
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                <Badge>{a.model}</Badge>
                <span className="text-slate-200">{a.question}</span>
                <span className="ml-auto text-[11px] text-slate-600">
                  {a.citedEvidenceIds.length} cited{a.ungroundedStatements.length > 0 ? ` · ${a.ungroundedStatements.length} flagged` : ''}
                </span>
              </button>
              {openId === a.id && <AnswerDetail analysisId={a.id} />}
            </div>
          ))}
        </div>
      ) : (
        !aiUnavailable && <EmptyState title="No questions asked yet" />
      )}

      {/* Reports */}
      <ReportsSection projectId={projectId} canEdit={canEdit} />
    </div>
  );
}

function AnswerDetail({ analysisId }: { analysisId: string }) {
  const { data, loading } = useApi<Analysis>(`/ai-analyses/${analysisId}`, [analysisId]);
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <div className="mt-3 space-y-3 border-t border-ink-800 pt-3">
      <pre className="whitespace-pre-wrap font-sans text-sm text-slate-300">{data.outputText}</pre>
      {data.ungroundedStatements.length > 0 && (
        <div className="rounded border border-amber-900 bg-amber-950/20 p-2 text-xs text-amber-300">
          <p className="font-semibold">Not evidence-grounded — do not treat as fact (§14):</p>
          <ul className="mt-1 list-inside list-disc">
            {data.ungroundedStatements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {data.evidence && data.evidence.length > 0 && (
        <div className="text-xs">
          <p className="mb-1 font-semibold text-slate-400">Cited evidence</p>
          <ul className="space-y-0.5">
            {data.evidence.map((e) => (
              <li key={e.id} className="truncate">
                <span className="font-mono text-[10px] text-slate-600">{e.id}</span>{' '}
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {e.title ?? e.url}
                  </a>
                ) : (
                  <span className="text-slate-400">{e.title}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReportsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data, loading, reload } = useApi<
    Array<{ id: string; title: string; format: string; status: string; error: string | null; createdAt: string; completedAt: string | null; checksum: string | null }>
  >(`/projects/${projectId}/reports`);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      await api(`/projects/${projectId}/reports`, { method: 'POST', body: JSON.stringify({}) });
      setTimeout(() => void reload(), 2000);
      setTimeout(() => void reload(), 6000);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Reports (§28)</h3>
          <p className="text-xs text-slate-500">
            Evidence-cited assembly of scope, methodology, coverage, entities, timeline, claims, contradictions, source
            assessment, and limitations. AI narrative sections are added when a provider is configured.
          </p>
        </div>
        {canEdit && (
          <button className="btn-primary" onClick={generate} disabled={busy}>
            {busy ? 'Queued…' : 'Generate report'}
          </button>
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        {loading ? (
          <Spinner />
        ) : !data || data.length === 0 ? (
          <p className="text-xs text-slate-600">No reports generated yet.</p>
        ) : (
          data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 p-2 text-sm">
              <Badge tone={r.status === 'COMPLETED' ? 'green' : r.status === 'FAILED' ? 'red' : 'amber'}>{r.status}</Badge>
              <span className="text-slate-200">{r.title}</span>
              <span className="text-[11px] text-slate-600">{new Date(r.createdAt).toLocaleString()}</span>
              {r.checksum && <span className="font-mono text-[10px] text-slate-600">sha256:{r.checksum.slice(0, 12)}</span>}
              {r.status === 'COMPLETED' && (
                <span className="ml-auto flex gap-2 text-xs">
                  {(['md', 'html', 'json'] as const).map((f) => (
                    <a
                      key={f}
                      className="text-accent hover:underline"
                      href={`/api/v1/reports/${r.id}/export?format=${f}`}
                      onClick={(e) => {
                        // attach auth by opening via fetch->blob since export needs the header
                        e.preventDefault();
                        void downloadWithAuth(`/api/v1/reports/${r.id}/export?format=${f}`, `report.${f}`);
                      }}
                    >
                      {f}
                    </a>
                  ))}
                </span>
              )}
              {r.error && <span className="w-full text-xs text-red-400">{r.error}</span>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

async function downloadWithAuth(url: string, filename: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${tokenStore.access}` } });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
