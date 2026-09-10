import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a buffer or string. Used for evidence content hashes (§9). */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/**
 * Normalised content hash: collapse whitespace, lowercase, strip common
 * boilerplate punctuation so that trivially reformatted copies of the same text
 * hash identically. Used for exact-duplicate detection (§18).
 */
export function contentHash(text: string): string {
  const normalised = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
  return sha256(normalised);
}

/**
 * 64-bit SimHash for near-duplicate detection (§18).
 * Returns the fingerprint as a BigInt; compare with `hammingDistance`.
 */
export function simhash64(text: string): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  const bits = new Array<number>(64).fill(0);
  for (const [token, weight] of countTokens(tokens)) {
    const h = fnv1a64(token);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      bits[i] = (bits[i] ?? 0) + (bit === 1n ? weight : -weight);
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if ((bits[i] ?? 0) > 0) fingerprint |= 1n << BigInt(i);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** true when two texts are near-duplicates (default threshold: <=3 bits of 64). */
export function isNearDuplicate(a: string, b: string, maxDistance = 3): boolean {
  return hammingDistance(simhash64(a), simhash64(b)) <= maxDistance;
}

function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function countTokens(tokens: string[]): Map<string, number> {
  // 3-gram shingles capture word order for better near-dup discrimination.
  const shingles = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const gram = tokens.slice(i, i + 3).join(' ');
    shingles.set(gram, (shingles.get(gram) ?? 0) + 1);
  }
  return shingles;
}

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(str: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}
