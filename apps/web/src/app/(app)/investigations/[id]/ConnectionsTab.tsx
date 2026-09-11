'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';
import { IconLink } from '@/components/icons';

interface GNode {
  id: string;
  label: string;
  type: string;
  evidenceCount: number;
  resolutionConfidence: string;
}
interface GEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  directed: boolean;
  confidence: string;
  evidenceIds: string[];
}

const TYPE_COLOR: Record<string, string> = {
  PERSON: '#f97316',
  COMPANY: '#4f9cf9',
  ORGANIZATION: '#38bdf8',
  BRAND: '#a78bfa',
  PRODUCT: '#34d399',
  DOMAIN: '#94a3b8',
  SOCIAL_ACCOUNT: '#f472b6',
  LOCATION: '#fbbf24',
  EVENT: '#fb7185',
};

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Tiny deterministic spring-embedder — no external library. */
function layout(nodes: GNode[], edges: GEdge[], w: number, h: number): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const n = nodes.length || 1;
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    pos.set(node.id, { x: w / 2 + Math.cos(angle) * (w / 3), y: h / 2 + Math.sin(angle) * (h / 3), vx: 0, vy: 0 });
  });
  const adj = edges.map((e) => [e.source, e.target] as const);
  for (let iter = 0; iter < 220; iter++) {
    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i]!.id)!;
        const b = pos.get(nodes[j]!.id)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }
    // spring
    for (const [s, t] of adj) {
      const a = pos.get(s)!;
      const b = pos.get(t)!;
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - 90) * 0.02;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    // integrate + center pull + damping
    for (const node of nodes) {
      const p = pos.get(node.id)!;
      p.vx += (w / 2 - p.x) * 0.001;
      p.vy += (h / 2 - p.y) * 0.001;
      p.x += Math.max(-12, Math.min(12, p.vx));
      p.y += Math.max(-12, Math.min(12, p.vy));
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x = Math.max(24, Math.min(w - 24, p.x));
      p.y = Math.max(24, Math.min(h - 24, p.y));
    }
  }
  return pos;
}

const MAX_ISOLATED_SHOWN = 40;

