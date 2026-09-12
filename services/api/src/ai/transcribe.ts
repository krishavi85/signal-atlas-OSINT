import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';

/**
 * Speech-to-text (§19 video/audio transcription). Deliberately independent of
 * AI_PROVIDER (which governs chat/synthesis) — an operator may run Ollama for
 * chat while still wanting Whisper for transcription, or vice versa. Only
 * OpenAI's Whisper API is wired; no other STT provider is implemented, so
 * this is honestly unavailable without OPENAI_API_KEY, never faked (§51).
 */

export interface TranscriptionStatus {
  available: boolean;
  provider: string | null;
  reason?: string;
  setup?: string;
}

export function transcriptionStatus(): TranscriptionStatus {
  const env = loadEnv();
  if (!env.OPENAI_API_KEY) {
    return {
      available: false,
      provider: null,
      reason: 'No speech-to-text provider configured.',
      setup: 'Set OPENAI_API_KEY (used only for the Whisper transcription API — independent of AI_PROVIDER).',
    };
  }
  return { available: true, provider: 'openai-whisper' };
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  durationSec: number | null;
}

/** Transcribe an audio buffer (already extracted from any video track) via OpenAI Whisper. */
export async function transcribeAudio(audio: Buffer, filename: string): Promise<TranscriptionResult> {
  const status = transcriptionStatus();
  if (!status.available) throw new Error(`Transcription unavailable: ${status.reason} ${status.setup ?? ''}`.trim());
  const env = loadEnv();

  const form = new FormData();
  form.append('file', new Blob([audio]), filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

  const res = await safeFetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
    timeoutMs: 180_000,
  });
  if (!res.ok) throw new Error(`Whisper API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string; language?: string; duration?: number };
  return { text: (data.text ?? '').trim(), language: data.language ?? null, durationSec: data.duration ?? null };
}
