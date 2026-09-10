import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { currentUser } from './plugin.js';
import { LoginInput, RegisterInput, login, logout, refresh, register } from './service.js';
import { badRequest } from '../lib/errors.js';
import { z } from 'zod';

const RefreshInput = z.object({ refreshToken: z.string().min(1) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent: typeof req.headers['user-agent'] === 'string' ? (req.headers['user-agent'] as string) : undefined,
    ip: req.ip,
  });

  app.post('/auth/register', async (req, reply) => {
    const input = RegisterInput.parse(req.body);
    const result = await register(input, meta(req));
    reply.status(201).send(result);
  });

  app.post('/auth/login', async (req) => {
    const input = LoginInput.parse(req.body);
    return login(input, meta(req));
  });

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
