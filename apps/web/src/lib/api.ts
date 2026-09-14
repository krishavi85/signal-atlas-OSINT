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

// Single-user local-first: no login, no tokens (see services/api/src/auth/).
// Every request the API sees is auto-authenticated as the one local
// account, so there is nothing to attach here.
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiRequestError(res.status, body);
  return body as T;
}

export function streamUrl(projectId: string): string {
  return `${BASE}/projects/${projectId}/stream`;
}
