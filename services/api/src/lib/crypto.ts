import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../env.js';

/**
 * AES-256-GCM encryption for connector credentials at rest (§40).
 * Key derived from CREDENTIAL_ENC_KEY. Stored format: v1.<iv>.<tag>.<ciphertext>
 * (all base64url).
 */
function key(): Buffer {
  const raw = loadEnv().CREDENTIAL_ENC_KEY;
  // Accept base64url of 32 bytes, or derive via scrypt from an arbitrary string.
  try {
    const b = Buffer.from(raw, 'base64url');
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return scryptSync(raw, 'osint-credential-salt', 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** JSON object <-> encrypted string helpers for connector credential bundles. */
export function encryptJson(obj: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(obj));
}
export function decryptJson<T = Record<string, string>>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
