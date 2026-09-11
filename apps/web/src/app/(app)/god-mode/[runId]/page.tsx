'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, ErrorState, Spinner, confidenceTone } from '@/components/ui';
import { IconArrowRight, IconZap } from '@/components/icons';

interface GodModeRun {
  id: string;
  projectId: string;
  target: string;
  depth: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  error: string | null;
  reportId: string | null;
  searchIds: string[] | null;
  createdAt: string;
  completedAt: string | null;
  resultJson: GodModeResult | null;
}

interface GodModeResult {
  target: string;
  generatedAt: string;
  executiveSummary: { text: string; aiGenerated: boolean };
  keyFindings: Array<{ text: string; epistemicTag: string; confidenceLevel: string }>;
  verifiedFindings: Array<{ text: string; confidenceLevel: string; evidenceCount: number }>;
  unverifiedFindings: Array<{ text: string; corroboration: string }>;
  importantEntities: Array<{ type: string; name: string; evidenceCount: number; resolutionConfidence: string }>;
  connectionGraph: { nodeCount: number; edgeCount: number; topEdges: Array<{ from: string; type: string; to: string; evidenceCount: number }> };
  timeline: Array<{ occurredAt: string; eventType: string; title: string }>;
  claims: { total: number; items: Array<{ text: string; corroboration: string; confidenceLevel: string; epistemicTag: string }> };
  contradictions: Array<{ explanation: string; status: string }>;
  sourceCoverage: Array<{ connectorId: string; state: string; hits: number; note?: string }>;
  evidence: { total: number; duplicatesSuppressed: number; sample: Array<{ id: string; title: string | null; url: string | null; platform: string }> };
  informationGaps: string[];
  confidenceAssessment: { distribution: Record<string, number>; note: string };
  recommendedNextSearches: Array<{ query: string; rationale: string; aiGenerated: boolean }>;
  monitoringRecommendations: Array<{ name: string; query: string; schedule: string; connectorIds: string[] | null; rationale: string }>;
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card animate-in p-4">
      <h2 className="section-title">{title}</h2>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export default function GodModeResultPage() {
  const { runId } = useParams<{ runId: string }>();
  const { data, error, loading, reload } = useApi<GodModeRun>(`/god-mode/${runId}`, [runId]);
  const [creatingMonitor, setCreatingMonitor] = useState<number | null>(null);

  const inFlight = data?.status === 'QUEUED' || data?.status === 'RUNNING';
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [inFlight, reload]);

  if (loading && !data) return <Spinner label="Loading God Mode run…" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return null;

  const r = data.resultJson;

