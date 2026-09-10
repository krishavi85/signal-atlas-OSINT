'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { Spinner } from '@/components/ui';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/search', label: 'Universal Search' },
  { href: '/investigations', label: 'Investigations' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/system', label: 'System' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [me, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading workspace…" />
      </div>
    );
  }
  if (!me) return null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link href="/" className="text-sm font-semibold text-slate-100">
            OSINT<span className="text-accent">·</span>Platform
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((n) => {
              const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`rounded px-2.5 py-1.5 ${active ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
            <span>
              {me.displayName} {me.role === 'ADMIN' && <span className="text-accent">· admin</span>}
            </span>
            <button onClick={() => logout().then(() => router.replace('/login'))} className="btn-ghost py-1">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
