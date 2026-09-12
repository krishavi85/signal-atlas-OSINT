'use client';

import { useMemo, useState } from 'react';
import { parseBooleanQuery } from '@osint/core/boolean-query';
import { Badge, TagInput } from './ui';

interface Fields {
  all: string[]; // ANDed plain terms
  phrases: string[]; // "exact phrase"
  any: string[]; // (a OR b OR c)
  noneWords: string[]; // -word
  nonePhrases: string[]; // NOT "phrase"
  sites: string[]; // site:domain
  excludeDomains: string[]; // -domain.tld
  after: string;
  before: string;
  language: string;
}

const EMPTY_FIELDS: Fields = {
  all: [],
  phrases: [],
  any: [],
  noneWords: [],
  nonePhrases: [],
  sites: [],
  excludeDomains: [],
  after: '',
  before: '',
  language: '',
};

function compose(f: Fields): string {
  const parts: string[] = [];
  for (const t of f.all) parts.push(/\s/.test(t) ? `"${t}"` : t);
  for (const p of f.phrases) parts.push(`"${p}"`);
  if (f.any.length === 1) parts.push(f.any[0]!);
  else if (f.any.length > 1) parts.push(`(${f.any.join(' OR ')})`);
  for (const w of f.noneWords) parts.push(`-${w}`);
  for (const p of f.nonePhrases) parts.push(`NOT "${p}"`);
  for (const s of f.sites) parts.push(`site:${s}`);
  for (const d of f.excludeDomains) parts.push(`-${d}`);
  if (f.after) parts.push(`after:${f.after}`);
  if (f.before) parts.push(`before:${f.before}`);
  if (f.language) parts.push(`lang:${f.language}`);
  return parts.join(' ');
}

/** Best-effort: seed the builder fields from an existing raw query string via the real parser. */
function fieldsFromQuery(raw: string): Fields {
  if (!raw.trim()) return EMPTY_FIELDS;
  const p = parseBooleanQuery(raw);
  return {
    all: p.terms,
    phrases: p.phrases,
    any: [],
    noneWords: p.excludedTerms.filter((t) => !t.includes(' ')),
    nonePhrases: p.excludedTerms.filter((t) => t.includes(' ')),
    sites: p.siteFilters,
    excludeDomains: p.excludedDomains,
    after: p.dateAfter ?? '',
    before: p.dateBefore ?? '',
    language: p.language ?? '',
  };
}

/**
 * Boolean query input (§4) with two modes: a raw text field for power users,
 * and a structured "Builder" that composes the same syntax the parser
 * already accepts. The preview strip below always reflects what
 * parseBooleanQuery() actually does with the current text — never a
 * fabricated summary.
 */
export function QueryBuilder({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<'simple' | 'builder'>('simple');
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);

  function set<K extends keyof Fields>(key: K, v: Fields[K]) {
    const next = { ...fields, [key]: v };
    setFields(next);
    onChange(compose(next));
  }

  function enterBuilder() {
    setFields(fieldsFromQuery(value));
    setMode('builder');
  }

  const parsed = useMemo(() => (value.trim() ? parseBooleanQuery(value) : null), [value]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={`btn-ghost py-1 text-xs ${mode === 'simple' ? 'border-accent text-slate-100' : ''}`}
          onClick={() => setMode('simple')}
        >
          Simple
        </button>
        <button
          type="button"
          className={`btn-ghost py-1 text-xs ${mode === 'builder' ? 'border-accent text-slate-100' : ''}`}
          onClick={enterBuilder}
        >
          Builder
        </button>
      </div>

      {mode === 'simple' && (
        <input
          className="input text-base"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {mode === 'builder' && (
        <div className="card grid gap-3 p-3 sm:grid-cols-2">
          <div>
            <label className="label">All of these words</label>
            <TagInput values={fields.all} onChange={(v) => set('all', v)} placeholder="add a word, Enter" />
          </div>
          <div>
            <label className="label">Exact phrases</label>
            <TagInput values={fields.phrases} onChange={(v) => set('phrases', v)} placeholder="add a phrase, Enter" />
          </div>
          <div>
            <label className="label">Any of these words (OR)</label>
            <TagInput values={fields.any} onChange={(v) => set('any', v)} placeholder="add a word, Enter" />
          </div>
          <div>
            <label className="label">None of these words</label>
            <TagInput values={fields.noneWords} onChange={(v) => set('noneWords', v)} placeholder="add a word, Enter" />
          </div>
          <div>
            <label className="label">Exclude phrases</label>
            <TagInput values={fields.nonePhrases} onChange={(v) => set('nonePhrases', v)} placeholder="add a phrase, Enter" />
          </div>
          <div>
            <label className="label">Only from these sites</label>
            <TagInput values={fields.sites} onChange={(v) => set('sites', v)} placeholder="example.com, Enter" />
          </div>
          <div>
            <label className="label">Exclude domains</label>
            <TagInput values={fields.excludeDomains} onChange={(v) => set('excludeDomains', v)} placeholder="spam.com, Enter" />
          </div>
          <div>
            <label className="label">Language</label>
            <input className="input" value={fields.language} onChange={(e) => set('language', e.target.value)} placeholder="en" maxLength={5} />
          </div>
          <div>
            <label className="label">After date</label>
            <input type="date" className="input" value={fields.after} onChange={(e) => set('after', e.target.value)} />
          </div>
          <div>
            <label className="label">Before date</label>
            <input type="date" className="input" value={fields.before} onChange={(e) => set('before', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Generated query</label>
            <code className="block rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2 text-xs text-slate-300">
              {value || <span className="text-slate-600">(empty)</span>}
            </code>
          </div>
        </div>
      )}

      {parsed && (
        <div className="flex flex-wrap items-center gap-1.5">
          {parsed.terms.map((t) => (
            <Badge key={`t-${t}`}>{t}</Badge>
          ))}
          {parsed.phrases.map((p) => (
            <Badge key={`p-${p}`} tone="blue">
              &quot;{p}&quot;
            </Badge>
          ))}
          {parsed.excludedTerms.map((t) => (
            <Badge key={`x-${t}`} tone="red">
              −{t}
            </Badge>
          ))}
          {parsed.siteFilters.map((s) => (
            <Badge key={`s-${s}`} tone="violet">
              site:{s}
            </Badge>
          ))}
          {parsed.excludedDomains.map((d) => (
            <Badge key={`d-${d}`} tone="red">
              −{d}
            </Badge>
          ))}
          {parsed.dateAfter && <Badge tone="amber">after {parsed.dateAfter}</Badge>}
          {parsed.dateBefore && <Badge tone="amber">before {parsed.dateBefore}</Badge>}
          {parsed.language && <Badge tone="green">lang:{parsed.language}</Badge>}
          {parsed.warnings.map((w, i) => (
            <Badge key={`w-${i}`} tone="amber">
              ⚠ {w}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
