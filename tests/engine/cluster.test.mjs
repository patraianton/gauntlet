// Deterministic clustering (SPEC 12.4) and requirement clusters (SPEC 12.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings, attachMembers, requirementClusters, requirementClaims, belongTogether, quotesOverlap, normQuote } from '../../lib/engine/cluster.mjs';

let n = 0;
const F = (over = {}) => ({
  round: 1,
  lens: 'facts',
  job: 'jjjjjjjj',
  n: ++n,
  severity: 'major',
  kind: 'number',
  file: 'content/page.md',
  locator: '',
  quote: null,
  problem: 'p',
  fix: 'f',
  grounded: true,
  ...over,
});

test('an equal locator alone never merges findings; overlapping quotes in the same file do; different files never', () => {
  const a = F({ locator: 'Post 7', quote: 'aaaa bbbb' });
  const b = F({ locator: ' post  7 ', quote: 'zzzz yyyy', lens: 'language' });
  const b2 = F({ locator: 'post 8', quote: 'aaaa bbbb', lens: 'language' });
  const c = F({ file: 'content/plan.json', locator: 'Post 7', quote: 'aaaa bbbb' });
  assert.equal(belongTogether(a, b), false, 'same locator, different text: two problems');
  assert.equal(belongTogether(a, b2), true, 'same quoted text: one problem');
  assert.equal(belongTogether(a, c), false);
  const { clusters } = clusterFindings([a, b, b2, c], [], 1);
  assert.equal(clusters.length, 3);
});

test('a blocker sharing a locator with another lens\'s cosmetic remark keeps its own cluster and claim', () => {
  const typo = F({ lens: 'copy', severity: 'cosmetic', locator: 'Section 3', quote: 'The basic report costs 4.90 EUR', problem: 'Typo: EUR should be the euro sign' });
  const cap = F({ lens: 'facts', severity: 'blocker', locator: 'Section 3', quote: 'Total budget: 900 EUR per month', problem: 'Budget contradicts the owner cap of 500 EUR' });
  const { clusters } = clusterFindings([typo, cap], [], 1);
  assert.equal(clusters.length, 2);
  const blocker = clusters.find((c) => c.claimedSeverity === 'blocker');
  assert.equal(blocker.problem, 'Budget contradicts the owner cap of 500 EUR');
});

test('quotes: substring or a common run of 12+ characters', () => {
  assert.equal(quotesOverlap('Пакет из трёх проверок: 50 €', 'трёх проверок'), true);
  assert.equal(quotesOverlap('the offer ends on 15 November this year', 'it ends on 15 November, they say'), true);
  assert.equal(quotesOverlap('completely different text', 'nothing in common here'), false);
  assert.equal(normQuote('«Цена» — 15 €'), '"Цена" - 15 €');
});

test('omission findings: cluster by requirement id, never by locator alone', () => {
  const a = F({ kind: 'omission', locator: 'post 4', missingWhat: 'R02: call to action' });
  const b = F({ kind: 'omission', locator: 'post 9', missingWhat: 'missing R02 in post 9' });
  const c = F({ kind: 'omission', locator: 'post 5', missingWhat: 'a caveat' });
  assert.equal(belongTogether(a, b), true);
  assert.equal(belongTogether(a, c), false);
  const d = F({ kind: 'omission', locator: 'post 4', missingWhat: 'no price list' });
  assert.equal(belongTogether(a, d), false, 'same place, different missing thing');
});

test('ids in (file, locator) order; claimed = max severity; representative = highest class, then lowest lens id, lowest n', () => {
  const x1 = F({ file: 'content/z.md', locator: 'b', lens: 'zeta', n: 1, severity: 'cosmetic', quote: 'one two three four' });
  const x2 = F({ file: 'content/z.md', locator: 'b', lens: 'alpha', n: 5, severity: 'blocker', quote: 'one two three four five', problem: 'from alpha' });
  const y = F({ file: 'content/a.md', locator: 'a', quote: 'other text here' });
  const { clusters } = clusterFindings([x1, x2, y], [], 4);
  assert.deepEqual(clusters.map((c) => c.id), ['C-04-01', 'C-04-02']);
  assert.equal(clusters[0].file, 'content/a.md');
  assert.equal(clusters[1].claimedSeverity, 'blocker');
  assert.equal(clusters[1].problem, 'from alpha');
  assert.equal(clusters[1].members.length, 2);
  assert.equal(clusters[1].status, 'pending');
});

test('a finding overlapping an existing open cluster is attached, not a new cluster', () => {
  const old = { id: 'C-01-03', origin: 'finding', file: 'content/page.md', locator: 'prices', quote: '3 × 15 € = 50 €', kind: 'number', members: [], claimedSeverity: 'major', status: 'open', severity: 'major' };
  const f = F({ quote: '3 × 15 € = 50 €', locator: 'line 12', severity: 'blocker' });
  const res = clusterFindings([f], [old], 2);
  assert.equal(res.clusters.length, 0);
  assert.equal(res.attached.length, 1);
  const merged = attachMembers([old], res.attached);
  assert.equal(merged[0].members.length, 1);
  assert.equal(merged[0].claimedSeverity, 'blocker');
});

const REQS = [
  { id: 'R01', text: 'Twelve posts', taskQuote: '12 posts', ifMissing: 'blocker' },
  { id: 'R02', text: 'A call to action', taskQuote: 'call to action', ifMissing: 'major' },
  { id: 'R03', text: 'Prices agree', taskQuote: 'prices', ifMissing: 'blocker' },
];
const A = (lens, marks) => ({ job: `${lens}xxxxx`.slice(0, 8), lens, round: 1, requirements: Object.entries(marks).map(([id, status]) => ({ id, status })) });

test('requirement claims: absent -> ifMissing; only partial -> major; cannot-tell from all -> major', () => {
  const claims = requirementClaims(
    [A('facts', { R01: 'absent', R02: 'partial', R03: 'cannot-tell' }), A('generalist', { R01: 'present', R02: 'present', R03: 'cannot-tell' })],
    REQS,
  );
  const by = Object.fromEntries(claims.map((c) => [c.requirementId, c.claimed]));
  assert.deepEqual(by, { R01: 'blocker', R02: 'major', R03: 'major' });
  const none = requirementClaims([A('facts', { R01: 'present', R02: 'present', R03: 'present' })], REQS);
  assert.equal(none.length, 0);
});

test('requirement clusters: one per requirement per run, reused and reopened across rounds', () => {
  const r1 = requirementClusters([A('facts', { R01: 'absent', R02: 'present', R03: 'present' })], REQS, [], 1, { startIndex: 3 });
  assert.deepEqual(r1.created, ['C-01-03']);
  const c = r1.clusters[0];
  assert.equal(c.origin, 'requirement');
  assert.equal(c.claimedSeverity, 'blocker');
  const closed = r1.clusters.map((x) => ({ ...x, status: 'closed' }));
  const r2 = requirementClusters([A('language', { R01: 'partial', R02: 'present', R03: 'present' })], REQS, closed, 2);
  assert.deepEqual(r2.created, []);
  assert.deepEqual(r2.reopened, ['C-01-03']);
  assert.equal(r2.clusters[0].status, 'pending');
  assert.equal(r2.clusters[0].claimedSeverity, 'major');
  assert.equal(r2.clusters[0].members.length, 2);
});
