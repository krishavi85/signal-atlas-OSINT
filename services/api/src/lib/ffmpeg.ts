import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Thin, safe wrapper around a system `ffmpeg` binary (§19 video/audio
 * transcription). All arguments are passed as an argv array (never through a
 * shell), so there is no shell-injection surface even though the input
 * extension is derived from a user-supplied URL.
 */

let cached: boolean | null = null;

/** Cached for the process lifetime — a missing/present binary doesn't change at runtime. */
export async function ffmpegAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  cached = await new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false)); // ENOENT: not installed / not on PATH
    p.on('exit', (code) => resolve(code === 0));
  });
  return cached;
}

function sanitizeExt(ext: string): string {
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean.slice(0, 5) || 'bin';
}

/** Extract a mono 16kHz mp3 audio track from an arbitrary audio/video buffer. */
export async function extractAudioTrack(input: Buffer, inputExt: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'osint-media-'));
  const inPath = join(dir, `in.${sanitizeExt(inputExt)}`);
  const outPath = join(dir, 'out.mp3');
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-i', inPath, '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', outPath]);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
