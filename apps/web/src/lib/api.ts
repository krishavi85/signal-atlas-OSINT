'use client';

// Normally calls go through Next's rewrite proxy (single origin in the
// browser). Next's dev-server proxy for rewrites() times out well before a
// CPU-bound local LLM (e.g. Ollama) can finish a longer generation —
// observed cutting off around 20-25s regardless of the backend's own
// timeouts. NEXT_PUBLIC_API_ORIGIN lets local dev point straight at the API
// (already CORS-enabled for exactly this) to bypass that proxy; unset in
// any deployed environment, this is a no-op and behavior is unchanged.
const BASE = `${process.env.NEXT_PUBLIC_API_ORIGIN ?? ''}/api/v1`;

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: { error?: ApiError },
  ) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = 'ApiRequestError';
  }
}

const ACCESS_KEY = 'osint.access';
const REFRESH_KEY = 'osint.refresh';

export const tokenStore = {
  get access() {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(ACCESS_KEY);
    } catch {
      return null;
    }
  },
  get refresh() {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  set(access: string, refresh: string) {
    try {
      window.localStorage.setItem(ACCESS_KEY, access);
      window.localStorage.setItem(REFRESH_KEY, refresh);
    } catch {
      /* ignore */
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(ACCESS_KEY);
      window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
  },
};

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!tokenStore.refresh) return false;
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokenStore.refresh }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        tokenStore.set(data.accessToken, data.refreshToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { retryOnAuth?: boolean } = {},
): Promise<T> {
  const { retryOnAuth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('content-type') && rest.body) headers.set('content-type', 'application/json');
  if (tokenStore.access) headers.set('authorization', `Bearer ${tokenStore.access}`);

  const res = await fetch(`${BASE}${path}`, { ...rest, headers });

  if (res.status === 401 && retryOnAuth && (await tryRefresh())) {
    return api<T>(path, { ...init, retryOnAuth: false });
  }
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401) tokenStore.clear();
    throw new ApiRequestError(res.status, body);
  }
  return body as T;
}

export function streamUrl(projectId: string): string {
  return `${BASE}/projects/${projectId}/stream?token=${encodeURIComponent(tokenStore.access ?? '')}`;
}
