import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors.js';
import { ensureLocalUser } from './localUser.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Single-user local-first (§ auth model): no login, no tokens. Every request
 * is automatically the one local account (see localUser.ts) — `authenticate`
 * and `requireAdmin` are kept as named preHandlers, unchanged at every call
 * site, so this is the only file that had to change to remove the login
 * gate. The local account's role is always ADMIN, so requireAdmin never
 * actually blocks anything; it stays as a decorator only so admin-only
 * routes don't need editing either.
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('user', undefined);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    req.user = await ensureLocalUser();
  });

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
