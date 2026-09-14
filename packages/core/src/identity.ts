/**
 * Username-existence classification (WhatsMyName-style checks, §31).
 *
 * Pure and network-free: given the HTTP status + body already fetched for a
 * candidate profile URL, and the site's declared "found"/"not found" rule,
 * decide which of the two it actually matched. Kept separate from the fetch
 * itself so this logic — the part with real decision-making in it — is
 * unit-testable without mocking HTTP.
 */

export interface IdentityCheckRule {
  /** HTTP status expected when the profile exists. */
  eCode: number;
  /** Substring expected in the body when the profile exists ('' = status alone is decisive). */
  eString: string;
  /** HTTP status expected when the profile does not exist. */
  mCode: number;
  /** Substring expected in the body when the profile does not exist ('' = status alone is decisive). */
  mString: string;
}

export type IdentityCheckOutcome = 'FOUND' | 'NOT_FOUND' | 'UNKNOWN';

export function classifyIdentityCheck(status: number, body: string, rule: IdentityCheckRule): IdentityCheckOutcome {
  const matchesFound = status === rule.eCode && (rule.eString === '' || body.includes(rule.eString));
  const matchesNotFound = status === rule.mCode && (rule.mString === '' || body.includes(rule.mString));
  // A site can be misconfigured (or mid-outage) such that a response matches
  // both or neither rule; either way that's not a confident signal, so it's
  // reported as UNKNOWN rather than guessed at (§51 — no fabricated results).
  if (matchesFound && !matchesNotFound) return 'FOUND';
  if (matchesNotFound && !matchesFound) return 'NOT_FOUND';
  return 'UNKNOWN';
}

/**
 * Substitutes `{account}` into a WhatsMyName-style template string (URL,
 * POST body, or a header value), after stripping any characters the site
 * declares unsupported in an account name (e.g. Blogspot rejects `.` in the
 * subdomain it builds the check URL from).
 */
export function fillIdentityTemplate(template: string, username: string, stripBadChars?: string): string {
  let account = username;
  if (stripBadChars) {
    for (const ch of stripBadChars) account = account.split(ch).join('');
  }
  return template.split('{account}').join(account);
}
