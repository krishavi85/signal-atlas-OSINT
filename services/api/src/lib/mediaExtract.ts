import { createHash } from 'node:crypto';

/**
 * Media intelligence helpers (§19).
 *
 * Scope: format + dimensions, EXIF (incl. GPS — surfaced because it is present
 * in the file the user provided or a public URL), a perceptual hash for
 * duplicate-image detection, and — separately, only when a vision model is
 * configured — OCR / description.
 *
 * Explicitly NOT here: face detection, facial similarity, biometric
 * identification of any kind (§19, §30).
 */

export interface ImageMeta {
  format: string | null;
  width: number | null;
  height: number | null;
  byteSize: number;
  sha256: string;
  exif: Record<string, unknown> | null;
  gps: { lat: number; lon: number } | null;
  createdAt: string | null;
}

export async function extractImageMeta(buf: Buffer): Promise<ImageMeta> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let format: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  try {
    const { imageSize } = await import('image-size');
    const d = imageSize(buf);
    format = d.type ?? null;
    width = d.width ?? null;
    height = d.height ?? null;
  } catch {
    /* not a recognised image header */
  }

  let exif: Record<string, unknown> | null = null;
  let gps: { lat: number; lon: number } | null = null;
  let createdAt: string | null = null;
  try {
    const exifr = (await import('exifr')).default;
    const parsed = await exifr.parse(buf).catch(() => null);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        gps = { lat: p.latitude, lon: p.longitude };
      }
      const dt = (p.DateTimeOriginal ?? p.CreateDate ?? p.ModifyDate) as Date | string | undefined;
      if (dt) {
        const t = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
        if (Number.isFinite(t)) createdAt = new Date(t).toISOString();
      }
      // keep a compact, non-sensitive subset
      exif = pick(p, [
        'Make', 'Model', 'LensModel', 'Software', 'Orientation', 'ExposureTime', 'FNumber', 'ISO',
        'FocalLength', 'DateTimeOriginal', 'CreateDate', 'ImageWidth', 'ImageHeight', 'GPSAltitude',
      ]);
    }
  } catch {
    /* no exif */
  }

  return { format, width, height, byteSize: buf.length, sha256, exif, gps, createdAt };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k] instanceof Date ? (obj[k] as Date).toISOString() : obj[k];
  return out;
}

/**
 * 64-bit difference-hash (dHash) as a 16-char hex string. Robust to scaling and
 * minor edits; use `hammingHex` to compare. Decodes via Jimp (pure JS).
 */
export async function perceptualHash(buf: Buffer): Promise<string | null> {
  try {
    const { Jimp } = await import('jimp');
    const img = await Jimp.fromBuffer(buf as unknown as ArrayBuffer);
    // 9x8 greyscale -> compare each pixel to its right neighbour
    img.resize({ w: 9, h: 8 }).greyscale();
    const data = img.bitmap.data; // RGBA
    let bits = 0n;
    let bit = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 9 + x) * 4;
        const j = (y * 9 + x + 1) * 4;
        if ((data[i] ?? 0) < (data[j] ?? 0)) bits |= 1n << BigInt(bit);
        bit++;
      }
    }
    return bits.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** true when two images are perceptual near-duplicates (default: <=6 bits of 64). */
export function isDuplicateImage(a: string | null, b: string | null, maxDistance = 6): boolean {
  return a !== null && b !== null && hammingHex(a, b) <= maxDistance;
}

export const IMAGE_CONTENT_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;
