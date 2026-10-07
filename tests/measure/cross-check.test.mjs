// Bug 11 (a night run): a planted error that the matcher did not recognise became a real
// blocker. Two holes, both closed here:
//  - `alsoReal` written on ANY pair of a finding kept it among the real problems, even a finding that code
//    had already settled as the catch of another pair (findingsMatched);
//  - a finding that quotes the planted text itself but that the matcher scored low stayed real (crossCheck).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crossCheck, findingsMatched, quoteSitsOnPlantedText, stage1, mergeMatcher, CROSS_MIN_QUOTE } from '../../lib/measure/match.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';

const PLANTED = 'Вызовы Crumbpay в документации подписаны: проверяем подпись и перепроверяем сообщение запросом к их API.';
const ORIGINAL = 'Подписи у вызовов Crumbpay в документации нет: проверяем секрет в адресе приёмника и перепроверяем сообщение запросом к их API.';

/** A planted copy shaped like the live case: the false sentence stands in a list, with true neighbours. */
function copyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-cross-'));
  fs.mkdirSync(path.join(dir, 'content'));
  const lines = [
    '## 6. Повторы и двойные сообщения',
    '- Каждое входящее сообщение запоминаем по его номеру у Crumbpay раньше всего остального.',
    '- Crumbpay ждёт ответа не дольше 5 секунд и при сбое присылает то же событие ещё до двух раз.',
    `- ${PLANTED}`,
    '- Каждое исходящее — строка очереди с меткой «не отправлять дважды».',
    '',
    'Код сохранения берём из 32-символьного набора (48 бит случайности), тот же набор у кода входа.',
    'Gross total is 10 290 € only.',
    'Net total is 10 290 € only.',
  ];
  fs.writeFileSync(path.join(dir, 'content', 'ARCHITECTURE.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'content', 'MIRROR.md'), `Зеркало: ${PLANTED}\n`);
  return dir;
}

const C1 = {
  canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-CLAIM', file: 'content/ARCHITECTURE.md', locator: 'раздел 6',
  before: ORIGINAL, after: PLANTED, description: 'сказано, что вызовы подписаны', severityFloor: 'major', prePlanted: false,
};

const f = (n, quote, severity = 'major', extra = {}) => ({
  n, severity, kind: 'fact', location: { file: 'content/ARCHITECTURE.md', locator: 'раздел 6' }, quote, problem: 'Защита построена на подписи, которой нет.', fix: 'Проверить.', ...extra,
});
const missedRow = (job, lens = 'generalist') => ({ canary: 'C1', purpose: 'attention', targetLens: 'facts', lens, job, attempt: 1, outcome: 'missed', finding: null, stage: null, matcherScore: null, severityGiven: null });

test('C1 shape: a finding that quotes the false sentence is a canary hit although the matcher scored it 1', () => {
  const dir = copyDir();
  try {
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(5, PLANTED)] } };
    const answer = { pairs: [{ canary: 'C1', finding: 'jgen00001#5', score: 1, alsoReal: false, why: 'другое место' }] };
    const r = crossCheck([C1], jobs, [missedRow('jgen00001')], answer, { copyDir: dir });
    assert.deepEqual(r.remove, ['jgen00001#5'], 'it leaves the real-issue pipeline');
    assert.equal(r.hits.length, 1);
    assert.deepEqual([r.hits[0].canary, r.hits[0].id, r.hits[0].matcher, r.hits[0].matcherScore, r.hits[0].rowBefore, r.hits[0].rowAfter], ['C1', 'jgen00001#5', 'low', 1, 'missed', 'caught']);
    const row = r.detections.find((d) => d.job === 'jgen00001');
    assert.deepEqual([row.outcome, row.stage, row.finding, row.severityGiven, row.crossCheck], ['caught', 'code', 5, 'major', true], 'recall counts the catch');
    assert.deepEqual(r.keptReal, []);
    const ok = validate(loadSchema('detections'), { schemaVersion: 1, round: 1, detections: r.detections });
    assert.ok(ok.ok, JSON.stringify(ok.errors));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same hit when the matcher never saw the pair, and when the matcher died (null answer)', () => {
  const dir = copyDir();
  try {
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(5, PLANTED)] } };
    for (const answer of [{ pairs: [] }, null]) {
      const r = crossCheck([C1], jobs, [missedRow('jgen00001')], answer, { copyDir: dir });
      assert.deepEqual(r.remove, ['jgen00001#5']);
      assert.equal(r.hits[0].matcher, 'not-shown');
      assert.equal(r.detections[0].outcome, 'caught');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('severity decides the outcome of a code hit: below the floor it is seen_underclassified, never missed', () => {
  const dir = copyDir();
  try {
    const jobs = { jlang00001: { lens: 'language', attempt: 1, findings: [f(19, PLANTED, 'cosmetic')] } };
    const r = crossCheck([C1], jobs, [missedRow('jlang00001', 'language')], { pairs: [] }, { copyDir: dir });
    assert.deepEqual([r.detections[0].outcome, r.detections[0].severityGiven], ['seen_underclassified', 'cosmetic']);
    assert.deepEqual(r.remove, ['jlang00001#19'], 'removed from the real problems all the same');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalised comparison: case, spaces, line breaks and quote marks do not hide the hit', () => {
  const dir = copyDir();
  try {
    const messy = '  вызовы   CRUMBPAY в документации\n подписаны:  проверяем подпись и перепроверяем сообщение запросом к их API.  ';
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(1, messy)] } };
    const r = crossCheck([C1], jobs, [missedRow('jgen00001')], { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove, ['jgen00001#1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('most of the false sentence is enough, quote2 counts too; a short core of it is left to the matcher', () => {
  const dir = copyDir();
  try {
    const jobs = {
      jgen00001: { lens: 'generalist', attempt: 1, findings: [f(1, 'документации подписаны: проверяем подпись и перепроверяем')] },
      jfac00001: { lens: 'facts', attempt: 1, findings: [f(2, 'Каждое исходящее — строка очереди', 'major', { quote2: 'Вызовы Crumbpay в документации подписаны: проверяем подпись и' })] },
      jcore0001: { lens: 'paths', attempt: 1, findings: [f(3, 'подписаны: проверяем подпись и перепроверяем сообщение')] },
    };
    const rows = [missedRow('jgen00001'), missedRow('jfac00001', 'facts'), missedRow('jcore0001', 'paths')];
    const r = crossCheck([C1], jobs, rows, { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove.sort(), ['jfac00001#2', 'jgen00001#1'], 'a quote of less than 60 % of the changed words is not enough for code alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a different real finding next to the canary survives: neighbouring lines, the unchanged start of the same line, or a whole section', () => {
  const dir = copyDir();
  try {
    const jobs = {
      jneigh001: {
        lens: 'generalist',
        attempt: 1,
        findings: [
          f(1, 'Каждое входящее сообщение запоминаем по его номеру у Crumbpay раньше всего остального.'), // line above
          f(2, 'Каждое исходящее — строка очереди с меткой «не отправлять дважды».'), // line below
          f(3, 'Crumbpay ждёт ответа не дольше 5 секунд и при сбое присылает то же событие ещё до двух раз.'), // the true neighbour
          f(4, 'Вызовы Crumbpay в документации'), // the unchanged beginning of the planted line: no changed word
          f(5, '## 6. Повторы и двойные сообщения\n- Каждое входящее сообщение запоминаем по его номеру у Crumbpay раньше всего остального.\n- Crumbpay ждёт ответа не дольше 5 секунд и при сбое присылает то же событие ещё до двух раз.\n- Вызовы Crumbpay в документации подписаны: проверяем подпись и перепроверяем сообщение запросом к их API.\n- Каждое исходящее — строка очереди с меткой «не отправлять дважды».'), // the whole section: too wide
          f(6, 'подписаны'), // too short to point at a place
          { ...f(7, PLANTED), location: { file: 'content/MIRROR.md', locator: 'x' } }, // another file: the matcher's business
        ],
      },
    };
    const rows = [missedRow('jneigh001')];
    const r = crossCheck([C1], jobs, rows, { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove, [], 'nothing of this is swallowed');
    assert.deepEqual(r.hits, []);
    assert.equal(r.detections[0].outcome, 'missed', 'recall is not inflated either');
    assert.ok(!r.detections[0].crossCheck);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rule is the same in a mixed job: only the finding on the planted text goes, the real one beside it stays', () => {
  const dir = copyDir();
  try {
    const jobs = { jmix000001: { lens: 'generalist', attempt: 1, findings: [f(1, 'Каждое исходящее — строка очереди с меткой «не отправлять дважды».', 'blocker'), f(2, PLANTED, 'major'), f(3, PLANTED, 'blocker')] } };
    const r = crossCheck([C1], jobs, [missedRow('jmix000001')], { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove.sort(), ['jmix000001#2', 'jmix000001#3'], 'every hit leaves, not only the best one');
    assert.equal(r.detections[0].finding, 3, 'the row names the most serious hit');
    assert.equal(r.detections[0].severityGiven, 'blocker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a quote that stands twice in the file does not point at a place; a changed span nobody quoted is not a hit', () => {
  const dir = copyDir();
  try {
    const C9 = { canary: 'C9', slot: 'S9', purpose: 'measurement', targetLens: 'facts', type: 'FACT-NUM', file: 'content/ARCHITECTURE.md', locator: 'итог', before: 'Net total is 10 190 € only.', after: 'Net total is 10 290 € only.', description: 'wrong total', prePlanted: false };
    const jobs = {
      jtwice001: { lens: 'facts', attempt: 1, findings: [f(1, 'total is 10 290 € only.')] }, // also inside "Gross total ..."
      jonce0001: { lens: 'generalist', attempt: 1, findings: [f(2, 'Net total is 10 290 € only.')] },
    };
    const rows = ['jtwice001', 'jonce0001'].map((j) => ({ ...missedRow(j), canary: 'C9', purpose: 'measurement' }));
    const r = crossCheck([C9], jobs, rows, { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove, ['jonce0001#2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the matcher judged this very pair: score >= 3 is its catch, score < 3 with alsoReal keeps the finding real and records the disagreement', () => {
  const dir = copyDir();
  try {
    const jobs = {
      jagree0001: { lens: 'facts', attempt: 1, findings: [f(1, PLANTED)] },
      jsplit0001: { lens: 'generalist', attempt: 1, findings: [f(2, PLANTED, 'major', { problem: 'Предложение слишком длинное и тяжело читается.' })] },
    };
    const answer = {
      pairs: [
        { canary: 'C1', finding: 'jagree0001#1', score: 4, alsoReal: false, why: 'та же ошибка' },
        { canary: 'C1', finding: 'jsplit0001#2', score: 2, alsoReal: true, why: 'та же строка, другая жалоба; она настоящая' },
      ],
    };
    const r = crossCheck([C1], jobs, [missedRow('jagree0001', 'facts'), missedRow('jsplit0001')], answer, { copyDir: dir });
    assert.deepEqual(r.hits, [], 'no override where the matcher already spoke for the pair');
    assert.deepEqual(r.remove, []);
    assert.deepEqual(r.keptReal.map((k) => [k.id, k.matcherScore]), [['jsplit0001#2', 2]], 'the disagreement is recorded');
    assert.ok(r.detections.every((d) => d.outcome === 'missed'), 'recall is not inflated where the matcher kept it real');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omission, visual and pre-planted canaries are left to the matcher', () => {
  const dir = copyDir();
  try {
    const omission = { ...C1, canary: 'C2', type: 'OMIT-REQ', before: `${PLANTED} Это обязательное предложение.`, after: PLANTED };
    const visual = { ...C1, canary: 'C3', type: 'VISUAL', after: 'sha256:' + '0'.repeat(64) };
    const pre = { ...C1, canary: 'C4', prePlanted: true };
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(1, PLANTED)] } };
    const rows = ['C2', 'C3', 'C4'].map((c) => ({ ...missedRow('jgen00001'), canary: c }));
    const r = crossCheck([omission, visual, pre], jobs, rows, { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.remove, []);
    assert.deepEqual(r.detections.map((d) => d.outcome), ['missed', 'missed', 'missed']);
    assert.deepEqual(crossCheck([C1], jobs, [missedRow('jgen00001')], { pairs: [] }, {}).remove, [], 'without the copy there is nothing to compare');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing catch is not touched and not reported as a disagreement', () => {
  const dir = copyDir();
  try {
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(5, PLANTED)] } };
    const caught = { ...missedRow('jgen00001'), outcome: 'caught', finding: 5, stage: 'code', severityGiven: 'major' };
    const r = crossCheck([C1], jobs, [caught], { pairs: [] }, { copyDir: dir });
    assert.deepEqual(r.hits, []);
    assert.deepEqual(r.detections, [caught]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quote length limits: at least CROSS_MIN_QUOTE characters, at most twice the planted passage plus 40', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-cross-len-'));
  try {
    fs.mkdirSync(path.join(dir, 'content'));
    const filler = (i) => `Строка номер ${i} просто стоит рядом и ничего не утверждает про цифры.`;
    const planted = 'alpha beta 10 290 gamma';
    fs.writeFileSync(path.join(dir, 'content', 'page.md'), [filler(1), filler(2), planted, filler(3), filler(4)].join('\n') + '\n');
    const C = { canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', file: 'content/page.md', locator: 'x', before: 'alpha beta 10 190 gamma', after: planted, description: 'x', prePlanted: false };
    const check = (quote) => crossCheck([C], { j: { lens: 'facts', attempt: 1, findings: [{ ...f(1, quote), location: { file: 'content/page.md', locator: 'x' } }] } }, [{ ...missedRow('j', 'facts') }], { pairs: [] }, { copyDir: dir }).remove;
    assert.equal(CROSS_MIN_QUOTE, 12);
    assert.deepEqual(check('eta 10 290 g'), ['j#1'], 'exactly 12 characters counts');
    assert.deepEqual(check('ta 10 290 g'), [], 'one character less does not');
    assert.deepEqual(check('10 290'), [], 'a bare number never points at a place');
    const wide = [filler(2), planted, filler(3)].join(' ');
    assert.ok(wide.length > 2 * planted.length + 40);
    assert.deepEqual(check(wide), [], 'a quote wider than the passage is a section, not a place');
    assert.deepEqual(check(`${filler(2)} alpha beta 10 290`.slice(-60)), ['j#1'], 'a tail of the previous line plus the changed words is still narrow enough');
    assert.equal(quoteSitsOnPlantedText(null, 'eta 10 290 g'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ findingsMatched: whose `alsoReal` counts

const det = (canary, job, finding, stage, outcome = 'caught') => ({ canary, purpose: 'attention', targetLens: 'facts', lens: 'generalist', job, attempt: 1, outcome, finding, stage, matcherScore: null, severityGiven: 'major' });

test('bug 11 root cause: alsoReal on a pair of ANOTHER canary does not keep a code catch among the real problems', () => {
  // generalist d2by8vr8: finding 5 was settled by code as the catch of C1; the matcher was asked about it only for C6
  const detections = [det('C1', 'jgen00001', 5, 'code'), det('C2', 'jgen00001', 1, 'code')];
  const answer = {
    pairs: [
      { canary: 'C6', finding: 'jgen00001#5', score: 2, alsoReal: true, why: 'вставка про секрет приёмника; другое' },
      { canary: 'C6', finding: 'jgen00001#1', score: 1, alsoReal: true, why: 'про биты в коде; другое' },
    ],
  };
  const shown = [{ canary: 'C6', findings: [{ finding: 'jgen00001#5' }, { finding: 'jgen00001#1' }] }];
  const m = findingsMatched(detections, answer, shown);
  assert.deepEqual(m.remove.sort(), ['jgen00001#1', 'jgen00001#5'], 'both catches leave the real problems');
  assert.deepEqual(m.alsoReal, []);
  assert.deepEqual(m.ignoredAlsoReal.map((x) => [x.canary, x.finding, x.score]), [['C6', 'jgen00001#5', 2], ['C6', 'jgen00001#1', 1]], 'the ignored marks are reported, not lost');
});

test('alsoReal counts only on the very pair: same canary, same finding, score >= 3', () => {
  const detections = [det('C1', 'jgen00001', 5, 'matcher')];
  const same = findingsMatched(detections, { pairs: [{ canary: 'C1', finding: 'jgen00001#5', score: 4, alsoReal: true, why: 'x' }] }, [{ canary: 'C1', findings: [{ finding: 'jgen00001#5' }] }]);
  assert.deepEqual([same.remove, same.alsoReal], [[], ['jgen00001#5']]);
  // a mark on a pair that scored below 3 means "not the planted error", it never rescues a catch of another pair
  const low = findingsMatched(detections, { pairs: [{ canary: 'C1', finding: 'jgen00001#5', score: 2, alsoReal: true, why: 'x' }] }, [{ canary: 'C1', findings: [{ finding: 'jgen00001#5' }] }]);
  assert.deepEqual(low.remove, ['jgen00001#5']);
  // caught by two canaries, kept real for only one of them: still a canary catch
  const two = findingsMatched([det('C1', 'jgen00001', 5, 'code'), det('C2', 'jgen00001', 5, 'matcher')], { pairs: [{ canary: 'C2', finding: 'jgen00001#5', score: 5, alsoReal: true, why: 'x' }] }, [{ canary: 'C2', findings: [{ finding: 'jgen00001#5' }] }]);
  assert.deepEqual(two.remove, ['jgen00001#5']);
});

test('every finding the matcher matched leaves, not only the best one of the cell; pairs for findings it was not shown are ignored', () => {
  const detections = [det('C1', 'jfac00001', 1, 'matcher')];
  const answer = {
    pairs: [
      { canary: 'C1', finding: 'jfac00001#1', score: 5, alsoReal: false, why: 'x' },
      { canary: 'C1', finding: 'jfac00001#7', score: 4, alsoReal: false, why: 'тот же пропуск, второй раз' },
      { canary: 'C1', finding: 'jother0001#9', score: 5, alsoReal: false, why: 'не показывали' },
    ],
  };
  const shown = [{ canary: 'C1', findings: [{ finding: 'jfac00001#1' }, { finding: 'jfac00001#7' }] }];
  const m = findingsMatched(detections, answer, shown);
  assert.deepEqual(m.remove.sort(), ['jfac00001#1', 'jfac00001#7']);
});

test('end to end of stage 1 + matcher + cross-check: a leak the old rule let through is caught', () => {
  const dir = copyDir();
  try {
    // The reviewer's own words carry no distinctive changed token, so code does not decide; the matcher scores 1.
    const jobs = { jgen00001: { lens: 'generalist', attempt: 1, findings: [f(5, PLANTED, 'major', { problem: 'Эта строка вызывает вопросы у читателя.' })] } };
    const s1 = stage1([C1], jobs, { copyDir: dir });
    assert.equal(s1.needMatcher.length, 1, 'the pair goes to the matcher');
    const answer = { pairs: [{ canary: 'C1', finding: 'jgen00001#5', score: 1, alsoReal: false, why: 'другое' }] };
    const merged = mergeMatcher(s1.decided, answer, s1.needMatcher);
    assert.equal(merged[0].outcome, 'missed');
    assert.deepEqual(findingsMatched(merged, answer, s1.needMatcher).remove, [], 'the old pipeline would have kept it as a real problem');
    const c = crossCheck([C1], jobs, merged, answer, { copyDir: dir });
    assert.deepEqual(c.remove, ['jgen00001#5']);
    assert.equal(c.detections[0].outcome, 'caught');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
