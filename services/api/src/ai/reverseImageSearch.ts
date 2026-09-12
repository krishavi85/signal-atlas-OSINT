import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';

/**
 * Reverse image search (§19) — finds where an image *appears elsewhere on the
 * web* (stock-photo reuse, stolen/reposted images, disinformation image
 * recycling, earliest-known-source checks) via Google Cloud Vision's Web
 * Detection feature. This is content/perceptual matching against Google's
 * image index, NOT face detection or identity matching — Vision API's
 * separate FACE_DETECTION feature is never requested, and nothing here infers
 * who is in an image (§19, §30). Independent of AI_PROVIDER, same as
 * transcription — an operator may run a different chat provider entirely.
 */

export interface ReverseImageStatus {
  available: boolean;
  provider: string | null;
  reason?: string;
  setup?: string;
}

export function reverseImageSearchStatus(): ReverseImageStatus {
  const env = loadEnv();
  if (!env.GOOGLE_VISION_API_KEY) {
    return {
      available: false,
      provider: null,
      reason: 'No reverse-image-search provider configured.',
      setup:
        'Set GOOGLE_VISION_API_KEY (Google Cloud Vision API, Web Detection feature — separate from GOOGLE_CSE_* and independent of AI_PROVIDER). Enable the Vision API and create an API key in Google Cloud Console.',
    };
  }
  return { available: true, provider: 'google-vision' };
}

export interface ReverseImageMatch {
  url: string;
  domain: string | null;
  pageTitle: string | null;
  matchType: 'PAGE' | 'FULL' | 'PARTIAL' | 'SIMILAR';
}

export interface ReverseImageResult {
  matches: ReverseImageMatch[];
  bestGuessLabels: string[];
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Pure: shape Vision API's raw webDetection payload into our result, deduped by URL. */
export function parseWebDetection(web: {
  pagesWithMatchingImages?: Array<{ url?: string; pageTitle?: string }>;
  fullMatchingImages?: Array<{ url?: string }>;
  partialMatchingImages?: Array<{ url?: string }>;
  visuallySimilarImages?: Array<{ url?: string }>;
  bestGuessLabels?: Array<{ label?: string }>;
}): ReverseImageResult {
  const seen = new Map<string, ReverseImageMatch>();
  const add = (url: string | undefined, matchType: ReverseImageMatch['matchType'], pageTitle: string | null = null) => {
    if (!url || seen.has(url)) return;
    seen.set(url, { url, domain: domainOf(url), pageTitle, matchType });
  };
  // Order matters: a page listing (with a title) is the most useful result,
  // so pages are added first and win the dedup on URL collision with a bare
  // image-only match.
  for (const p of web.pagesWithMatchingImages ?? []) add(p.url, 'PAGE', p.pageTitle ?? null);
  for (const m of web.fullMatchingImages ?? []) add(m.url, 'FULL');
  for (const m of web.partialMatchingImages ?? []) add(m.url, 'PARTIAL');
  for (const m of web.visuallySimilarImages ?? []) add(m.url, 'SIMILAR');

  return {
    matches: [...seen.values()],
    bestGuessLabels: (web.bestGuessLabels ?? []).map((l) => l.label).filter((l): l is string => Boolean(l)),
  };
}

export async function reverseImageSearch(imageBuffer: Buffer): Promise<ReverseImageResult> {
  const status = reverseImageSearchStatus();
  if (!status.available) throw new Error(`Reverse image search unavailable: ${status.reason} ${status.setup ?? ''}`.trim());
  const env = loadEnv();

  const res = await safeFetch(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: imageBuffer.toString('base64') },
          features: [{ type: 'WEB_DETECTION', maxResults: 25 }],
        },
      ],
    }),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`Vision API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = (await res.json()) as { responses?: Array<{ webDetection?: unknown; error?: { message?: string } }> };
  const first = data.responses?.[0];
  if (first?.error) throw new Error(`Vision API error: ${first.error.message ?? 'unknown'}`);
  return parseWebDetection((first?.webDetection ?? {}) as Parameters<typeof parseWebDetection>[0]);
}
