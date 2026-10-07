import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeChallenges, renderChallenges, checkReceipts, eligibleLines } from '../../lib/material/receipts.mjs';
import { normalizeLine } from '../../lib/material/lint.mjs';
import { sha256Hex } from '../../lib/core/hash.mjs';
import { tmpDir, put, makeMaterial, seededRng, PNG_BYTES } from '../fixtures/material/helpers.mjs';

const cc = (...c) => String.fromCharCode(...c);

const lens = {
  id: 'facts',
  minimum: [
    { id: 'M1', rule: 'read every post', kind: 'all-entries', glob: 'content/plan.json', pointer: '/posts' },
    { id: 'M2', rule: 'read the page in full', kind: 'all-files', glob: 'content/*.md' },
    { id: 'M3', rule: 'check prices against S1', kind: 'source-check', sourceId: 'S1' },
  ],
};

function copyDir(t) {
  const dir = tmpDir(t);
  makeMaterial(path.join(dir, 'content'));
  return dir;
}

/** The answer a careful reader would give (reads the copy). */
function honestAnswer(dir, c) {
  if (c.kind === 'line') return fs.readFileSync(path.join(dir, ...c.file.split('/')), 'utf8').replace(new RegExp('^' + cc(0xfeff)), '').split(/\r?\n/)[c.line - 1];
  return String(c.expected);
}

test('makeChallenges: 3 challenges, at least one line, ids Q1..Q3, expected line answers only hashed', (t) => {
  const dir = copyDir(t);
  const ch = makeChallenges({ copyDir: dir, lens, manifest: null, rng: seededRng(), n: 3 });
  assert.equal(ch.length, 3);
  assert.deepEqual(ch.map((c) => c.id), ['Q1', 'Q2', 'Q3']);
  assert.ok(ch.some((c) => c.kind === 'line'));
  for (const c of ch) {
    if (c.kind === 'line') {
      assert.match(c.expectedSha256, /^[0-9a-f]{64}$/);
      assert.ok(!('text' in c) && !('expected' in c), 'no plain expected line is stored');
      const line = honestAnswer(dir, c);
      assert.ok(normalizeLine(line).length >= 8 && line.length <= 300);
      assert.equal(sha256Hex(normalizeLine(line)), c.expectedSha256);
    } else {
      assert.equal(c.kind, 'count');
      assert.equal(typeof c.expected, 'number');
    }
  }
  // the rendered questions do not contain the expected answers
  const md = renderChallenges(ch);
  for (const c of ch.filter((x) => x.kind === 'line')) assert.ok(!md.includes(honestAnswer(dir, c).trim()));
  assert.match(md, /Q1\. /);
});

test('makeChallenges: same seed -> same challenges; another seed differs somewhere over a few tries', (t) => {
  const dir = copyDir(t);
  const a = makeChallenges({ copyDir: dir, lens, rng: seededRng('1111111111111111aaaaaaaaaaaaaaaa') });
  const b = makeChallenges({ copyDir: dir, lens, rng: seededRng('1111111111111111aaaaaaaaaaaaaaaa') });
  assert.deepEqual(a, b);
  const seeds = ['2222222222222222bbbbbbbbbbbbbbbb', '3333333333333333cccccccccccccccc', '4444444444444444dddddddddddddddd'];
  assert.ok(seeds.some((s) => JSON.stringify(makeChallenges({ copyDir: dir, lens, rng: seededRng(s) })) !== JSON.stringify(a)));
});

test('makeChallenges: counts read from the copy (glob and glob#pointer)', (t) => {
  const dir = copyDir(t);
  const onlyCounts = { minimum: [{ id: 'M1', kind: 'all-entries', glob: 'content/plan.json', pointer: '/posts' }, { id: 'M2', kind: 'all-files', glob: 'content/*.png' }] };
  // plan.json is a text file, so one line challenge is still asked
  const ch = makeChallenges({ copyDir: dir, lens: onlyCounts, rng: seededRng() });
  const counts = ch.filter((c) => c.kind === 'count');
  assert.equal(counts.length, 1);
  for (const c of counts) assert.equal(c.expected, c.pointer === '/posts' ? 12 : 1);
  assert.ok(ch.some((c) => c.kind === 'line'));
});

