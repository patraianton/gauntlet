// Reviewer validity (SPEC 12.2) and quote grounding (12.3) as computed by ingest.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../../lib/core/hash.mjs';
import { normalizeLine } from '../../lib/material/lint.mjs';
import { reviewerRecord, findingsOf, normaliseFile } from '../../lib/engine/ingest.mjs';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function copyDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plin-'));
  made.push(d);
  fs.mkdirSync(path.join(d, 'content'));
  fs.writeFileSync(path.join(d, 'content', 'page.md'), '# Offer\nThe package of three costs 50 EUR.\nThe offer ends on 31 October.\n');
  fs.writeFileSync(path.join(d, 'content', 'plan.json'), JSON.stringify({ posts: [{ caption: 'Book now — «the best» price' }] }));
  return d;
}

const LENS = { id: 'facts', minimum: [{ id: 'M1', kind: 'all-files', glob: 'content/*' }, { id: 'M2', kind: 'action', rule: 'recompute sums' }] };
const REQS = [{ id: 'R01' }, { id: 'R02' }];
const JOB = {
  job: 'abcdefgh',
  lens: 'facts',
  attempt: 1,
  challenges: [
    { id: 'Q1', kind: 'line', file: 'content/page.md', line: 2, expectedSha256: sha256Hex(normalizeLine('The package of three costs 50 EUR.')) },
    { id: 'Q2', kind: 'count', glob: 'content/*', expected: 2 },
    { id: 'Q3', kind: 'line', file: 'content/page.md', line: 3, expectedSha256: sha256Hex(normalizeLine('The offer ends on 31 October.')) },
  ],
};

function answer(over = {}) {
  return {
    schemaVersion: 1,
    nonce: 'PL-AAAA-BBBB',
    receipt: [
      { id: 'Q1', answer: 'The package of three costs 50 EUR.' },
      { id: 'Q2', answer: '2' },
      { id: 'Q3', answer: '  The offer ends on 31 October. ' },
    ],
    inspected: [
      { minimumId: 'M1', done: true, how: 'opened both files line by line' },
      { minimumId: 'M2', done: true, how: 'recomputed the one sum on the page' },
    ],
    sourceChecks: [],
    requirements: [{ id: 'R01', status: 'present', where: 'x' }, { id: 'R02', status: 'absent', where: 'y' }],
    findings: [
      { n: 1, severity: 'major', kind: 'number', location: { file: 'content/page.md', locator: 'line 2' }, quote: 'costs  50 EUR', problem: 'wrong sum', fix: '45' },
      { n: 2, severity: 'major', kind: 'fact', location: { file: 'content/page.md', locator: 'line 9' }, quote: 'Free coffee for everyone', problem: 'invented', fix: '-' },
      { n: 3, severity: 'blocker', kind: 'omission', location: { file: 'content/plan.json', locator: '/posts' }, quote: null, missingWhat: 'R02', problem: 'missing', fix: 'add' },
      { n: 4, severity: 'cosmetic', kind: 'language', location: { file: 'content/plan.json', locator: '/posts/0/caption' }, quote: 'Book now - "the best" price', problem: 'style', fix: 'x' },
    ],
    notVerified: [],
    notChecked: [],
    ...over,
  };
}

const BASE = (json, extra = {}) => ({ kept: true, json, reasons: [], answerSha256: 'h', metaMentions: [], ignoredScoreKeys: [], ...extra });

test('a complete answer is valid; quotes are grounded after normalisation; invented quote is not', () => {
  const d = copyDir();
  const rec = reviewerRecord(BASE(answer()), { job: JOB, lens: LENS, copyDir: d, requirements: REQS });
  assert.equal(rec.valid, true, rec.reasons.join('; '));
  assert.deepEqual(rec.receipts, { correct: 3, total: 3 });
  const g = Object.fromEntries(rec.quoteChecks.map((q) => [q.n, q.grounded]));
  assert.equal(g[1], true);
  assert.equal(g[2], false);
  assert.equal(g[3], null, 'omission: nothing to ground');
  assert.equal(g[4], true, 'quotes and dashes unified');
  assert.deepEqual(rec.counts, { blocker: 1, major: 2, cosmetic: 1 });
  const fs2 = findingsOf(BASE(answer()), rec, { round: 1, copyDir: d });
  assert.equal(fs2.find((f) => f.n === 2).grounded, false);
  assert.equal(fs2.find((f) => f.n === 3).grounded, true);
});

