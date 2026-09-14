'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Spinner } from '@/components/ui';
import { IconFolder, IconHome, IconPlug, IconSearch, IconSettings, IconZap } from '@/components/icons';

const NAV = [
  { href: '/', label: 'Home', icon: IconHome },
  { href: '/search', label: 'Search', icon: IconSearch },
  { href: '/god-mode', label: 'God Mode', icon: IconZap },
  { href: '/investigations', label: 'Investigations', icon: IconFolder },
  { href: '/connectors', label: 'Connectors', icon: IconPlug },
  { href: '/system', label: 'System', icon: IconSettings },
];

function Logo() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2">
      <span className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-signal-cyan text-ink-975 shadow-[0_0_16px_-2px_rgb(79_156_249_/_0.6)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-3.8-3.8" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight text-slate-100">
        OSINT<span className="text-accent">/</span>Platform
      </span>
    </Link>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const pathname = usePathname();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="md" label="Loading workspace…" />
      </div>
    );
  }
  if (!me) return null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-975/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4">
          <div className="mr-4">
            <Logo />
          </div>
          <nav className="scrollbar-none flex flex-1 items-center gap-0.5 overflow-x-auto text-sm">
            {NAV.map((n) => {
              const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`group relative flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-colors ${
                    active ? 'text-slate-100' : 'text-slate-500 hover:text-slate-200'
                  }`}
                >
                  {active && <span className="absolute inset-0 rounded-lg bg-ink-800/80" />}
                  <Icon className={`relative h-3.5 w-3.5 ${active ? 'text-accent-bright' : 'text-slate-600 group-hover:text-slate-400'}`} />
                  <span className="relative">{n.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-2 flex shrink-0 items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-xs text-slate-400">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-750 text-[10px] font-semibold text-slate-300 ring-1 ring-ink-600">
              {initials(me.displayName) || '?'}
            </span>
            <span className="hidden sm:inline">
              {me.displayName}
              {me.role === 'ADMIN' && <span className="ml-1 text-accent">· admin</span>}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