test('makeChallenges: no text files in the lens globs -> all count challenges', (t) => {
  const dir = tmpDir(t);
  put(dir, 'render/a.png', PNG_BYTES);
  put(dir, 'render/b.png', PNG_BYTES);
  put(dir, 'render/sub/c.png', PNG_BYTES);
  const visual = { minimum: [{ id: 'M1', kind: 'all-files', glob: 'render/*.png' }, { id: 'M2', kind: 'all-files', glob: 'render/**/*.png' }] };
  const ch = makeChallenges({ copyDir: dir, lens: visual, rng: seededRng(), n: 3 });
  assert.ok(ch.length >= 1 && ch.length <= 3);
  assert.ok(ch.every((c) => c.kind === 'count'));
  const expected = Object.fromEntries(ch.map((c) => [c.glob, c.expected]));
  if ('render/*.png' in expected) assert.equal(expected['render/*.png'], 2);
  if ('render/**/*.png' in expected) assert.equal(expected['render/**/*.png'], 3);
});

test('checkReceipts: whitespace and NFKC variants pass; wrong, missing and duplicated answers fail', (t) => {
  const dir = copyDir(t);
  const ch = makeChallenges({ copyDir: dir, lens, rng: seededRng() });
  const honest = ch.map((c) => ({ id: c.id, answer: honestAnswer(dir, c) }));
  assert.deepEqual(checkReceipts(ch, honest).correct, 3);
  assert.equal(checkReceipts(ch, honest).total, 3);

  const fuzzed = ch.map((c) => {
    const a = honestAnswer(dir, c);
    if (c.kind === 'line') return { id: c.id, answer: `   ${a.replace(/ /g, '  \t')}  ` };
    // fullwidth digits fold under NFKC only for lines; counts accept "12 posts" and numbers
    return { id: c.id, answer: `${a} entries` };
  });
  assert.equal(checkReceipts(ch, fuzzed).correct, 3);

  const lineCh = { id: 'Q1', kind: 'line', file: 'x', line: 1, expectedSha256: sha256Hex(normalizeLine('Price 12 EUR')) };
  assert.equal(checkReceipts([lineCh], [{ id: 'Q1', answer: `Price ${cc(0xff11, 0xff12)} EUR` }]).correct, 1, 'NFKC');
  assert.equal(checkReceipts([lineCh], [{ id: 'Q1', answer: 'Price 13 EUR' }]).correct, 0);

  const countCh = { id: 'Q2', kind: 'count', glob: 'a/*', expected: 12 };
  assert.equal(checkReceipts([countCh], [{ id: 'Q2', answer: 12 }]).correct, 1);
  assert.equal(checkReceipts([countCh], [{ id: 'Q2', answer: ' 12 ' }]).correct, 1);
  assert.equal(checkReceipts([countCh], [{ id: 'Q2', answer: '12.5' }]).correct, 0);
  assert.equal(checkReceipts([countCh], [{ id: 'Q2', answer: '11 or 12' }]).correct, 0);
  assert.equal(checkReceipts([countCh], []).correct, 0);
  assert.equal(checkReceipts([countCh], [{ id: 'Q2', answer: '12' }, { id: 'Q2', answer: '12' }]).correct, 0, 'duplicated id');

  const hollow = checkReceipts(ch, ch.map((c) => ({ id: c.id, answer: 'not checked' })));
  assert.equal(hollow.correct, 0);
});

test('eligibleLines: 8..300 characters, non-empty after normalisation', (t) => {
  const dir = tmpDir(t);
  const f = put(dir, 'a.md', `short\n\n   \n${'x'.repeat(301)}\nexactly8\n  spaced out line  \n`);
  const lines = eligibleLines(f).map((l) => l.line);
  assert.deepEqual(lines, [5, 6]);
});
