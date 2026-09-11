'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { IconAlertTriangle, IconShield } from '@/components/icons';

export default function LoginPage() {
  const { me, loading, login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && me) router.replace('/');
  }, [me, loading, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, displayName);
      router.replace('/');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-975 bg-grid-fade p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgb(255_255_255_/_0.035)_1px,transparent_0)] [background-size:26px_26px]" />

      <div className="relative w-full max-w-sm animate-in">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-signal-cyan shadow-[0_0_28px_-4px_rgb(79_156_249_/_0.55)]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-ink-975" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-3.8-3.8" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">
            OSINT<span className="text-accent">/</span>Platform
          </h1>
          <p className="mt-1 text-xs text-slate-500">Public intelligence &amp; investigation workspace</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div className="flex gap-1 rounded-lg bg-ink-950 p-1 text-xs">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-2 py-1.5 font-medium capitalize transition-colors ${
                  mode === m ? 'bg-ink-750 text-slate-100 shadow-card' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {mode === 'register' && (
            <div>
              <label className="label">Display name</label>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
          )}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 10 : 1}
            />
            {mode === 'register' && <p className="mt-1 text-[11px] text-slate-600">Minimum 10 characters. First account becomes admin.</p>}
          </div>
          {err && (
            <p className="flex items-start gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
              <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {err}
            </p>
          )}
          <button className="btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-600">
          <IconShield className="h-3 w-3" />
          Lawful public information research only
        </p>
      </div>
    </div>
  );
}
