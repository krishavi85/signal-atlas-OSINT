'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface MediaRow {
  id: string;
  kind: string;
  sourceUrl: string | null;
  status: string;
  format: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  perceptualHash: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  capturedAt: string | null;
  exifJson: Record<string, unknown> | null;
  visionText: string | null;
  transcript: string | null;
  durationSec: number | null;
  duplicateOfId: string | null;
  clusterId: string | null;
  note: string | null;
  error: string | null;
  evidenceId: string | null;
  _count: { duplicates: number };
}

interface MediaStatus {
  total: number;
  byStatus: Record<string, number>;
  vision: { available: boolean; reason?: string };
  transcription: { available: boolean; reason?: string };
  capabilities: Record<string, unknown>;
}

export function MediaTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const status = useApi<MediaStatus>(`/projects/${projectId}/media/status`);
  const { data, error, loading, reload } = useApi<{ items: MediaRow[]; clusters: Array<{ clusterId: string; count: number; memberIds: string[] }> }>(
    `/projects/${projectId}/media`,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [useVision, setUseVision] = useState(false);
  const [useTranscribe, setUseTranscribe] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function process() {
    setProcessing(true);
    try {
      await api(`/projects/${projectId}/media/process`, { method: 'POST', body: JSON.stringify({ vision: useVision, transcribe: useTranscribe }) });
      setTimeout(() => { void reload(); void status.reload(); }, 3000);
      setTimeout(() => { void reload(); void status.reload(); }, 9000);
    } finally {
      setProcessing(false);
    }
  }

  async function upload(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    await fetch(`/api/v1/projects/${projectId}/media`, { method: 'POST', body: fd });
    setTimeout(() => void reload(), 3000);
    if (fileRef.current) fileRef.current.value = '';
  }

  const gpsCount = (data?.items ?? []).filter((m) => m.gpsLat != null).length;

  return (
    <div className="space-y-4">
      <div className="card p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-300">Media intelligence (§19)</span>
          <Badge tone="green">image metadata</Badge>
          <Badge tone="green">EXIF / GPS</Badge>
          <Badge tone="green">perceptual-hash dedup</Badge>
          <Badge tone={status.data?.vision.available ? 'green' : 'neutral'}>
            OCR / description {status.data?.vision.available ? '(vision model)' : '— needs a multimodal model'}
          </Badge>
          <Badge tone={status.data?.transcription.available ? 'green' : 'neutral'}>
            video/audio transcription {status.data?.transcription.available ? '(ffmpeg + Whisper)' : '— unavailable'}
          </Badge>
          <Badge tone="red">no facial identification (by policy)</Badge>
        </div>
        {status.data && !status.data.vision.available && status.data.vision.reason && (
          <p className="mt-1 text-slate-500">{status.data.vision.reason}</p>
        )}
        {status.data && !status.data.transcription.available && status.data.transcription.reason && (
          <p className="mt-1 text-slate-500">{status.data.transcription.reason}</p>
        )}
        {gpsCount > 0 && (
          <p className="mt-1 text-amber-400">⚠️ {gpsCount} image(s) contain embedded GPS coordinates — treat as location data.</p>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" onClick={process} disabled={processing}>
            {processing ? 'Queued…' : 'Process media'}
          </button>
          {status.data?.vision.available && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} />
              run vision OCR / description (uses the AI provider)
            </label>
          )}
          {status.data?.transcription.available && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="checkbox" checked={useTranscribe} onChange={(e) => setUseTranscribe(e.target.checked)} />
              transcribe video/audio (Whisper)
            </label>
          )}
          <span className="text-xs text-slate-600">|</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="text-xs text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-ink-800 file:px-2 file:py-1 file:text-slate-200"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </div>
      )}

      {data && data.clusters.length > 0 && (
        <div className="rounded border border-ink-700 bg-ink-900 p-3 text-xs">
          <p className="font-semibold text-slate-300">Perceptual duplicate clusters ({data.clusters.length})</p>
          {data.clusters.map((c) => (
            <p key={c.clusterId} className="text-slate-500">
              {c.count} near-identical images — {c.memberIds.slice(0, 4).map((id) => id.slice(0, 6)).join(', ')}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div>
          {loading ? (
            <Spinner />
          ) : error ? (
            <ErrorState error={error} retry={reload} />
          ) : !data || data.items.length === 0 ? (
            <EmptyState
              title="No media yet"
              hint="Media referenced by evidence (thumbnails, post images) is collected automatically after a search — click Process media, or upload an image."
            />
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {data.items.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  className={`group relative aspect-square overflow-hidden rounded border ${selected === m.id ? 'border-accent' : 'border-ink-700'}`}
                >
                  {m.kind === 'IMAGE' ? <MediaThumb media={m} /> : <MediaKindPlaceholder kind={m.kind} />}
                  <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-0.5 bg-black/60 p-0.5">
                    {m.duplicateOfId && <Badge tone="amber">dup</Badge>}
                    {m.gpsLat != null && <Badge tone="red">GPS</Badge>}
                    {m.status === 'ERROR' && <Badge tone="red">err</Badge>}
                    {m.status === 'SKIPPED' && <Badge tone="neutral">{m.kind}</Badge>}
                    {m.visionText && <Badge tone="violet">OCR</Badge>}
                    {m.transcript && <Badge tone="violet">transcript</Badge>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="lg:sticky lg:top-20 lg:self-start">
          {selected ? (
            <MediaInspector mediaId={selected} canEdit={canEdit} onDeleted={() => { setSelected(null); void reload(); }} />
          ) : (
            <div className="card p-4 text-sm text-slate-500">Select an image to see its metadata, EXIF, and any extracted text.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function MediaThumb({ media }: { media: { id: string; sourceUrl: string | null } }) {
  // Always load through our own endpoint: it serves the stored bytes (or
  // redirects to the public source) and carries auth — avoids hotlink / CORS
  // issues with CDN thumbnail hosts.
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    fetch(`/api/v1/media/${media.id}/file`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [media.id]);
  if (failed) return <div className="flex h-full items-center justify-center bg-ink-950 text-[10px] text-slate-600">no preview</div>;
  if (!src) return <div className="h-full w-full animate-pulse bg-ink-850" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />;
}

function MediaKindPlaceholder({ kind }: { kind: string }) {
  const label = kind === 'VIDEO' ? '▶ video' : kind === 'AUDIO' ? '♪ audio' : kind;
  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 text-[11px] text-slate-500">
      {label}
    </div>
  );
}

function MediaInspector({ mediaId, canEdit, onDeleted }: { mediaId: string; canEdit: boolean; onDeleted: () => void }) {
  const { data, loading, error } = useApi<
    MediaRow & { evidence: { id: string; title: string | null; url: string | null } | null; duplicates: Array<{ id: string; sourceUrl: string | null }> }
  >(`/media/${mediaId}`, [mediaId]);
  if (loading) return <div className="card p-4"><Spinner /></div>;
  if (error) return <div className="card p-4"><ErrorState error={error} /></div>;
  if (!data) return null;

  return (
    <div className="card space-y-3 p-4 text-sm">
      {data.kind === 'IMAGE' ? <MediaThumb media={data} /> : <MediaKindPlaceholder kind={data.kind} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-600">Status</dt><dd className="text-slate-300">{data.status}{data.error ? ` — ${data.error}` : ''}</dd>
        <dt className="text-slate-600">Format</dt><dd className="text-slate-300">{data.format ?? '—'} {data.width && data.height ? `· ${data.width}×${data.height}` : ''} {data.byteSize ? `· ${(data.byteSize / 1024).toFixed(0)} KB` : ''}</dd>
        <dt className="text-slate-600">Perceptual hash</dt><dd className="font-mono text-slate-400">{data.perceptualHash ?? '—'}</dd>
        <dt className="text-slate-600">Captured</dt><dd className="text-slate-300">{data.capturedAt ? new Date(data.capturedAt).toLocaleString() : '—'}</dd>
        <dt className="text-slate-600">GPS</dt>
        <dd className={data.gpsLat != null ? 'text-amber-300' : 'text-slate-300'}>
          {data.gpsLat != null ? (
            <a href={`https://www.openstreetmap.org/?mlat=${data.gpsLat}&mlon=${data.gpsLon}#map=15/${data.gpsLat}/${data.gpsLon}`} target="_blank" rel="noreferrer" className="hover:underline">
              {data.gpsLat.toFixed(5)}, {data.gpsLon?.toFixed(5)} ↗
            </a>
          ) : (
            'none'
          )}
        </dd>
      </dl>

      {data.sourceUrl && (
        <a href={data.sourceUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-accent hover:underline">
          {data.sourceUrl}
        </a>
      )}

      {data.exifJson && Object.keys(data.exifJson).length > 0 && (
        <div className="text-xs">
          <p className="mb-1 font-semibold text-slate-400">EXIF</p>
          <ul className="text-slate-500">
            {Object.entries(data.exifJson).map(([k, v]) => (
              <li key={k}>
                {k}: {String(v)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.visionText && (
        <div className="text-xs">
          <p className="mb-1 font-semibold text-slate-400">Vision model — visible text &amp; description</p>
          <pre className="whitespace-pre-wrap rounded bg-ink-950 p-2 font-sans text-slate-400">{data.visionText}</pre>
          <p className="mt-1 text-[10px] text-slate-600">Produced by a multimodal model; person identity is never inferred (§19/§30).</p>
        </div>
      )}

      {data.transcript && (
        <div className="text-xs">
          <p className="mb-1 font-semibold text-slate-400">
            Transcript (Whisper){data.durationSec ? ` — ${Math.round(data.durationSec)}s` : ''}
          </p>
          <pre className="whitespace-pre-wrap rounded bg-ink-950 p-2 font-sans text-slate-400">{data.transcript}</pre>
        </div>
      )}

      {data.duplicateOfId && <p className="text-xs text-amber-400">Perceptual duplicate of {data.duplicateOfId.slice(0, 8)} — not counted separately.</p>}
      {data.duplicates.length > 0 && <p className="text-xs text-slate-500">{data.duplicates.length} other copy/copies in this project.</p>}

      {data.evidence && (
        <p className="text-xs text-slate-500">
          From evidence <span className="font-mono">{data.evidence.id}</span>
        </p>
      )}

      {canEdit && (
        <button
          className="btn-ghost py-0.5 text-xs text-red-400"
          onClick={async () => {
            if (!confirm('Delete this media asset?')) return;
            await api(`/media/${mediaId}`, { method: 'DELETE' });
            onDeleted();
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
