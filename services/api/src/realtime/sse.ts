import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken } from '../auth/tokens.js';
import { prisma } from '../db.js';
import { jobBus, type JobEvent } from '../jobs/events.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Server-Sent Events stream for realtime job / research progress (§37, §50).
 * Auth via `?token=` query param (EventSource can't set headers).
 */
export async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:id/stream', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { token } = z.object({ token: z.string() }).parse(req.query);

    let userId: string;
    try {
      userId = (await verifyAccessToken(token)).sub;
    } catch {
      throw unauthorized('Invalid stream token');
    }
    const member = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } } });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!member && user?.role !== 'ADMIN') throw unauthorized('No access to this project stream');

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ projectId: id, at: new Date().toISOString() })}\n\n`);

    const onEvent = (evt: JobEvent) => {
      reply.raw.write(`event: job\ndata: ${JSON.stringify(evt)}\n\n`);
    };
    jobBus.on(`project:${id}`, onEvent);

    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      jobBus.off(`project:${id}`, onEvent);
    });

    return reply; // keep open
  });
}
