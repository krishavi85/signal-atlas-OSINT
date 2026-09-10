import { z } from 'zod';
import { prisma } from '../db.js';
import { loadEnv } from '../env.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js';

const env = loadEnv();

export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  displayName: z.string().min(1).max(120),
});

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

function tokenBundle(userId: string) {
  return { accessTtl: env.AUTH_ACCESS_TTL, refreshTtl: env.AUTH_REFRESH_TTL, userId };
}

export async function register(input: z.infer<typeof RegisterInput>, meta: SessionMeta) {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with that email already exists');

  const isFirstUser = (await prisma.user.count()) === 0;
  const user = await prisma.user.create({
    data: {
      email,
      displayName: input.displayName.trim(),
      passwordHash: await hashPassword(input.password),
      role: isFirstUser ? 'ADMIN' : 'USER',
    },
  });
  return issueSession(user, meta);
}

export async function login(input: z.infer<typeof LoginInput>, meta: SessionMeta) {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  // constant-ish time: always run a verify
  const ok = user ? await verifyPassword(input.password, user.passwordHash) : await verifyPassword(input.password, DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password');
  if (user.disabledAt) throw unauthorized('Account disabled');
  return issueSession(user, meta);
}

export async function refresh(refreshToken: string, meta: SessionMeta) {
  const hash = hashRefreshToken(refreshToken);
  const session = await prisma.authSession.findUnique({ where: { refreshTokenHash: hash }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw unauthorized('Refresh token invalid or expired');
  }
  // rotate
  await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  return issueSession(session.user, meta);
}

export async function logout(refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  await prisma.authSession.updateMany({ where: { refreshTokenHash: hash, revokedAt: null }, data: { revokedAt: new Date() } });
}

async function issueSession(user: { id: string; email: string; role: string; displayName: string }, meta: SessionMeta) {
  const { token: refreshToken, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.AUTH_REFRESH_TTL * 1000);
  await prisma.authSession.create({
    data: { userId: user.id, refreshTokenHash: hash, userAgent: meta.userAgent?.slice(0, 300), ip: meta.ip, expiresAt },
  });
  const accessToken = await signAccessToken({ sub: user.id, email: user.email, role: user.role });
  return {
    accessToken,
    refreshToken,
    ...tokenBundle(user.id),
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
  };
}

// A fixed well-formed hash to compare against for non-existent users
// (mitigates account-enumeration via response timing).
const DUMMY_HASH = 'scrypt$16384$8$1$YWFhYWFhYWFhYWFhYWFhYQ==$' + 'A'.repeat(88);
