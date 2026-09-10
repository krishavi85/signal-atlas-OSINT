'use client';

import { useRef, useState } from 'react';
import { api, tokenStore } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui';

interface DocRow {
  id: string;
  kind: string;
  originalName: string;
  byteSize: number;
  status: string;
  error: string | null;
  createdAt: string;
  metadataJson: Record<string, unknown> | null;
}

export function DocumentsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data, error, loading, reload } = useApi<DocRow[]>(`/projects/${projectId}/documents`);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/v1/projects/${projectId}/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenStore.access}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `Upload failed (${res.status})`);
      }
      // poll until the ingest job settles
      setTimeout(() => void reload(), 1500);
      setTimeout(() => void reload(), 4000);
      await reload();
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Add a document (§20)</h3>
        <p className="mt-1 text-xs text-slate-500">
          PDF, DOCX, TXT, CSV, JSON, HTML. Text + metadata are extracted, an evidence record is created, and entity /
          claim extraction runs over it.
        </p>
        {canEdit ? (
          <div className="mt-3 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.htm"
              className="text-xs text-slate-400 file:mr-3 file:rounded file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-slate-200"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            {uploading && <Spinner label="Uploading & ingesting…" />}
          </div>
        ) : (
          <p className="mt-2 text-xs text-amber-400">Viewer access — uploading requires EDITOR.</p>
        )}
        {uploadErr && <p className="mt-2 text-xs text-red-400">{uploadErr}</p>}
      </div>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No documents" hint="Upload a file to add it to the evidence base." />
      ) : (
        <ul className="space-y-2">
          {data.map((d) => (
            <li key={d.id} className="card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">{d.kind}</Badge>
                <span className="font-medium text-slate-100">{d.originalName}</span>
                <span className="text-[11px] text-slate-600">{(d.byteSize / 1024).toFixed(0)} KB</span>
                <Badge tone={d.status === 'PROCESSED' ? 'green' : d.status === 'ERROR' ? 'red' : 'amber'}>{d.status}</Badge>
                <span className="ml-auto flex gap-2 text-[11px]">
                  <a href={`/api/v1/documents/${d.id}/download`} className="text-accent hover:underline">
                    download
                  </a>
                  {canEdit && (
                    <button
                      className="text-red-400 hover:underline"
                      onClick={async () => {
                        if (!confirm(`Delete "${d.originalName}" and its extracted evidence?`)) return;
                        await api(`/documents/${d.id}`, { method: 'DELETE' });
                        void reload();
                      }}
                    >
                      delete
                    </button>
                  )}
                </span>
              </div>
              {d.error && <p className="mt-1 text-xs text-red-400">{d.error}</p>}
              {d.metadataJson && (
                <p className="mt-1 text-[11px] text-slate-600">
                  {Object.entries(d.metadataJson)
                    .filter(([, v]) => v != null && typeof v !== 'object')
                    .slice(0, 6)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
