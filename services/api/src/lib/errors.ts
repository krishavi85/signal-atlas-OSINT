import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Not permitted') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', msg, details);

export function registerErrorHandler(app: {
  setErrorHandler: (fn: (err: unknown, req: FastifyRequest, reply: FastifyReply) => void) => void;
}): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.flatten() },
      });
      return;
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      else req.log.warn({ code: err.code }, err.message);
      reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { statusCode?: number; message?: string; code?: string; validation?: unknown };
    if (e.validation) {
      reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: e.message ?? 'Invalid request', details: e.validation } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: e.code ?? 'ERROR', message: e.message ?? 'Error' } });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.id } });
  });
}
