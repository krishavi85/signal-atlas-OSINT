'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconAlertTriangle, IconInbox } from './icons';

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet';

const TONE_STYLES: Record<Tone, { badge: string; dot: string }> = {
  neutral: { badge: 'bg-ink-800 text-slate-300 border-ink-700', dot: 'bg-slate-500' },
  green: { badge: 'bg-emerald-950/70 text-emerald-300 border-emerald-800/70', dot: 'bg-emerald-400' },
  amber: { badge: 'bg-amber-950/70 text-amber-300 border-amber-800/70', dot: 'bg-amber-400' },
  red: { badge: 'bg-red-950/70 text-red-300 border-red-800/70', dot: 'bg-red-400' },
  blue: { badge: 'bg-sky-950/70 text-sky-300 border-sky-800/70', dot: 'bg-sky-400' },
  violet: { badge: 'bg-violet-950/70 text-violet-300 border-violet-800/70', dot: 'bg-violet-400' },
};

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  const t = TONE_STYLES[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${t.badge}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  );
}

export function healthTone(state?: string): Tone {
  switch (state) {
    case 'ONLINE':
      return 'green';
    case 'DEGRADED':
    case 'RATE_LIMITED':
      return 'amber';
    case 'OFFLINE':
    case 'MISCONFIGURED':
      return 'red';
    default:
      return 'neutral';
  }
}

export function confidenceTone(level?: string): Tone {
  switch (level) {
    case 'VERIFIED':
      return 'green';
    case 'HIGH':
      return 'blue';
    case 'MEDIUM':
      return 'amber';
    case 'LOW':
    case 'VERY_LOW':
      return 'red';
    default:
      return 'neutral';
  }
}

export function Spinner({ label, size = 'sm' }: { label?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'h-4 w-4 border-[2.5px]' : 'h-3 w-3 border-2';
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-slate-400">
      <span className={`animate-spin rounded-full border-slate-700 border-t-accent ${dim}`} />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="animate-in flex flex-col items-center gap-2 rounded-xl border border-dashed border-ink-750 bg-ink-900/40 px-8 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-850 text-slate-500">
        {icon ?? <IconInbox className="h-5 w-5" />}
      </span>
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="animate-in flex items-start gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm">
      <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <div className="flex-1">
        <p className="font-medium text-red-300">Something went wrong</p>
        <p className="mt-0.5 text-xs text-red-400/90">{message}</p>
        {retry && (
          <button onClick={retry} className="btn-ghost mt-3 py-1 text-xs">
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  icon?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="card group relative overflow-hidden p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {icon && <span className="text-slate-600 transition-colors group-hover:text-slate-400">{icon}</span>}
      </div>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${tone ?? 'text-slate-100'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

const STATE_DOT_COLOR: Record<string, string> = {
  ONLINE: '#34d399',
  DEGRADED: '#fbbf24',
  RATE_LIMITED: '#fbbf24',
  OFFLINE: '#f87171',
  MISCONFIGURED: '#f87171',
  AUTH_REQUIRED: '#f87171',
  NOT_CONFIGURED: '#64748b',
};

/** Oldest-to-newest latency sparkline + a state-colored dot strip beneath it. Renders nothing meaningful for <2 points. */
export function LatencySparkline({
  points,
  width = 320,
  height = 40,
}: {
  points: Array<{ latencyMs: number | null; state: string; checkedAt: string }>;
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return null;
  const withLatency = points.filter((p) => p.latencyMs != null) as Array<{ latencyMs: number; state: string; checkedAt: string }>;
  const max = Math.max(1, ...withLatency.map((p) => p.latencyMs));
  const n = points.length;
  const step = n > 1 ? width / (n - 1) : 0;
  const y = (v: number) => height - (v / max) * (height - 4) - 2;

  const linePoints = withLatency
    .map((p) => {
      const i = points.indexOf(p);
      return `${i * step},${y(p.latencyMs)}`;
    })
    .join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {withLatency.length >= 2 && <polyline points={linePoints} fill="none" stroke="#4f9cf9" strokeWidth={1.5} />}
        {withLatency.map((p, idx) => {
          const i = points.indexOf(p);
          return <circle key={idx} cx={i * step} cy={y(p.latencyMs)} r={1.5} fill="#4f9cf9" />;
        })}
      </svg>
      <div className="mt-1 flex gap-[1px]">
        {points.map((p, i) => (
          <span
            key={i}
            title={`${p.state} · ${new Date(p.checkedAt).toLocaleString()}${p.latencyMs != null ? ` · ${p.latencyMs}ms` : ''}`}
            className="h-1.5 flex-1 rounded-[1px]"
            style={{ background: STATE_DOT_COLOR[p.state] ?? '#334155' }}
          />
        ))}
      </div>
    </div>
  );
}

/** Chip-list input: type + Enter/comma to add, click × or Backspace-on-empty to remove. */
export function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const v = raw.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="input flex flex-wrap items-center gap-1.5 py-1.5">
      {values.map((v, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] text-slate-300">
          {v}
          <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} className="text-slate-500 hover:text-slate-200" aria-label={`Remove ${v}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-[6rem] flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={values.length === 0 ? placeholder : undefined}
      />
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
