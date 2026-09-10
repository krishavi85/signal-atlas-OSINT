import { stripTags, extractHtmlMeta } from '@osint/connectors';

/**
 * Document text + metadata extraction (§20). Supported: PDF, DOCX, TXT, CSV,
 * JSON, HTML. Everything returns plain text plus a metadata bag; the raw file is
 * always retained in object storage.
 */
export type DocKind = 'PDF' | 'DOCX' | 'TXT' | 'CSV' | 'JSON' | 'HTML';

export interface ExtractedDoc {
  text: string;
  metadata: Record<string, unknown>;
  tables?: string[][][];
}

export function detectKind(filename: string, mime: string | undefined): DocKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'PDF';
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
  if (ext === 'csv' || mime === 'text/csv') return 'CSV';
  if (ext === 'json' || mime === 'application/json') return 'JSON';
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'HTML';
  if (ext === 'txt' || ext === 'md' || ext === 'text' || mime?.startsWith('text/')) return 'TXT';
  return null;
}

export async function extractDocument(kind: DocKind, data: Buffer): Promise<ExtractedDoc> {
  switch (kind) {
    case 'PDF':
      return extractPdf(data);
    case 'DOCX':
      return extractDocx(data);
    case 'HTML':
      return extractHtml(data.toString('utf8'));
    case 'CSV':
      return extractCsv(data.toString('utf8'));
    case 'JSON':
      return extractJson(data.toString('utf8'));
    case 'TXT':
      return { text: data.toString('utf8'), metadata: { encoding: 'utf8' } };
  }
}

async function extractPdf(data: Buffer): Promise<ExtractedDoc> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const uint8 = new Uint8Array(data);
  const pdf = await getDocumentProxy(uint8);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  return {
    text: Array.isArray(text) ? text.join('\n\n') : text,
    metadata: {
      pages: totalPages,
      title: info.Title ?? null,
      author: info.Author ?? null,
      creator: info.Creator ?? null,
      producer: info.Producer ?? null,
      creationDate: info.CreationDate ?? null,
      modDate: info.ModDate ?? null,
    },
  };
}

async function extractDocx(data: Buffer): Promise<ExtractedDoc> {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const result = await mammoth.extractRawText({ buffer: data });
  return { text: result.value, metadata: { warnings: result.messages.map((m) => m.message).slice(0, 20) } };
}

function extractHtml(html: string): ExtractedDoc {
  const meta = extractHtmlMeta(html);
  return {
    text: stripTags(html),
    metadata: {
      title: meta.title,
      author: meta.author,
      publishedAt: meta.publishedAt,
      description: meta.description,
      language: meta.language,
      canonical: meta.canonical,
    },
  };
}

/** RFC4180-ish CSV parser (handles quoted fields + embedded newlines). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function extractCsv(input: string): ExtractedDoc {
  const rows = parseCsv(input);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  // linearize into text so entity/claim extraction can run over it
  const text = body
    .map((r) => r.map((cell, i) => `${header[i] ?? `col${i}`}: ${cell}`).join(' | '))
    .join('\n');
  return {
    text: `${header.join(', ')}\n${text}`,
    metadata: { columns: header, rows: body.length },
    tables: [rows],
  };
}

function extractJson(input: string): ExtractedDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { text: input, metadata: { valid: false } };
  }
  const lines: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || typeof v !== 'object') {
      lines.push(`${path}: ${String(v)}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, path ? `${path}.${k}` : k);
  };
  walk(parsed, '');
  return { text: lines.join('\n'), metadata: { valid: true, keys: Array.isArray(parsed) ? parsed.length : Object.keys(parsed as object).length } };
}