test('receipts: 2 of 3 is enough, 1 of 3 is not', () => {
  const d = copyDir();
  const two = answer({ receipt: [{ id: 'Q1', answer: 'nope' }, { id: 'Q2', answer: '2' }, { id: 'Q3', answer: 'The offer ends on 31 October.' }] });
  assert.equal(reviewerRecord(BASE(two), { job: JOB, lens: LENS, copyDir: d, requirements: REQS }).valid, true);
  const one = answer({ receipt: [{ id: 'Q1', answer: 'nope' }, { id: 'Q2', answer: '7' }, { id: 'Q3', answer: 'The offer ends on 31 October.' }] });
  const r = reviewerRecord(BASE(one), { job: JOB, lens: LENS, copyDir: d, requirements: REQS });
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((x) => /receipts 1\/3/.test(x)));
  assert.equal(r.kept, true, 'its findings still count');
});

test('minimum: a missing id is invalid; done:false makes the answer invalid too (the reason is still recorded)', () => {
  const d = copyDir();
  const miss = answer({ inspected: [{ minimumId: 'M1', done: true, how: 'opened both files line by line' }] });
  assert.equal(reviewerRecord(BASE(miss), { job: JOB, lens: LENS, copyDir: d, requirements: REQS }).valid, false);
  const notDone = answer({ inspected: [{ minimumId: 'M1', done: true, how: 'opened both files' }, { minimumId: 'M2', done: false, how: 'the calculator tool failed twice' }] });
  const r = reviewerRecord(BASE(notDone), { job: JOB, lens: LENS, copyDir: d, requirements: REQS });
  assert.equal(r.valid, false, 'a skipped minimum item cannot certify a clean lens');
  assert.deepEqual(r.minimumNotDone, ['M2']);
  assert.ok(r.reasons.some((x) => /minimum not done: M2/.test(x)), r.reasons.join('; '));
  const lazy = answer({ inspected: [{ minimumId: 'M1', done: true, how: 'opened both files' }, { minimumId: 'M2', done: false, how: 'no' }] });
  assert.equal(reviewerRecord(BASE(lazy), { job: JOB, lens: LENS, copyDir: d, requirements: REQS }).valid, false);
});

test('every requirement must be marked; a meta mention makes the attempt invalid', () => {
  const d = copyDir();
  const unmarked = answer({ requirements: [{ id: 'R01', status: 'present', where: 'x' }] });
  assert.equal(reviewerRecord(BASE(unmarked), { job: JOB, lens: LENS, copyDir: d, requirements: REQS }).valid, false);
  const meta = reviewerRecord(BASE(answer(), { metaMentions: ['M-CANARY: canary'] }), { job: JOB, lens: LENS, copyDir: d, requirements: REQS });
  assert.equal(meta.valid, false);
});

test('a discarded answer (schema, nonce, prompt edited) is neither kept nor valid', () => {
  const r = reviewerRecord({ kept: false, json: null, reasons: ['prompt-edited'], answerSha256: 'h', metaMentions: [], ignoredScoreKeys: [] }, { job: JOB, lens: LENS, copyDir: null, requirements: REQS });
  assert.equal(r.kept, false);
  assert.equal(r.valid, false);
  assert.deepEqual(findingsOf({ kept: false, json: null }, r, { round: 1 }), []);
});

test('normaliseFile: absolute paths inside the copy become copy-relative', () => {
  const d = copyDir();
  assert.equal(normaliseFile(d, path.join(d, 'content', 'page.md')), 'content/page.md');
  assert.equal(normaliseFile(d, '.\\content\\plan.json'), 'content/plan.json');
});
