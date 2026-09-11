/**
 * Parse the small Markdown subset our own report generator produces
 * (headings, paragraphs, bullet lists, pipe tables, blockquotes) into a
 * structured block list. Shared by the PDF, DOCX, and HTML report renderers
 * so all three stay in sync with one parser instead of three regex passes.
 */
export type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'blockquote'; lines: string[] };

export function parseMarkdownBlocks(md: string): MdBlock[] {
  const lines = md.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ type: 'heading', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) {
        tableLines.push(lines[i]!.trim());
        i++;
      }
      const rows = tableLines
        .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));
      const [header, ...body] = rows;
      if (header) blocks.push({ type: 'table', header, rows: body });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const qLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        qLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: qLines });
      continue;
    }

    // paragraph: accumulate until blank line / next block start
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i]!.trim()) &&
      !/^\|.*\|$/.test(lines[i]!.trim()) &&
      !/^[-*]\s+/.test(lines[i]!.trim()) &&
      !/^>\s?/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ').trim() });
  }

  return blocks;
}

/** Strip markdown inline emphasis/code markers for plain-text renderers (PDF/DOCX). */
export function stripInlineMarkup(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
}
