/**
 * Deterministic claim extraction (§10).
 *
 * IMPORTANT (§51): this is shallow, rule-based sentence matching — NOT a trained
 * model. Output is tagged `DETERMINISTIC_EXTRACTION` and every claim is
 * "pending verification" until the CorroborationEngine scores it. Patterns are
 * intentionally conservative: the subject must correspond to a known entity so
 * we do not manufacture claims from arbitrary prose.
 */

export interface KnownEntityRef {
  type: string;
  value: string; // canonical value or alias, lowercased by the caller not required
}

export interface ExtractedClaim {
  subject: string;
  predicate: ClaimPredicate;
  object: string;
  /** ISO date or bare year string when the sentence carried one */
  claimDate: string | null;
  /** the sentence rendered as the claim text */
  text: string;
  /** the exact source sentence */
  sentence: string;
  confidence: number; // 0..1 for THIS extractor
  subjectEntityValue: string | null; // which known entity matched, if any
}

export const CLAIM_PREDICATES = [
  'ANNOUNCED',
  'LAUNCHED',
  'ACQUIRED',
  'FOUNDED_IN',
  'RAISED',
  'BASED_IN',
  'PARTNERED_WITH',
  'APPOINTED',
  'IS_A',
  'OWNS',
  'RENAMED_TO',
] as const;
export type ClaimPredicate = (typeof CLAIM_PREDICATES)[number];

interface Pattern {
  predicate: ClaimPredicate;
  re: RegExp;
  confidence: number;
  /** which capture group is the object */
  objectGroup: number;
  /** treat capture group N as a date/year */
  dateGroup?: number;
}

// Sentence-level patterns. `^(.+?)` captures a candidate subject at the start.
const PATTERNS: Pattern[] = [
  { predicate: 'ANNOUNCED', re: /^(.+?)\s+(?:has\s+)?announced\s+(?:that\s+)?(.+)$/i, confidence: 0.5, objectGroup: 2 },
  { predicate: 'LAUNCHED', re: /^(.+?)\s+(?:has\s+)?(?:launched|unveiled|released|introduced|debuted)\s+(.+)$/i, confidence: 0.5, objectGroup: 2 },
  { predicate: 'ACQUIRED', re: /^(.+?)\s+(?:has\s+)?(?:acquired|bought|purchased|took over)\s+(.+)$/i, confidence: 0.55, objectGroup: 2 },
  { predicate: 'FOUNDED_IN', re: /^(.+?)\s+(?:was\s+)?(?:founded|established|incorporated|created|started)\s+in\s+((?:early |late |mid[- ])?\d{4})\b(.*)$/i, confidence: 0.6, objectGroup: 2, dateGroup: 2 },
  { predicate: 'RAISED', re: /^(.+?)\s+(?:has\s+)?(?:raised|secured|closed)\s+(?:a\s+)?(\$[\d.,]+\s*(?:million|billion|m|bn|k)?(?:\s+(?:in\s+)?(?:seed|series\s+[a-e]|funding|round))?)/i, confidence: 0.55, objectGroup: 2 },
  { predicate: 'BASED_IN', re: /^(.+?)\s+is\s+(?:based|headquartered|located)\s+in\s+(.+)$/i, confidence: 0.5, objectGroup: 2 },
  { predicate: 'PARTNERED_WITH', re: /^(.+?)\s+(?:has\s+)?partnered\s+with\s+(.+)$/i, confidence: 0.5, objectGroup: 2 },
  { predicate: 'APPOINTED', re: /^(.+?)\s+(?:has\s+)?(?:appointed|named|hired|promoted)\s+(.+?)\s+as\s+(.+)$/i, confidence: 0.5, objectGroup: 2 },
  { predicate: 'RENAMED_TO', re: /^(.+?)\s+(?:was\s+)?(?:renamed|rebranded)\s+(?:to|as)\s+(.+)$/i, confidence: 0.55, objectGroup: 2 },
  { predicate: 'OWNS', re: /^(.+?)\s+owns\s+(.+)$/i, confidence: 0.45, objectGroup: 2 },
];

const YEAR_RE = /\b(19|20)\d{2}\b/;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const LONG_DATE_RE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'"])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 400);
}

function findDate(sentence: string): string | null {
  const iso = ISO_DATE_RE.exec(sentence)?.[0];
  if (iso) return iso;
  const long = LONG_DATE_RE.exec(sentence)?.[0];
  if (long) {
    const t = Date.parse(long);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  const year = YEAR_RE.exec(sentence)?.[0];
  return year ?? null;
}

/** Does `subjectText` reference one of the known entities? Returns the matched value. */
function matchSubject(subjectText: string, known: KnownEntityRef[]): string | null {
  const s = subjectText.toLowerCase().replace(/^(the|a|an)\s+/i, '').trim();
  if (s.length < 2 || s.length > 80) return null;
  for (const k of known) {
    const v = k.value.toLowerCase();
    if (v.length < 3) continue;
    if (s === v || s.startsWith(v + ' ') || s.endsWith(' ' + v) || s.includes(' ' + v + ' ')) return k.value;
    // subject phrase contained in a longer entity name
    if (v.startsWith(s + ' ') && s.length >= 4) return k.value;
  }
  return null;
}

export function extractClaimsHeuristic(text: string, knownEntities: KnownEntityRef[]): ExtractedClaim[] {
  if (!text) return [];
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(text)) {
    for (const p of PATTERNS) {
      const m = p.re.exec(sentence);
      if (!m) continue;
      const rawSubject = (m[1] ?? '').trim().replace(/[,;:]$/, '');
      let object = (m[p.objectGroup] ?? '').trim().replace(/[.,;:]+$/, '');
      if (!rawSubject || !object || object.length > 200) continue;

      const subjectEntityValue = matchSubject(rawSubject, knownEntities);
      // Require an entity-anchored subject to avoid manufacturing claims.
      if (!subjectEntityValue) continue;

      const subject = subjectEntityValue;
      if (p.predicate === 'FOUNDED_IN') object = (YEAR_RE.exec(m[2] ?? '')?.[0]) ?? object;

      const key = `${subject}|${p.predicate}|${object.toLowerCase().slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        subject,
        predicate: p.predicate,
        object,
        claimDate: p.predicate === 'FOUNDED_IN' ? (YEAR_RE.exec(object)?.[0] ?? findDate(sentence)) : findDate(sentence),
        text: `${subject} — ${p.predicate.replace(/_/g, ' ').toLowerCase()} — ${object}`,
        sentence,
        confidence: p.confidence,
        subjectEntityValue,
      });
    }
  }
  return out;
}

/** Normalize a claim object for equality / contradiction comparison. */
export function normalizeClaimObject(predicate: ClaimPredicate, object: string): string {
  const o = object.toLowerCase().trim();
  if (predicate === 'FOUNDED_IN') return (YEAR_RE.exec(o)?.[0] ?? o).replace(/(early|late|mid)[- ]/g, '');
  if (predicate === 'RAISED') {
    const num = o.replace(/[^0-9.]/g, '');
    const scale = /billion|bn/.test(o) ? 1e9 : /million|\bm\b/.test(o) ? 1e6 : /\bk\b/.test(o) ? 1e3 : 1;
    const val = parseFloat(num) * scale;
    return Number.isFinite(val) && val > 0 ? String(val) : o;
  }
  return o.replace(/^(the|a|an)\s+/, '').replace(/[.,;:]+$/, '');
}
