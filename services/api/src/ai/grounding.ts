import { EVIDENCE_ID_RE, type EpistemicTag } from '@osint/core';

/**
 * Evidence grounding + anti-hallucination (§13, §14, §47).
 *
 * Every AI call that produces factual output receives numbered evidence blocks
 * and must cite them inline as [E<n>]. `validateCitations` maps citations back
 * to evidence ids and flags any factual statement that has no citation — those
 * are surfaced to the user, never silently kept.
 */

export interface EvidenceBlock {
  ref: string; // "E1"
  evidenceId: string; // "EVIDENCE-2026-000001"
  source: string | null;
  sourceTier: string | null;
  publishedAt: string | null;
  url: string | null;
  text: string;
}

export function buildEvidenceContext(
  items: Array<{
    id: string;
    title: string | null;
    excerpt: string | null;
    fullText: string | null;
    url: string | null;
    publishedAt: Date | string | null;
    source?: { label: string | null; tier: string | null } | null;
  }>,
  perItemChars = 700,
): { blocks: EvidenceBlock[]; prompt: string } {
  const blocks: EvidenceBlock[] = items.map((it, i) => {
    const body = (it.fullText ?? it.excerpt ?? it.title ?? '').replace(/\s+/g, ' ').trim().slice(0, perItemChars);
    return {
      ref: `E${i + 1}`,
      evidenceId: it.id,
      source: it.source?.label ?? null,
      sourceTier: it.source?.tier ?? null,
      publishedAt: it.publishedAt ? new Date(it.publishedAt).toISOString().slice(0, 10) : null,
      url: it.url,
      text: body,
    };
  });
  const prompt = blocks
    .map(
      (b) =>
        `[${b.ref}] ${b.evidenceId}${b.source ? ` — ${b.source}` : ''}${b.sourceTier ? ` (${b.sourceTier})` : ''}${
          b.publishedAt ? ` — ${b.publishedAt}` : ''
        }\n"${b.text}"`,
    )
    .join('\n\n');
  return { blocks, prompt };
}

export interface CitationValidation {
  /** statements that carry at least one valid [E<n>] */
  grounded: Array<{ text: string; evidenceIds: string[] }>;
  /** factual-looking statements with no valid citation — these are flagged, not shown as fact */
  ungrounded: string[];
  /** every evidence id actually cited anywhere in the output */
  evidenceIdsUsed: string[];
  /** citations that pointed at a block number outside the provided range */
  invalidRefs: string[];
}

const CITATION_RE = /\[((?:E\d+)(?:\s*,\s*E\d+)*)\]/g;
// statements that are explicitly non-factual / gap markers are exempt from the citation requirement
const GAP_MARKERS =
  /\b(not found in the searched sources|insufficient evidence|unverified|no evidence|not enough information|could not be (?:found|confirmed)|unknown)\b/i;
const HEADING_RE = /^\s*(#{1,6}\s|\d+\.\s+[A-Z]|[-*]\s*$|[A-Z][A-Z \-/]{4,}:?\s*$)/;

export function validateCitations(aiText: string, blocks: EvidenceBlock[]): CitationValidation {
  const refToId = new Map(blocks.map((b) => [b.ref.toUpperCase(), b.evidenceId]));
  const grounded: CitationValidation['grounded'] = [];
  const ungrounded: string[] = [];
  const used = new Set<string>();
  const invalid = new Set<string>();

  // split into statements: bullet lines or sentences
  const lines = aiText.split(/\r?\n/);
  const statements: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || HEADING_RE.test(t)) continue;
    // split a paragraph into sentences but keep citation brackets attached
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/);
    for (const p of parts) if (p.trim().length > 3) statements.push(p.trim());
  }

  for (const stmt of statements) {
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(stmt)) !== null) {
      for (const ref of m[1]!.split(/\s*,\s*/)) {
        const id = refToId.get(ref.toUpperCase());
        if (id) {
          ids.push(id);
          used.add(id);
        } else {
          invalid.add(ref.toUpperCase());
        }
      }
    }
    const stripped = stmt.replace(CITATION_RE, '').trim();
    if (ids.length > 0) {
      grounded.push({ text: stripped, evidenceIds: [...new Set(ids)] });
    } else if (GAP_MARKERS.test(stmt) || EVIDENCE_ID_RE.test(stmt) || stmt.length < 25) {
      // gap markers, or a bare evidence-id line, or very short fragments — exempt
    } else {
      ungrounded.push(stripped);
    }
  }

  return { grounded, ungrounded, evidenceIdsUsed: [...used], invalidRefs: [...invalid] };
}

// ── prompt contracts ────────────────────────────────────────────────────────

export const SUMMARY_SYSTEM = `You are an OSINT research analyst. You will be given numbered evidence blocks and a question.

RULES (strict):
- Answer ONLY from the evidence blocks provided. Do not use outside knowledge.
- After EVERY factual sentence, cite the block(s) it came from as [E1] or [E2, E5].
- If the evidence does not answer part of the question, say exactly: "Not found in the searched sources." — do not guess.
- Prefix each finding with an epistemic tag in brackets: [FACT] only if multiple independent blocks agree; otherwise [SOURCE] (one source says it), [INFERENCE] (you derived it), or [UNKNOWN].
- Be concise. No preamble, no "based on the evidence" filler.
- Never invent evidence ids, dates, names, or numbers.`;

export const EXPAND_SYSTEM = `You are an OSINT query planner. Given a research subject and what has been found so far, propose additional search queries that would surface NEW information.

RULES:
- Output a JSON object: {"queries": [{"query": "...", "rationale": "..."}]}
- 3 to 8 queries. Each must be a concrete search string (may use quotes, site:, -domain).
- Do not repeat queries already listed as executed.
- Rationale: one short sentence on what gap this query addresses.
- No commentary outside the JSON.`;

export const REPORT_NARRATIVE_SYSTEM = `You are an OSINT analyst writing one section of an intelligence report from numbered evidence blocks.

RULES (strict):
- Use ONLY the evidence blocks. Cite every factual sentence as [E1] / [E2, E4].
- Distinguish what a source said, what multiple sources confirm, and what you inferred. Tag inferences [INFERENCE].
- State uncertainties and gaps explicitly ("Not found in the searched sources.").
- No outside knowledge. No invented specifics. 2-4 short paragraphs maximum.`;

export function epistemicTagFromText(line: string): EpistemicTag {
  const m = /\[(FACT|SOURCE|CLAIM|INFERENCE|HYPOTHESIS|UNKNOWN)\]/i.exec(line);
  return (m?.[1]?.toUpperCase() as EpistemicTag) ?? 'SOURCE';
}
