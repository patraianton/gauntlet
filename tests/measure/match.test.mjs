import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stage1, mergeMatcher, buildMatcherPairs, outcome, findingsMatched, distinctiveTokens, commonSubstrings, pairCounts } from '../../lib/measure/match.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';

function copyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-match-'));
  fs.mkdirSync(path.join(dir, 'content'));
  const lines = [];
  for (let i = 1; i <= 12; i++) lines.push(`Post ${i}: a short caption about family cars under 7 000 € with a clear offer.`);
  lines[3] = 'Post 4 sum: 9 180 + 600 + 210 + 200 = 10 290 € — that is the whole bill.';
  lines[6] = 'Post 7: Fresh bread from 4.20 €. Thanks for reading.';
  fs.writeFileSync(path.join(dir, 'content', 'page.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'content', 'mirror.html'), '<p>= 10 290 € — that is the whole bill.</p>\n');
  return dir;
}

const C1 = {
  canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', file: 'content/page.md', locator: 'post 4',
  before: '= 10 190 € — that is the whole bill.', after: '= 10 290 € — that is the whole bill.', description: 'wrong total', prePlanted: false,
};
const C2 = {
  canary: 'C2', slot: 'S2', purpose: 'measurement', targetLens: 'conversion', type: 'OMIT-REQ', file: 'content/page.md', locator: 'post 7',
  before: 'Post 7: Fresh bread from 4.20 €. Write LOAF and we will reply today. Thanks for reading.',
  after: 'Post 7: Fresh bread from 4.20 €. Thanks for reading.', description: 'call to action removed from post 7', prePlanted: false,
};

const f = (n, file, locator, quote, problem, severity = 'major', extra = {}) => ({ n, severity, kind: 'fact', location: { file, locator }, quote, problem, fix: 'fix it', ...extra });

const JOBS = {
  jfacts01: { lens: 'facts', attempt: 1, findings: [f(1, 'content/page.md', 'post 4', '= 10 290 € — that is the whole', 'The total should be 10 190, not 10 290.', 'blocker')] },
  jlang001: { lens: 'language', attempt: 1, findings: [f(1, 'content/page.md', 'line 4', '10 290 € — that', 'The sum 10 290 looks off', 'cosmetic')] },
  jconv001: { lens: 'conversion', attempt: 1, findings: [f(2, 'content/page.md', 'post 4', 'Post 4 sum', 'The arithmetic line is confusing for readers', 'major')] },
  jgen0001: { lens: 'generalist', attempt: 1, findings: [f(3, 'content/mirror.html', 'p', '= 10 290 € — that is the whole', 'Mirror page shows the price', 'major')] },
  jgrow001: { lens: 'growth', attempt: 1, findings: [] },
};

test('outcome rule: caught at or above the floor, seen_underclassified below, missed when unmatched', () => {
  assert.equal(outcome('blocker', 'major', true), 'caught');
  assert.equal(outcome('major', 'major', true), 'caught');
  assert.equal(outcome('major', 'blocker', true), 'seen_underclassified');
  assert.equal(outcome('cosmetic', 'major', true), 'seen_underclassified');
  assert.equal(outcome('blocker', 'major', false), 'missed');
});

test('helpers: distinctive tokens and substrings touching the changed span', () => {
  assert.deepEqual([...distinctiveTokens('= 10 190 €', '= 10 290 €')].sort(), ['190', '290']);
  // "abcdefgh" shares 8 chars with after; the changed span [3, 4) is inside it
  assert.equal(commonSubstrings('xxabcdefghyy', 'abcdefgh', 3, 4).maxChanged, 8);
  assert.equal(commonSubstrings('xxabcyy', 'abcdefgh', 3, 4).maxChanged, 0);
  // pure deletion at 4: the substring must cross the join
  assert.equal(commonSubstrings('abcdefgh', 'abcdefgh', 4, 4).maxChanged, 8);
  assert.equal(commonSubstrings('abcd', 'abcdefgh', 4, 4).maxChanged, 0);
});

test('stage 1: code decides distinctive catches; others go to the matcher; empty jobs miss', () => {
  const dir = copyDir();
  try {
    const r = stage1([C1], JOBS, { copyDir: dir });
    const byJob = Object.fromEntries(r.decided.map((d) => [d.job, d]));
    assert.equal(byJob.jfacts01.outcome, 'caught');
    assert.equal(byJob.jfacts01.stage, 'code');
    assert.equal(byJob.jfacts01.finding, 1);
    assert.equal(byJob.jfacts01.severityGiven, 'blocker');
    assert.equal(byJob.jlang001.outcome, 'seen_underclassified', 'cosmetic is below the major floor');
    assert.equal(byJob.jgrow001.outcome, 'missed');
    const pend = Object.fromEntries(r.needMatcher.map((p) => [p.job, p]));
    assert.ok(pend.jconv001, 'equal locator, no distinctive token -> matcher');
    assert.ok(pend.jgen0001, 'quote of the canary in a mirror file -> matcher, never code');
    assert.equal(pend.jgen0001.findings[0].finding, 'jgen0001#3');
    assert.deepEqual(r.unmatched, []);
    for (const d of r.decided) {
      const ok = validate(loadSchema('detections'), { schemaVersion: 1, round: 1, detections: [d] });
      assert.ok(ok.ok, JSON.stringify(ok.errors));
    }
    const pairs = buildMatcherPairs(r.needMatcher, [C1]);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0].findings.map((x) => x.finding).sort(), ['jconv001#2', 'jgen0001#3']);
    assert.equal('severity' in pairs[0].findings[0], false, 'matcher never sees severities');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finding that only QUOTES the planted line while describing another problem is not a code catch', () => {
  const dir = copyDir();
  try {
    const jobs = {
      jcta0001: { lens: 'conversion', attempt: 1, findings: [f(1, 'content/page.md', 'post 4', '= 10 290 € — that is the whole bill.', 'No call to action follows the price; the reader is not told where to buy.', 'major')] },
    };
    const r = stage1([C1], jobs, { copyDir: dir });
    assert.equal(r.decided.filter((d) => d.stage === 'code').length, 0, 'the changed token appears only in the copied quote');
    assert.equal(r.needMatcher.length, 1, 'the pair goes to the matcher, which can keep it as a real problem (alsoReal)');
    const det = mergeMatcher(r.decided, { pairs: [{ canary: 'C1', finding: 'jcta0001#1', score: 2, alsoReal: true, why: 'same line, different complaint' }] }, r.needMatcher);
    const m = findingsMatched(det, { pairs: [{ canary: 'C1', finding: 'jcta0001#1', score: 2, alsoReal: true, why: 'x' }] });
    assert.ok(!m.remove.includes('jcta0001#1'), 'the real problem stays in the pipeline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('target lens with findings in the file but no candidate goes to the matcher', () => {
  const dir = copyDir();
  try {
    const jobs = { jfacts02: { lens: 'facts', attempt: 2, findings: [f(5, 'content/page.md', 'post 9', 'Post 9: a short', 'Post 9 repeats post 8', 'major')] } };
    const r = stage1([C1], jobs, { copyDir: dir });
    assert.equal(r.decided.length, 0);
    assert.equal(r.needMatcher.length, 1);
    assert.equal(r.needMatcher[0].attempt, 2);
    const other = stage1([C1], { jx: { lens: 'language', attempt: 1, findings: jobs.jfacts02.findings } }, { copyDir: dir });
    assert.equal(other.decided[0].outcome, 'missed');
    assert.deepEqual(other.unmatched, ['C1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omission canaries: omission findings overlapping the removed text, quotes near the removal point', () => {
  const dir = copyDir();
  try {
    const jobs = [
      { job: 'jconv001', lens: 'conversion', attempt: 1, findings: [f(1, 'content/page.md', 'post 7', null, 'Post 7 has no call to action: "Write LOAF and we will reply today" is missing.', 'major', { kind: 'omission', missingWhat: 'Write LOAF and we will reply today at the end of post 7' })] },
      { job: 'jfacts01', lens: 'facts', attempt: 1, findings: [f(2, 'content/page.md', 'post seven', 'Fresh bread from 4.20 €', 'Ends abruptly', 'major')] },
      { job: 'jlang001', lens: 'language', attempt: 1, findings: [f(3, 'content/page.md', 'post 12', 'Post 12: a short caption', 'Weak hook', 'major')] },
    ];
    const r = stage1([C2], jobs, { copyDir: dir });
    const conv = r.decided.find((d) => d.job === 'jconv001');
    assert.equal(conv.outcome, 'caught');
    assert.equal(conv.stage, 'code');
    assert.ok(r.needMatcher.some((p) => p.job === 'jfacts01'), 'quote within 200 characters of the removal point');
    assert.equal(r.decided.find((d) => d.job === 'jlang001').outcome, 'missed', 'far away quote');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeMatcher: score >= 3 matches; alsoReal keeps the finding; null answer is fail-closed', () => {
  const dir = copyDir();
  try {
    const r = stage1([C1], JOBS, { copyDir: dir });
    const answer = {
      schemaVersion: 1,
      nonce: 'PL-AAAA-BBBB',
      pairs: [
        { canary: 'C1', finding: 'jconv001#2', score: 4, alsoReal: false, why: 'same line' },
        { canary: 'C1', finding: 'jgen0001#3', score: 3, alsoReal: true, why: 'same number, also a real issue' },
      ],
    };
    const det = mergeMatcher(r.decided, answer, r.needMatcher);
    assert.equal(det.length, 5, 'one row per canary x job');
    const conv = det.find((d) => d.job === 'jconv001');
    assert.deepEqual([conv.outcome, conv.stage, conv.matcherScore, conv.finding], ['caught', 'matcher', 4, 2]);
    const gen = det.find((d) => d.job === 'jgen0001');
    assert.equal(gen.outcome, 'caught');
    const m = findingsMatched(det, answer);
    assert.ok(m.remove.includes('jfacts01#1'));
    assert.ok(m.remove.includes('jconv001#2'));
    assert.ok(!m.remove.includes('jgen0001#3'), 'alsoReal stays in the real-issue pipeline');
    assert.deepEqual(m.alsoReal, ['jgen0001#3']);
    assert.deepEqual(pairCounts(det), { caught: 3, underclassified: 1, missed: 1, total: 5 });

    const low = mergeMatcher(r.decided, { pairs: [{ canary: 'C1', finding: 'jconv001#2', score: 2, alsoReal: false, why: 'x' }] }, r.needMatcher);
    const lowConv = low.find((d) => d.job === 'jconv001');
    assert.deepEqual([lowConv.outcome, lowConv.matcherScore], ['missed', 2]);
    const dead = mergeMatcher(r.decided, null, r.needMatcher);
    assert.ok(dead.filter((d) => ['jconv001', 'jgen0001'].includes(d.job)).every((d) => d.outcome === 'missed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('visual canaries: findings in the file or of kind visual go to the matcher', () => {
  const C5 = { canary: 'C5', slot: 'S5', purpose: 'attention', targetLens: 'design', type: 'VISUAL', file: 'render/out/B3.png', locator: 'footer', before: 'image', after: 'sha256:' + '0'.repeat(64), prePlanted: true };
  const jobs = {
    jdes0001: { lens: 'design', attempt: 1, findings: [{ n: 1, severity: 'major', kind: 'visual', location: { file: 'render/out/B3.png', locator: 'footer' }, quote: null, seen: 'no logo', problem: 'Logo missing', fix: 'add' }] },
    jrisk001: { lens: 'risk', attempt: 1, findings: [{ n: 4, severity: 'major', kind: 'fact', location: { file: 'content/page.md', locator: 'x' }, quote: 'abcdef', problem: 'p', fix: 'f' }] },
  };
  const r = stage1([C5], jobs, {});
  assert.deepEqual(r.needMatcher.map((p) => p.job), ['jdes0001']);
  assert.equal(r.decided.find((d) => d.job === 'jrisk001').outcome, 'missed');
});
