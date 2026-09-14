import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { jobBus, type JobEvent } from '../jobs/events.js';
import { notFound } from '../lib/errors.js';

/**
 * Server-Sent Events stream for realtime job / research progress (§37, §50).
 * Single-user local-first: no token needed (EventSource can't set headers
 * anyway, which is what the token-in-query-param used to work around) — just
 * confirm the project exists, same as assertProjectAccess elsewhere.
 */
export async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:id/stream', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) throw notFound('Project not found');

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
