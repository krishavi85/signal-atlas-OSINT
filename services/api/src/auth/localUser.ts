import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { hashPassword } from '../lib/password.js';
import type { AuthUser } from './plugin.js';

/**
 * Single-user local-first auth (no login screen, no tokens): every request
 * is automatically this one account. Resolves to the earliest-created ADMIN
 * user — the real account already in use — auto-provisioning one only if
 * none exists yet (a brand-new database). The password hash is unused (no
 * login route exists to check it) but the column is NOT NULL.
 */

let cached: AuthUser | null = null;

export async function ensureLocalUser(): Promise<AuthUser> {
  if (cached) return cached;
  let user = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: 'local@osint.local',
        displayName: 'Local User',
        passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
        role: 'ADMIN',
      },
    });
  }
  cached = { id: user.id, email: user.email, role: user.role };
  return cached;
}
