import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from './tokens.js';

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

export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('user', undefined);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let claims;
    try {
      claims = await verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('Access token invalid or expired');
    }
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.disabledAt) throw unauthorized('Account not found or disabled');
    req.user = { id: user.id, email: user.email, role: user.role };
  });

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    if (req.user.role !== 'ADMIN') throw forbidden('Admin role required');
  });
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
