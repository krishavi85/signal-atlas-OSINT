import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { currentUser } from './plugin.js';
import { LoginInput, RegisterInput, login, logout, refresh, register } from './service.js';
import { badRequest } from '../lib/errors.js';
import { z } from 'zod';

const RefreshInput = z.object({ refreshToken: z.string().min(1) });

// Brute-force mitigation (§40): auth endpoints get a much tighter limit than
// the global default (300/min). Keyed by IP; login is also keyed by the
// attempted email so one IP can't exhaust the budget for every account, and
// one targeted account can't be hammered from a single source faster than this.
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent: typeof req.headers['user-agent'] === 'string' ? (req.headers['user-agent'] as string) : undefined,
    ip: req.ip,
  });

  app.post(
    '/auth/register',
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (req, reply) => {
      const input = RegisterInput.parse(req.body);
      const result = await register(input, meta(req));
      reply.status(201).send(result);
    },
  );

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          ...AUTH_RATE_LIMIT,
          // @fastify/rate-limit's default hook is `onRequest`, which runs
          // BEFORE body parsing — req.body would be undefined there and every
          // login attempt would collapse into one IP-only bucket regardless of
          // which email was targeted. `preHandler` runs after body parsing.
          hook: 'preHandler',
          keyGenerator: (req: { ip: string; body?: unknown }) =>
            `${req.ip}:${typeof req.body === 'object' && req.body && 'email' in req.body ? String((req.body as { email?: unknown }).email ?? '') : ''}`,
        },
      },
    },
    async (req) => {
      const input = LoginInput.parse(req.body);
      return login(input, meta(req));
    },
  );

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = RefreshInput.parse(req.body);
    return refresh(refreshToken, meta(req));
  });

  app.post('/auth/logout', async (req, reply) => {
    const parsed = RefreshInput.safeParse(req.body);
    if (!parsed.success) throw badRequest('refreshToken required');
    await logout(parsed.data.refreshToken);
    reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const u = currentUser(req);
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { id: true, email: true, displayName: true, role: true, createdAt: true },
    });
    const projectCount = await prisma.projectMember.count({ where: { userId: u.id } });
    return { ...full, projectCount };
  });
}
