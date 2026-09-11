import { parseMarkdownBlocks, stripInlineMarkup, type MdBlock } from './markdownBlocks.js';

export interface RenderableSection {
  heading: string;
  body: string;
  aiGenerated: boolean;
  ungrounded?: string[];
}

// ── PDF (pdfkit — pure JS, no native deps, no headless-browser dependency) ──

export async function renderReportPdf(title: string, generatedAt: string, sections: RenderableSection[]): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ margin: 54, size: 'A4', bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Helvetica-Bold').fontSize(20).text(title);
  doc.font('Helvetica').fontSize(9).fillColor('#666').text(`Generated ${generatedAt} · OSINT Platform`);
  doc.fillColor('#000');
  doc.moveDown(1);

  for (const section of sections) {
    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111')
      .text(section.heading + (section.aiGenerated ? '  (AI narrative — evidence-grounded)' : ''));
    doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);
    doc.fillColor('#000').font('Helvetica').fontSize(10);

    for (const block of parseMarkdownBlocks(section.body)) {
      renderBlockPdf(doc, block);
    }

    if (section.ungrounded && section.ungrounded.length > 0) {
      doc.moveDown(0.3);
      doc.fillColor('#8a6d00').font('Helvetica-Oblique').fontSize(9);
      doc.text('Statements the citation validator could not ground in the provided evidence (not fact):');
      for (const u of section.ungrounded) doc.text(`• ${u}`, { indent: 12 });
      doc.fillColor('#000').font('Helvetica').fontSize(10);
    }
  }

  // page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#999')
      .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 36, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
      });
  }

  doc.end();
  return done;
}

function renderBlockPdf(doc: PDFKit.PDFDocument, block: MdBlock): void {
  switch (block.type) {
    case 'heading':
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(15 - block.level).text(stripInlineMarkup(block.text));
      doc.font('Helvetica').fontSize(10);
      return;
    case 'paragraph':
      doc.text(stripInlineMarkup(block.text), { align: 'left' }).moveDown(0.3);
      return;
    case 'list':
      for (const item of block.items) doc.text(`•  ${stripInlineMarkup(item)}`, { indent: 10 });
      doc.moveDown(0.3);
      return;
    case 'blockquote':
      doc
        .font('Helvetica-Oblique')
        .fillColor('#555')
        .text(block.lines.map(stripInlineMarkup).join(' '), { indent: 12 })
        .fillColor('#000')
        .font('Helvetica')
        .moveDown(0.3);
      return;
    case 'table':
      renderTablePdf(doc, block.header, block.rows);
      return;
  }
}

function renderTablePdf(doc: PDFKit.PDFDocument, header: string[], rows: string[][]): void {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / header.length;
  doc.font('Helvetica-Bold').fontSize(8);
  const startX = doc.page.margins.left;
  let y = doc.y;
  header.forEach((h, i) => doc.text(truncate(stripInlineMarkup(h), colWidth), startX + i * colWidth, y, { width: colWidth - 4 }));
  doc.moveDown(0.2);
  doc.moveTo(startX, doc.y).lineTo(startX + usableWidth, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(8);

  for (const row of rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    y = doc.y;
    const rowHeight = Math.max(
      ...row.map((cell, i) => doc.heightOfString(truncate(stripInlineMarkup(cell), colWidth), { width: colWidth - 4 })),
    );
    row.forEach((cell, i) => doc.text(truncate(stripInlineMarkup(cell), colWidth), startX + i * colWidth, y, { width: colWidth - 4 }));
    doc.y = y + rowHeight + 4;
  }
  doc.moveDown(0.4);
}

function truncate(s: string, colWidthPx: number): string {
  const maxChars = Math.max(8, Math.floor(colWidthPx / 4.2));
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

// ── DOCX (the `docx` package — pure JS OOXML writer) ────────────────────────

export async function renderReportDocx(title: string, generatedAt: string, sections: RenderableSection[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = await import('docx');

  const children: InstanceType<typeof Paragraph | typeof Table>[] = [];
  children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  children.push(
    new Paragraph({
      children: [new TextRun({ text: `Generated ${generatedAt} · OSINT Platform`, italics: true, color: '666666', size: 18 })],
    }),
  );

  for (const section of sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 300 },
        children: [
          new TextRun({ text: section.heading }),
          ...(section.aiGenerated ? [new TextRun({ text: '  (AI narrative — evidence-grounded)', italics: true, size: 18, color: '666666' })] : []),
        ],
      }),
    );

    for (const block of parseMarkdownBlocks(section.body)) {
      children.push(...blockToDocx(block, { Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle }));
    }

    if (section.ungrounded && section.ungrounded.length > 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'Statements the citation validator could not ground (not fact):', italics: true, color: '8A6D00' })],
        }),
      );
      for (const u of section.ungrounded) {
        children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: u, italics: true, color: '8A6D00' })] }));
      }
    }
  }

  const doc = new Document({ sections: [{ children: children as never }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blockToDocx(block: MdBlock, lib: any): any[] {
  const { Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = lib;
  switch (block.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: block.level <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: [new TextRun({ text: stripInlineMarkup(block.text) })],
        }),
      ];
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun({ text: stripInlineMarkup(block.text) })] })];
    case 'list':
      return block.items.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: stripInlineMarkup(item) })] }));
    case 'blockquote':
      return [
        new Paragraph({
          indent: { left: 360 },
          children: [new TextRun({ text: block.lines.map(stripInlineMarkup).join(' '), italics: true, color: '555555' })],
        }),
      ];
    case 'table': {
      const noBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
      const borders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder };
      const headerRow = new TableRow({
        children: block.header.map(
          (h: string) =>
            new TableCell({ borders, children: [new Paragraph({ children: [new TextRun({ text: stripInlineMarkup(h), bold: true })] })] }),
        ),
      });
      const rows = block.rows.map(
        (row: string[]) =>
          new TableRow({
            children: row.map(
              (cell) => new TableCell({ borders, children: [new Paragraph({ children: [new TextRun({ text: stripInlineMarkup(cell) })] })] }),
            ),
          }),
      );
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...rows] }), new Paragraph({ text: '' })];
    }
  }
}
