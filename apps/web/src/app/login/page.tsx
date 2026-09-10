'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

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
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-slate-100">OSINT Platform</h1>
          <p className="text-xs text-slate-500">Public intelligence &amp; investigation workspace</p>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div className="flex gap-1 rounded-md bg-ink-950 p-1 text-xs">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 py-1.5 font-medium capitalize ${mode === m ? 'bg-ink-800 text-slate-100' : 'text-slate-500'}`}
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
          {err && <p className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-xs text-red-300">{err}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
