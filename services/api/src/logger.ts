import { pino } from 'pino';
import { loadEnv } from './env.js';

const env = loadEnv();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.credentialsEnc',
      '*.access_token',
      '*.ANTHROPIC_API_KEY',
      '*.OPENAI_API_KEY',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined,
});

export type Logger = typeof logger;