export function ConnectionsTab({ projectId }: { projectId: string }) {
  const [minEvidence, setMinEvidence] = useState(1);
  const [showIsolated, setShowIsolated] = useState(false);
  const { data, error, loading, reload } = useApi<{ nodes: GNode[]; edges: GEdge[] }>(
    `/projects/${projectId}/graph?minEvidence=${minEvidence}`,
    [minEvidence],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const W = 760;
  const H = 460;

  // A graph endpoint that returns every entity meeting minEvidence — including
  // ones with zero relationships — reads as noise, not a "connection" graph.
  // Default to connected nodes only; isolated ones are an explicit opt-in,
  // capped, so a few hundred stray dots never turn the canvas into static.
  const { visibleNodes, isolatedCount } = useMemo(() => {
    if (!data) return { visibleNodes: [] as GNode[], isolatedCount: 0 };
    const connectedIds = new Set<string>();
    for (const e of data.edges) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
    const connected = data.nodes.filter((n) => connectedIds.has(n.id));
    const isolated = data.nodes.filter((n) => !connectedIds.has(n.id));
    if (!showIsolated) return { visibleNodes: connected, isolatedCount: isolated.length };
    const extra = [...isolated].sort((a, b) => b.evidenceCount - a.evidenceCount).slice(0, MAX_ISOLATED_SHOWN);
    return { visibleNodes: [...connected, ...extra], isolatedCount: Math.max(0, isolated.length - extra.length) };
  }, [data, showIsolated]);

  const pos = useMemo(() => layout(visibleNodes, data?.edges ?? [], W, H), [visibleNodes, data]);

  if (loading) return <Spinner size="md" />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data || data.nodes.length === 0)
    return (
      <EmptyState
        icon={<IconLink className="h-5 w-5" />}
        title="No connection graph yet"
        hint="Edges are built from entity co-mentions across ≥2 evidence records, author links, and shared domains — each traceable to evidence (§8)."
      />
    );

  const visibleEdges = data.edges.filter((e) => pos.has(e.source) && pos.has(e.target));
  const selNode = visibleNodes.find((n) => n.id === selected);
  const selEdges = data.edges.filter((e) => e.source === selected || e.target === selected);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-slate-500">
            Min evidence
            <span className="flex gap-0.5 rounded-md bg-ink-950 p-0.5">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => setMinEvidence(n)}
                  className={`rounded px-1.5 py-0.5 ${minEvidence === n ? 'bg-ink-750 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {n}
                </button>
              ))}
            </span>
          </span>
          <label className="flex items-center gap-1.5 text-slate-500">
            <input type="checkbox" checked={showIsolated} onChange={(e) => setShowIsolated(e.target.checked)} />
            show unconnected entities
          </label>
          <span className="ml-auto text-slate-600">
            {visibleNodes.length} shown · {visibleEdges.length} edges
            {!showIsolated && isolatedCount > 0 && ` · ${isolatedCount} unconnected hidden`}
          </span>
        </div>
        <div className="card overflow-hidden">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            <defs>
              <pattern id="graph-dots" width="22" height="22" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#1a2230" />
              </pattern>
            </defs>
            <rect width={W} height={H} fill="url(#graph-dots)" />
            {visibleEdges.map((e) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const hot = selected && (e.source === selected || e.target === selected);
              return (
                <line
                  key={e.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={hot ? '#4f9cf9' : '#33405480'}
                  strokeWidth={hot ? 1.8 : e.confidence === 'MEDIUM' ? 1.2 : 0.8}
                />
              );
            })}
            {visibleNodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const r = 4 + Math.min(11, Math.sqrt(n.evidenceCount) * 2.2);
              const active = selected === n.id;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} onClick={() => setSelected(n.id)} className="cursor-pointer">
                  {active && <circle r={r + 5} fill="none" stroke={TYPE_COLOR[n.type] ?? '#64748b'} strokeWidth={1} strokeOpacity={0.4} />}
                  <circle r={r} fill={TYPE_COLOR[n.type] ?? '#64748b'} stroke={active ? '#fff' : '#0a0d14'} strokeWidth={active ? 2 : 1.2} />
                  <text x={r + 4} y={3.5} fontSize={9.5} fill={active ? '#f1f5f9' : '#94a3b8'} fontWeight={active ? 600 : 400}>
                    {n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
          {Object.entries(TYPE_COLOR).map(([t, c]) => (
            <span key={t} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: c }} /> {t}
            </span>
          ))}
        </div>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        {selNode ? (
          <div className="card animate-in space-y-2 p-4 text-sm">
            <p className="font-medium text-slate-100">
              <Badge tone="violet">{selNode.type}</Badge> {selNode.label}
            </p>
            <p className="text-xs text-slate-500">
              {selNode.evidenceCount} evidence · resolution {selNode.resolutionConfidence}
            </p>
            <p className="mt-1 text-xs font-semibold text-slate-400">Edges ({selEdges.length})</p>
            <ul className="space-y-1 text-xs">
              {selEdges.map((e) => {
                const otherId = e.source === selected ? e.target : e.source;
                const other = data.nodes.find((n) => n.id === otherId);
                return (
                  <li key={e.id} className="flex items-center gap-1.5">
                    <Badge tone={e.confidence === 'MEDIUM' ? 'blue' : 'neutral'}>{e.type}</Badge>
                    <span className="truncate text-slate-400">{other?.label ?? otherId}</span>
                    <span className="ml-auto shrink-0 text-slate-600">{e.evidenceIds.length} ev</span>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-ink-800 pt-2 text-[11px] leading-relaxed text-slate-600">
              Co-mention edges mean the entities appeared together in evidence — <strong>not</strong> an asserted personal
              relationship (§8).
            </p>
          </div>
        ) : (
          <div className="card p-4 text-sm text-slate-500">Click a node to see its evidence-backed connections.</div>
        )}
      </aside>
    </div>
  );
}
