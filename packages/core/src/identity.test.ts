import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyIdentityCheck, fillIdentityTemplate } from './index.js';

const rule = { eCode: 200, eString: 'Repositories', mCode: 404, mString: 'Not Found' };

test('classifyIdentityCheck: status+string both match "found" rule', () => {
  assert.equal(classifyIdentityCheck(200, '<div>Repositories: 12</div>', rule), 'FOUND');
});

test('classifyIdentityCheck: status+string both match "not found" rule', () => {
  assert.equal(classifyIdentityCheck(404, '<h1>Not Found</h1>', rule), 'NOT_FOUND');
});

test('classifyIdentityCheck: status matches found but body lacks e_string is UNKNOWN, not a false FOUND', () => {
  assert.equal(classifyIdentityCheck(200, '<div>Rate limited</div>', rule), 'UNKNOWN');
});

test('classifyIdentityCheck: an unrelated status (e.g. 503 from a protection page) is UNKNOWN', () => {
  assert.equal(classifyIdentityCheck(503, 'Attention Required! | Cloudflare', rule), 'UNKNOWN');
});

test('classifyIdentityCheck: empty e_string/m_string means status alone is decisive', () => {
  const codeOnly = { eCode: 200, eString: '', mCode: 302, mString: '' };
  assert.equal(classifyIdentityCheck(200, 'anything', codeOnly), 'FOUND');
  assert.equal(classifyIdentityCheck(302, 'anything', codeOnly), 'NOT_FOUND');
  assert.equal(classifyIdentityCheck(500, 'anything', codeOnly), 'UNKNOWN');
});

test('fillIdentityTemplate: substitutes {account}, including inside a hostname', () => {
  assert.equal(fillIdentityTemplate('https://{account}.blogspot.com/?hl=en-US', 'jane.doe'), 'https://jane.doe.blogspot.com/?hl=en-US');
});

test('fillIdentityTemplate: strips declared bad characters from the username first', () => {
  assert.equal(fillIdentityTemplate('https://{account}.blogspot.com/?hl=en-US', 'jane.doe', '.'), 'https://janedoe.blogspot.com/?hl=en-US');
});

test('fillIdentityTemplate: multiple occurrences of {account} all get replaced', () => {
  assert.equal(fillIdentityTemplate('{account}-{account}', 'x'), 'x-x');
});
