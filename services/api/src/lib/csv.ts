/**
 * Minimal, dependency-free RFC 4180 CSV writer (§48 exports).
 *
 * Cell values in these exports originate from scraped/third-party content
 * (evidence titles, claim text, entity names, ...), so every cell is also
 * neutralized against CSV/spreadsheet formula injection (§40 "output
 * encoding"): a value starting with `= + - @` or a tab/CR (the characters
 * Excel/Sheets/LibreOffice treat as a formula prefix) gets a leading `'`
 * before RFC 4180 quoting is applied, so it opens as inert text instead of
 * executing as a formula when the file is opened in a spreadsheet.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0 && !columns) return '';
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const lines = [cols.map((c) => escapeCell(neutralizeFormula(c))).join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(neutralizeFormula(formatValue(row[c])))).join(','));
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

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function neutralizeFormula(s: string): string {
  return FORMULA_PREFIX.test(s) ? `'${s}` : s;
}

function escapeCell(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
