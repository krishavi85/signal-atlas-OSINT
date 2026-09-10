import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { loadEnv } from '../env.js';

const env = loadEnv();
const secret = new TextEncoder().encode(env.AUTH_JWT_SECRET);
const ISSUER = 'osint-platform';

export interface AccessClaims {
  sub: string;
  email: string;
  role: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.AUTH_ACCESS_TTL}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
  return { sub: String(payload.sub), email: String(payload.email), role: String(payload.role) };
}

/** Opaque refresh token; only its hash is stored. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
