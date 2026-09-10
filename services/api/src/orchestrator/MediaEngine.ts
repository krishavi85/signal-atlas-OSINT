import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';
import { audit } from '../modules/audit.js';
import { safeFetch } from '../lib/safeFetch.js';
import { storage } from '../lib/storage.js';
import { chat, chatStatus } from '../ai/chat.js';
import {
  extractImageMeta,
  hammingHex,
  IMAGE_CONTENT_TYPES,
  isDuplicateImage,
  perceptualHash,
} from '../lib/mediaExtract.js';

/**
 * Media intelligence (§19).
 *
 * Does: image format/dimensions, EXIF incl. GPS (surfaced, not hidden),
 * perceptual-hash duplicate-image detection, and — only when a vision model is
 * configured — text/description extraction.
 *
 * Does NOT: face detection, facial similarity, or any biometric identification
 * of individuals (§19, §30). Video/audio transcription is not bundled (needs
 * ffmpeg + a speech model) and is reported honestly as SKIPPED.
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DUP_DISTANCE = 6;

export function visionCapable(): { available: boolean; reason?: string } {
  const status = chatStatus();
  if (!status.available) return { available: false, reason: status.reason };
  const env = loadEnv();
  const model = (status.models.synth ?? status.models.extract ?? '').toLowerCase();
  if (env.AI_PROVIDER === 'anthropic' || env.AI_PROVIDER === 'openai') return { available: true };
  if (env.AI_PROVIDER === 'ollama' && /(llava|bakllava|moondream|llama3\.2-vision|minicpm-v|qwen2?-vl)/.test(model)) {
    return { available: true };
  }
  return {
    available: false,
    reason: `Configured model "${model || 'none'}" is not known to be multimodal. Use a vision model (claude-*, gpt-4o, or an Ollama vision model like llava) for image OCR/description.`,
  };
}

const VISION_SYSTEM = `You are analysing an image that is part of an OSINT investigation.
1. Transcribe ALL visible text verbatim (signs, captions, watermarks, UI, documents). If none, say "No visible text".
2. Then briefly describe what the image depicts (objects, setting, notable marks/logos).
RULES: Do NOT identify, name, or speculate about the identity of any person. Do NOT guess at ages, ethnicity, or other personal attributes. Report only what is objectively visible.`;

// ── 1. collect media references from evidence ────────────────────────────────

export async function collectMediaForProject(projectId: string): Promise<number> {
  const evidence = await prisma.evidence.findMany({
    where: { projectId, isDuplicate: false, mediaJson: { not: Prisma.DbNull } },
    select: { id: true, mediaJson: true },
  });
  let created = 0;
  for (const ev of evidence) {
    const media = Array.isArray(ev.mediaJson) ? (ev.mediaJson as Array<{ type: string; url: string }>) : [];
    for (const m of media) {
      if (!m?.url || !/^https?:\/\//.test(m.url)) continue;
      const kind = m.type === 'video' ? 'VIDEO' : m.type === 'audio' ? 'AUDIO' : m.type === 'document' ? 'DOCUMENT' : 'IMAGE';
      const exists = await prisma.mediaAsset.findFirst({ where: { projectId, sourceUrl: m.url } });
      if (exists) continue;
      await prisma.mediaAsset.create({ data: { projectId, kind, sourceUrl: m.url, evidenceId: ev.id, status: 'PENDING' } });
      created++;
    }
  }
  return created;
}

// ── 2. process pending media ────────────────────────────────────────────────

export interface MediaProcessResult {
  processed: number;
  duplicates: number;
  skipped: number;
  errors: number;
  visionUsed: boolean;
}

export async function processProjectMedia(
  projectId: string,
  opts: { vision?: boolean; limit?: number } = {},
): Promise<MediaProcessResult> {
  const pending = await prisma.mediaAsset.findMany({
    where: { projectId, status: 'PENDING' },
    take: opts.limit ?? 60,
  });
  const result: MediaProcessResult = { processed: 0, duplicates: 0, skipped: 0, errors: 0, visionUsed: false };
  const wantVision = Boolean(opts.vision) && visionCapable().available;

  // known hashes in this project for dup detection
  const known = await prisma.mediaAsset.findMany({
    where: { projectId, status: 'PROCESSED', perceptualHash: { not: null } },
    select: { id: true, perceptualHash: true, clusterId: true },
  });

  for (const asset of pending) {
    if (asset.kind !== 'IMAGE') {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: 'SKIPPED',
          note:
            asset.kind === 'VIDEO' || asset.kind === 'AUDIO'
              ? 'Video/audio transcription is not bundled (requires ffmpeg + a speech-to-text model). Metadata only.'
              : 'Non-image media — no processor.',
          processedAt: new Date(),
        },
      });
      result.skipped++;
      continue;
    }

    try {
      let buf: Buffer;
      if (asset.storageKey) {
        buf = await storage().get(asset.storageKey);
      } else if (asset.sourceUrl) {
        const res = await safeFetch(asset.sourceUrl, { timeoutMs: 15_000, maxBytes: MAX_IMAGE_BYTES });
        const ct = res.headers.get('content-type') ?? '';
        if (!IMAGE_CONTENT_TYPES.test(ct) && !ct.includes('octet-stream')) {
          throw new Error(`Not an image (content-type: ${ct || 'unknown'})`);
        }
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image too large (${buf.length} bytes)`);
        const stored = await storage().put(`media/${projectId}`, buf, (asset.sourceUrl.split('.').pop() ?? 'img').slice(0, 5));
        asset.storageKey = stored.key;
      } else {
        throw new Error('No source URL or stored file');
      }

      const meta = await extractImageMeta(buf);
      const phash = await perceptualHash(buf);
      if (!meta.format && !phash) {
        throw new Error('File is not a decodable image');
      }

      // dup detection
      let duplicateOfId: string | null = null;
      let clusterId: string | null = null;
      if (phash) {
        const match = known.find((k) => isDuplicateImage(phash, k.perceptualHash, DUP_DISTANCE));
        if (match) {
          duplicateOfId = match.id;
          clusterId = match.clusterId ?? match.id;
          result.duplicates++;
        }
      }
      if (!clusterId) clusterId = asset.id;

      // vision OCR/description
      let visionText: string | null = null;
      if (wantVision && !duplicateOfId) {
        try {
          const r = await chat(
            {
              role: 'synth',
              system: VISION_SYSTEM,
              messages: [
                {
                  role: 'user',
                  content: 'Analyse this image per the rules.',
                  images: [{ mediaType: mimeFromFormat(meta.format), dataBase64: buf.toString('base64') }],
                },
              ],
              maxTokens: 700,
            },
            { projectId, operation: 'VISION' },
          );
          visionText = r.text.trim() || null;
          result.visionUsed = true;
        } catch (err) {
          logger.warn({ err, assetId: asset.id }, 'vision analysis failed (non-fatal)');
        }
      }

      const updated = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          storageKey: asset.storageKey,
          sha256: meta.sha256,
          format: meta.format,
          byteSize: meta.byteSize,
          width: meta.width,
          height: meta.height,
          perceptualHash: phash,
          exifJson: meta.exif ? (meta.exif as Prisma.InputJsonValue) : Prisma.DbNull,
          gpsLat: meta.gps?.lat ?? null,
          gpsLon: meta.gps?.lon ?? null,
          capturedAt: meta.createdAt ? new Date(meta.createdAt) : null,
          visionText,
          ocrText: visionText, // vision output doubles as OCR here
          clusterId,
          duplicateOfId,
          status: 'PROCESSED',
          error: null,
          processedAt: new Date(),
        },
      });
      if (phash) known.push({ id: updated.id, perceptualHash: phash, clusterId });
      result.processed++;
    } catch (err) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'ERROR', error: (err instanceof Error ? err.message : String(err)).slice(0, 500), processedAt: new Date() },
      });
      result.errors++;
    }
  }

  await audit({
    projectId,
    actorLabel: 'SYSTEM',
    action: 'AI_ANALYSIS_EXECUTED',
    targetType: 'project',
    targetId: projectId,
    summary: `Media processing: ${result.processed} images (${result.duplicates} perceptual duplicates), ${result.skipped} skipped, ${result.errors} errors${result.visionUsed ? ', vision model used for OCR/description' : ''}`,
  });
  return result;
}

function mimeFromFormat(format: string | null): string {
  const f = (format ?? '').toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  if (f === 'png') return 'image/png';
  if (f === 'gif') return 'image/gif';
  if (f === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export { hammingHex };
