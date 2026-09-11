/**
 * Minimal, dependency-free RFC 4180 CSV writer (§48 exports).
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0 && !columns) return '';
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const lines = [cols.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(formatValue(row[c]))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(formatValue).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeCell(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