  return (
    <div className="mx-auto max-w-4xl animate-in space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-signal-cyan text-ink-975 shadow-glow">
          <IconZap className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-slate-100">{data.target}</h1>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Badge dot tone={data.status === 'COMPLETED' ? 'green' : data.status === 'PARTIAL' ? 'amber' : data.status === 'FAILED' ? 'red' : 'blue'}>
              {data.status}
            </Badge>
            <Badge>{data.depth}</Badge>
          </div>
        </div>
        <Link
          href={`/investigations/${data.projectId}`}
          className="ml-auto flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-bright"
        >
          Open investigation <IconArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {inFlight && (
        <div className="card p-4">
          <Spinner size="md" label="Running the full pipeline: search → evidence → entities → claims → correlation → timeline → report…" />
          <p className="mt-2 text-xs text-slate-500">This composes every engine end to end; DEEP mode can take a few minutes.</p>
        </div>
      )}

      {data.status === 'FAILED' && <ErrorState error={new Error(data.error ?? 'God Mode run failed')} retry={reload} />}

      {r && (
        <>
          <Section title="Executive Intelligence Summary">
            <p className="whitespace-pre-wrap text-sm text-slate-300">{r.executiveSummary.text}</p>
            {!r.executiveSummary.aiGenerated && (
              <p className="mt-2 text-[11px] text-amber-400">Deterministic summary — no AI provider configured (§51: never fabricated).</p>
            )}
          </Section>

          <Section title="Key Findings" sub={`${r.keyFindings.length} top claim(s) by confidence`}>
            {r.keyFindings.length === 0 ? (
              <p className="text-xs text-slate-600">None extracted — see Information Gaps.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {r.keyFindings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge tone={f.epistemicTag === 'FACT' ? 'green' : 'neutral'}>{f.epistemicTag}</Badge>
                    <span className="text-slate-300">{f.text}</span>
                    <Badge tone={confidenceTone(f.confidenceLevel)}>{f.confidenceLevel}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <div className="grid gap-4 sm:grid-cols-2">
            <Section title="Verified Findings" sub={`${r.verifiedFindings.length} independently corroborated / FACT-tagged`}>
              {r.verifiedFindings.length === 0 ? (
                <p className="text-xs text-slate-600">None yet.</p>
              ) : (
                <ul className="space-y-1 text-xs text-slate-300">
                  {r.verifiedFindings.map((f, i) => (
                    <li key={i}>
                      {f.text} <span className="text-slate-600">({f.evidenceCount} evidence)</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Unverified Findings" sub={`${r.unverifiedFindings.length} single-source or unverified`}>
              {r.unverifiedFindings.length === 0 ? (
                <p className="text-xs text-slate-600">None.</p>
              ) : (
                <ul className="space-y-1 text-xs text-slate-400">
                  {r.unverifiedFindings.map((f, i) => (
                    <li key={i}>
                      {f.text} <Badge tone="amber">{f.corroboration}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section title="Important Entities" sub={`${r.importantEntities.length} most-referenced`}>
            <ul className="flex flex-wrap gap-1.5">
              {r.importantEntities.map((e, i) => (
                <li key={i}>
                  <Badge tone="violet">
                    {e.type}: {e.name} ({e.evidenceCount})
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Connection Graph" sub={`${r.connectionGraph.nodeCount} entities, ${r.connectionGraph.edgeCount} evidence-traceable edges`}>
            {r.connectionGraph.topEdges.length === 0 ? (
              <p className="text-xs text-slate-600">No relationships yet.</p>
            ) : (
              <ul className="space-y-0.5 text-xs text-slate-400">
                {r.connectionGraph.topEdges.map((e, i) => (
                  <li key={i}>
                    {e.from} <span className="text-slate-600">— {e.type} —</span> {e.to}{' '}
                    <span className="text-slate-600">({e.evidenceCount} ev)</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/investigations/${data.projectId}`} className="mt-2 inline-block text-[11px] text-accent hover:underline">
              view full graph →
            </Link>
          </Section>

          <Section title="Timeline" sub={`${r.timeline.length} most recent dated events`}>
            {r.timeline.length === 0 ? (
              <p className="text-xs text-slate-600">No dated events derived.</p>
            ) : (
              <ol className="space-y-1 text-xs text-slate-400">
                {r.timeline.map((t, i) => (
                  <li key={i}>
                    <span className="font-mono text-slate-600">{t.occurredAt.slice(0, 10)}</span> <Badge>{t.eventType}</Badge> {t.title}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Claims" sub={`${r.claims.total} total`}>
            {r.claims.items.length === 0 ? (
              <p className="text-xs text-slate-600">None extracted.</p>
            ) : (
              <ul className="space-y-1 text-xs text-slate-300">
                {r.claims.items.slice(0, 20).map((c, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <Badge tone={confidenceTone(c.confidenceLevel)}>{c.confidenceLevel}</Badge>
                    <Badge>{c.corroboration}</Badge>
                    {c.text}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Contradictions" sub={`${r.contradictions.length} open — never auto-resolved`}>
            {r.contradictions.length === 0 ? (
              <p className="text-xs text-slate-600">None detected.</p>
            ) : (
              <ul className="space-y-1 text-xs text-red-300">
                {r.contradictions.map((c, i) => (
                  <li key={i}>{c.explanation}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Source Coverage" sub="what actually ran, so silence never reads as absence">
            <ul className="flex flex-wrap gap-1.5">
              {r.sourceCoverage.map((c, i) => (
                <li key={i} title={c.note}>
                  <Badge tone={c.state === 'COMPLETED' ? 'green' : c.state === 'PARTIAL' ? 'amber' : c.state === 'NOT_RUN' ? 'neutral' : 'red'}>
                    {c.connectorId}: {c.state} ({c.hits})
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Evidence" sub={`${r.evidence.total} unique · ${r.evidence.duplicatesSuppressed} duplicate/syndicated suppressed`}>
            <ul className="space-y-0.5 text-xs text-slate-400">
              {r.evidence.sample.map((e, i) => (
                <li key={i} className="truncate">
                  <span className="font-mono text-[10px] text-slate-600">{e.id}</span> <Badge tone="blue">{e.platform}</Badge>{' '}
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {e.title ?? e.url}
                    </a>
                  ) : (
                    e.title
                  )}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Information Gaps" sub="what was NOT found — absence stated explicitly, never implied">
            <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-300">
              {r.informationGaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </Section>

          <Section title="Confidence Assessment">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(r.confidenceAssessment.distribution).map(([level, count]) => (
                <Badge key={level} tone={confidenceTone(level)}>
                  {level}: {count}
                </Badge>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">{r.confidenceAssessment.note}</p>
          </Section>

          <Section title="Recommended Next Searches">
            <ul className="space-y-1 text-xs">
              {r.recommendedNextSearches.map((s, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <Badge tone={s.aiGenerated ? 'violet' : 'neutral'}>{s.aiGenerated ? 'AI' : 'heuristic'}</Badge>
                  <code className="text-slate-200">{s.query}</code>
                  <span className="text-slate-600">— {s.rationale}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Monitoring Recommendations" sub="never auto-created — one click to set up">
            <ul className="space-y-2 text-xs">
              {r.monitoringRecommendations.map((m, i) => (
                <li key={i} className="flex items-center gap-2 rounded border border-ink-800 p-2">
                  <span className="text-slate-200">{m.name}</span>
                  <span className="text-slate-500">{m.schedule.toLowerCase()}</span>
                  <button
                    className="btn-ghost ml-auto py-0.5"
                    disabled={creatingMonitor === i}
                    onClick={async () => {
                      setCreatingMonitor(i);
                      try {
                        await api(`/god-mode/${runId}/create-monitoring`, { method: 'POST', body: JSON.stringify({ index: i }) });
                      } finally {
                        setCreatingMonitor(null);
                      }
                    }}
                  >
                    {creatingMonitor === i ? 'creating…' : 'create'}
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          {data.reportId && (
            <p className="text-center text-xs text-slate-500">
              Full report generated —{' '}
              <Link href={`/investigations/${data.projectId}`} className="text-accent hover:underline">
                view &amp; export in the Analyst tab →
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
