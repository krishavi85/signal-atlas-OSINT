'use client';

import type { ReactNode } from 'react';

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-800 text-slate-300 border-ink-700',
    green: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    amber: 'bg-amber-950 text-amber-300 border-amber-800',
    red: 'bg-red-950 text-red-300 border-red-800',
    blue: 'bg-sky-950 text-sky-300 border-sky-800',
    violet: 'bg-violet-950 text-violet-300 border-violet-800',
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function healthTone(state?: string): 'green' | 'amber' | 'red' | 'neutral' {
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

export function confidenceTone(level?: string): 'green' | 'amber' | 'red' | 'blue' | 'neutral' {
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

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-accent" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-8 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
      <p className="font-medium">Error</p>
      <p className="mt-1 text-red-400">{message}</p>
      {retry && (
        <button onClick={retry} className="btn-ghost mt-3">
          Retry
        </button>
      )}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ?? 'text-slate-100'}`}>{value}</p>
    </div>
  );
}
