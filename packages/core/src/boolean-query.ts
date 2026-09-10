/**
 * Boolean search query parser (§4).
 *
 * Supports:  AND  OR  NOT  "exact phrase"  site:domain  -domain  before:YYYY-MM-DD
 *            after:YYYY-MM-DD  lang:xx  ( grouping )
 * Implicit operator between adjacent terms is AND.
 *
 * Produces an AST plus a flattened view (positive terms, phrases, excluded
 * domains, site filters, date range) that simple connectors can consume when
 * they cannot execute full Boolean logic. Connectors advertise which they
 * support via capabilities().
 */

export type QueryNode =
  | { type: 'term'; value: string }
  | { type: 'phrase'; value: string }
  | { type: 'not'; child: QueryNode }
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] };

export interface ParsedQuery {
  ast: QueryNode | null;
  raw: string;
  phrases: string[];
  terms: string[];
  excludedTerms: string[];
  siteFilters: string[]; // site:example.com
  excludedDomains: string[]; // -example.com
  dateAfter: string | null;
  dateBefore: string | null;
  language: string | null;
  warnings: string[];
}

interface Token {
  kind: 'WORD' | 'PHRASE' | 'AND' | 'OR' | 'NOT' | 'LPAREN' | 'RPAREN';
  value: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBooleanQuery(input: string): ParsedQuery {
  const raw = input.trim();
  const warnings: string[] = [];
  const result: ParsedQuery = {
    ast: null,
    raw,
    phrases: [],
    terms: [],
    excludedTerms: [],
    siteFilters: [],
    excludedDomains: [],
    dateAfter: null,
    dateBefore: null,
    language: null,
    warnings,
  };
  if (!raw) return result;

  const tokens = tokenize(raw, result, warnings);
  const parser = new Parser(tokens, warnings);
  result.ast = parser.parseExpression();
  if (parser.pos < parser.tokens.length) {
    warnings.push(`Unexpected trailing input near "${parser.tokens[parser.pos]?.value ?? ''}"`);
  }
  if (result.ast) collectFlat(result.ast, result, false);
  dedupeArrays(result);
  return result;
}

function tokenize(input: string, out: ParsedQuery, warnings: string[]): Token[] {
  const tokens: Token[] = [];
  const re = /"([^"]*)"|\(|\)|([^\s()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ kind: 'PHRASE', value: m[1].trim() });
      continue;
    }
    if (m[0] === '(') {
      tokens.push({ kind: 'LPAREN', value: '(' });
      continue;
    }
    if (m[0] === ')') {
      tokens.push({ kind: 'RPAREN', value: ')' });
      continue;
    }
    const word = m[2]!;
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      tokens.push({ kind: upper as Token['kind'], value: upper });
      continue;
    }
    // Field-prefixed operators are consumed here, not passed to the AST.
    if (word.startsWith('site:')) {
      out.siteFilters.push(word.slice(5).toLowerCase());
      continue;
    }
    if (word.startsWith('before:')) {
      const d = word.slice(7);
      if (DATE_RE.test(d)) out.dateBefore = d;
      else warnings.push(`Ignored malformed date filter "${word}" (expected before:YYYY-MM-DD)`);
      continue;
    }
    if (word.startsWith('after:')) {
      const d = word.slice(6);
      if (DATE_RE.test(d)) out.dateAfter = d;
      else warnings.push(`Ignored malformed date filter "${word}" (expected after:YYYY-MM-DD)`);
      continue;
    }
    if (word.startsWith('lang:')) {
      out.language = word.slice(5).toLowerCase().slice(0, 5);
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      const body = word.slice(1);
      if (body.includes('.')) out.excludedDomains.push(body.toLowerCase());
      else tokens.push({ kind: 'NOT', value: 'NOT' }), tokens.push({ kind: 'WORD', value: body });
      continue;
    }
    tokens.push({ kind: 'WORD', value: word });
  }
  return tokens;
}

class Parser {
  pos = 0;
  constructor(
    public tokens: Token[],
    private warnings: string[],
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  // expression := orExpr
  parseExpression(): QueryNode | null {
    return this.parseOr();
  }

  private parseOr(): QueryNode | null {
    let left = this.parseAnd();
    const children: QueryNode[] = left ? [left] : [];
    while (this.peek()?.kind === 'OR') {
      this.pos++;
      const right = this.parseAnd();
      if (right) children.push(right);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { type: 'or', children };
  }

  private parseAnd(): QueryNode | null {
    const children: QueryNode[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.kind === 'RPAREN' || t.kind === 'OR') break;
      if (t.kind === 'AND') {
        this.pos++;
        continue;
      }
      const node = this.parseUnary();
      if (node) children.push(node);
      else break;
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { type: 'and', children };
  }

  private parseUnary(): QueryNode | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'NOT') {
      this.pos++;
      const child = this.parseUnary();
      return child ? { type: 'not', child } : null;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'LPAREN') {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.kind === 'RPAREN') this.pos++;
      else this.warnings.push('Unbalanced parenthesis');
      return inner;
    }
    if (t.kind === 'PHRASE') {
      this.pos++;
      return { type: 'phrase', value: t.value };
    }
    if (t.kind === 'WORD') {
      this.pos++;
      return { type: 'term', value: t.value };
    }
    return null;
  }
}

function collectFlat(node: QueryNode, out: ParsedQuery, negated: boolean): void {
  switch (node.type) {
    case 'term':
      (negated ? out.excludedTerms : out.terms).push(node.value);
      break;
    case 'phrase':
      if (!negated) out.phrases.push(node.value);
      else out.excludedTerms.push(node.value);
      break;
    case 'not':
      collectFlat(node.child, out, !negated);
      break;
    case 'and':
    case 'or':
      for (const c of node.children) collectFlat(c, out, negated);
      break;
  }
}

function dedupeArrays(r: ParsedQuery): void {
  r.terms = [...new Set(r.terms)];
  r.phrases = [...new Set(r.phrases)];
  r.excludedTerms = [...new Set(r.excludedTerms)];
  r.siteFilters = [...new Set(r.siteFilters)];
  r.excludedDomains = [...new Set(r.excludedDomains)];
}

/** Render a plain-keyword string for connectors that cannot do Boolean logic. */
export function toPlainQuery(p: ParsedQuery): string {
  const parts = [...p.phrases.map((x) => `"${x}"`), ...p.terms];
  return parts.join(' ').trim() || p.raw;
}
