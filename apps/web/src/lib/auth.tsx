'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: string;
  projectCount?: number;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Single-user local-first: no login screen, no tokens. `/auth/me` always
 * resolves — every request is auto-authenticated as the one local account
 * (see services/api/src/auth/). This still fetches it (rather than a static
 * placeholder) so the header shows the real account and this stays a real
 * check, not a fabricated "logged in" state.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const value = useMemo(() => ({ me, loading, refreshMe }), [me, loading, refreshMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
