import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectClaimConflict, extractClaimsHeuristic, normalizeClaimObject, splitSentences } from './index.js';

const known = [
  { type: 'COMPANY', value: 'Acme Robotics' },
  { type: 'COMPANY', value: 'Globex' },
  { type: 'PERSON', value: 'Jane Roe' },
];

test('splitSentences', () => {
  const s = splitSentences('Acme Robotics was founded in 2019. It raised $40 million in 2023! Globex acquired it.');
  assert.equal(s.length, 3);
});

test('extractClaimsHeuristic: entity-anchored subject required', () => {
  const claims = extractClaimsHeuristic(
    'Acme Robotics was founded in 2019. Acme Robotics announced a new warehouse robot. ' +
      'Some unrelated startup launched a phone. Globex acquired Acme Robotics.',
    known,
  );
  const preds = claims.map((c) => `${c.subject}:${c.predicate}:${c.object}`);
  assert.ok(preds.some((p) => p.startsWith('Acme Robotics:FOUNDED_IN:2019')));
  assert.ok(preds.some((p) => p.startsWith('Acme Robotics:ANNOUNCED')));
  assert.ok(preds.some((p) => p.startsWith('Globex:ACQUIRED')));
  // "Some unrelated startup" is not a known entity -> no claim
  assert.ok(!preds.some((p) => p.toLowerCase().includes('unrelated')));
  assert.ok(claims.every((c) => c.confidence > 0 && c.confidence <= 1));
});

test('extractClaimsHeuristic: founding year populates claimDate', () => {
  const [claim] = extractClaimsHeuristic('Acme Robotics was founded in 2019 by a group of engineers.', known);
  assert.equal(claim?.predicate, 'FOUNDED_IN');
  assert.equal(claim?.claimDate, '2019');
});

test('normalizeClaimObject: RAISED scales amounts', () => {
  assert.equal(normalizeClaimObject('RAISED', '$40 million'), String(40_000_000));
  assert.equal(normalizeClaimObject('RAISED', '$1.5 billion'), String(1_500_000_000));
  assert.equal(normalizeClaimObject('FOUNDED_IN', 'early 2019'), '2019');
});

test('detectClaimConflict: founding-year mismatch is HIGH; announcements never conflict', () => {
  const c2019 = { id: 'a', subject: 'Acme Robotics', predicate: 'FOUNDED_IN', object: '2019', claimDate: '2019' };
  const c2020 = { id: 'b', subject: 'Acme Robotics', predicate: 'FOUNDED_IN', object: '2020', claimDate: '2020' };
  const conflict = detectClaimConflict(c2019, c2020);
  assert.equal(conflict.conflicts, true);
  assert.equal(conflict.confidence, 'HIGH');

  const same = detectClaimConflict(c2019, { ...c2019, id: 'c' });
  assert.equal(same.conflicts, false);

  const ann1 = { id: 'd', subject: 'Acme Robotics', predicate: 'ANNOUNCED', object: 'a robot', claimDate: null };
  const ann2 = { id: 'e', subject: 'Acme Robotics', predicate: 'ANNOUNCED', object: 'a partnership', claimDate: null };
  assert.equal(detectClaimConflict(ann1, ann2).conflicts, false);

  const diffSubject = detectClaimConflict(c2019, { ...c2020, subject: 'Globex' });
  assert.equal(diffSubject.conflicts, false);
});

test('detectClaimConflict: descriptive predicate flagged LOW for review', () => {
  const a = { id: 'a', subject: 'Acme Robotics', predicate: 'BASED_IN', object: 'Berlin', claimDate: null };
  const b = { id: 'b', subject: 'Acme Robotics', predicate: 'BASED_IN', object: 'Munich', claimDate: null };
  const r = detectClaimConflict(a, b);
  assert.equal(r.conflicts, true);
  assert.equal(r.confidence, 'LOW');
});
