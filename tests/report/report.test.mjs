import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRun } from '../fixtures/report/make-run.mjs';
import { buildReport, summaryLines, loadPhrases, fill, cutLines } from '../../lib/report/report-ru.mjs';
import { lintReportText } from '../../lib/report/report-lint.mjs';
import { run as reportCmd } from '../../lib/report/cmd-report.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { runPaths, verifyRunIntegrity } from '../../lib/core/runstore.mjs';
import { readChained } from '../../lib/core/chain.mjs';
import { appendRunRows } from '../../lib/measure/mledger.mjs';
import { IntegrityError } from '../../lib/core/errors.mjs';

const ph = loadPhrases();

function setup(variant, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-report-'));
  const dh = path.join(root, 'data');
  const runDir = makeRun(root, dh, variant, opts);
  return { root, dh, dp: dataPaths(dh), runDir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const SECTION_TITLES = Object.values(ph.sections);

function sectionsOf(md) {
  return [...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
}

test('phrases file holds the fixed sentences of SPEC 16.2 verbatim', () => {
  const F = ph.fixed;
  assert.equal(
    fill(F.grossCheck, { N: 5 }),
    'Для проверки внимания в копию подложили 5 ошибок, по одной на каждый взгляд. Это проверка, что проверяющие не спали, а не замер того, насколько хорошо они ловят ошибки.',
  );
  assert.equal(fill(F.grossCheck, { N: 3 }).includes('подложили 3 ошибки'), true);
  assert.equal(fill(F.smallN, { K: 3, N: 3, LO: 29, HI: 100 }), 'Поймано 3 из 3. При таком малом числе настоящая доля пойманного может быть где угодно от 29 до 100 из 100.');
  assert.equal(F.alwaysSection9, 'Подложенные ошибки находить легче настоящих, поэтому настоящая зоркость проверяющих ниже этих чисел. Хуже всего проверяющие замечают, что чего-то нужного в работе нет.');
  assert.equal(F.atDone, 'Перепроверенных серьёзных проблем в слепом круге не осталось. Это значит «проверяющие таких не нашли», а не «их нет».');
  assert.equal(fill(F.unanimousMiss, { TEXT: 'x' }), 'Подложенную ошибку «x» не нашёл ни один проверяющий.');
  assert.equal(fill(F.falseAlarms, { N: 4, M: 1 }), 'Из 4 серьёзных находок перепроверка сняла 1 как ошибочные.');
  assert.equal(fill(F.band, { A: '6,5', B: '7,5' }), 'Справочно, по таблице из найденного: худший взгляд — от 6,5 до 7,5. В решении о готовности эта цифра не участвует.');
  assert.equal(F.sameModel, 'Все проверяющие были одной модели (Sonnet); такие проверяющие часто ошибаются одинаково.');
  assert.equal(F.seeded, 'Внимание: запуск шёл в тестовом режиме с заданной случайностью.');
  assert.equal(ph.headline.done, 'Готово: два круга подряд, второй — слепой свежими проверяющими, не нашли перепроверенных серьёзных проблем.');
  assert.throws(() => fill('{NOPE}', {}), /NOPE/);
  // none of our own phrases trips the report lint
  const all = JSON.stringify(ph);
  assert.deepEqual(lintReportText(all.replace(/\\n/g, '\n')), []);
});

test('done run: every section in order, «Готово», band only from the confirm round, fixed phrases', () => {
  const s = setup('done');
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.deepEqual(sectionsOf(md).map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(sectionsOf(md).map((x) => x[1]), SECTION_TITLES.slice(0, 13));
    // the fixture's run has one waiver: «Готово» carries the owner's exceptions (r2-f9)
    assert.ok(md.includes(fill(ph.headline.doneWithExceptions, { N: 1, D: 1 })));
    assert.match(md, /Ваша цель была: «9,5» \(справочно, ваши слова\)/);
    assert.match(md, /После проверки файлы не менялись\./);
    assert.match(md, /^> строка 3: Крутить до 9,5 из 10 по оценке панели\.$/m, 'cut line printed verbatim as a quote');
    assert.match(md, /^\s*> это не гарантия, так и оставь, пост 7 ок$/m);
    assert.match(md, /Вы сняли проблему \(`C-01-03`\)/);
    assert.ok(md.includes(fill(ph.fixed.grossCheck, { N: 3 })));
    assert.ok(md.includes(fill(ph.fixed.smallN, { K: 3, N: 3, LO: 29, HI: 100 })));
    assert.ok(md.includes(ph.fixed.alwaysSection9));
    assert.ok(md.includes(ph.fixed.atDone));
    assert.ok(md.includes(ph.fixed.sameModel));
    assert.ok(md.includes(fill(ph.fixed.falseAlarms, { N: 3, M: 1 })));
    assert.ok(md.includes('Подложенную ошибку «убран призыв "Пишите LOAF" в посте 9» не нашёл ни один проверяющий.'));
    assert.ok(md.includes(fill(ph.fixed.band, { A: '9,0', B: '9,7' })));
    assert.match(md, /Данных пока мало \(0 из 25\)\./);
    assert.match(md, /Токены проверки: 4,8 млн\./);
    assert.match(md, /Проверка честности пройдена: все 8 пунктов сходятся\./);
    assert.doesNotMatch(md, /Внимание: запуск шёл в тестовом режиме/);
    assert.doesNotMatch(md, /средн/i, 'no average anywhere');
    assert.deepEqual(lintReportText(md), []);
  } finally {
    s.done();
  }
});

test('a suspect usage record is named in the cost section, and only then', () => {
  const clean = setup('done', {});
  const dirty = setup('done', { suspectUsage: true });
  try {
    const a = buildReport(clean.runDir, { dataPaths: clean.dp });
    assert.doesNotMatch(a, /выглядят завышенными/);
    const b = buildReport(dirty.runDir, { dataPaths: dirty.dp });
    assert.ok(b.includes(fill(ph.cost.suspect, { N: 1 })));
    assert.deepEqual(lintReportText(b), []);
  } finally {
    clean.done();
    dirty.done();
  }
});

test('stopped run: plateau headline, no band, doubtful items, what was not checked, poor panel, seeded warning', () => {
  const s = setup('plateau', { seeded: true });
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /Не готово: остановлено, потому что 2 круга подряд серьёзных проблем не становилось меньше/);
    assert.ok(md.includes(ph.band.none));
    assert.doesNotMatch(md, /худший взгляд — от/);
    assert.match(md, /Спорная: проверяющие перепроверки разошлись/);
    assert.match(md, /Не подтверждена и не опровергнута/);
    assert.match(md, /^> «Первый читатель», не проверено: видео в посте 11 — файл не открывается$/m);
    assert.match(md, /обязательный пункт не выполнен: M1: не успел открыть все слайды/);
    assert.match(md, /не удалось подтвердить \(это не находка\): цена доставки 600 €/);
    assert.match(md, /источник данных не сработал при подготовке круга: S1: timeout/);
    assert.match(md, /«Язык»: свою подложенную ошибку не нашёл\./);
    // r3-f22: one lens of several missed its own planted error; the pair share is only a diagnostic
    assert.ok(!md.includes(ph.canaries.panelBad));
    assert.match(md, /Справочно: поймано [0-9]+ из [0-9]+ пар/);
    assert.ok(md.includes(ph.fixed.seeded));
    assert.match(md, /Часть чисел оценена, а не измерена\./);
    assert.deepEqual(lintReportText(md), []);
    const lines = summaryLines(s.runDir);
    assert.equal(lines.length, 7, 'five lines + the owner\'s exceptions + the audit line');
    assert.ok(lines.includes(fill(ph.summary.exceptions, { N: 1, D: 1, K: 0 }) + ' ' + fill(ph.summary.firstQuote, { Q: 'это не гарантия, так и оставь, пост 7 ок' })));
    assert.ok(lines.includes(ph.summary.auditOk));
    assert.deepEqual(lines.slice(1, 4), [
      'Открытых подтверждённых проблем: блокеров 1, существенных 2.',
      'Лучшая версия — круг 1.',
      'Проверка внимания: не пройдена (проверяющие по темам: «Язык»).',
    ]);
    assert.match(lines[lines.length - 1], /^Отчёт: .*REPORT\.ru\.md$/);
  } finally {
    s.done();
  }
});

test('edited after review and a fresh run', () => {
  const e = setup('edited');
  try {
    const md = buildReport(e.runDir, { dataPaths: e.dp });
    assert.match(md, /Не готово: остановлено, потому что после проверки файлы менялись, и эти правки никто не проверял\./);
    assert.match(md, /^- `content\/plan\.json`$/m);
    assert.doesNotMatch(md, new RegExp(ph.headline.done));
    assert.doesNotMatch(md, /Перепроверенных серьёзных проблем в слепом круге не осталось/);
  } finally {
    e.done();
  }
  const n = setup('new');
  try {
    const md = buildReport(n.runDir, { dataPaths: n.dp });
    assert.match(md, /Не готово: проверка ещё идёт \(идёт настройка\)\./);
    assert.ok(md.includes(ph.version.none));
    assert.ok(md.includes(ph.band.none));
    assert.doesNotMatch(md, /одной модели/);
    const lines = summaryLines(n.runDir);
    assert.equal(lines[3], 'Проверка внимания: кругов с проверкой ещё не было.');
    assert.equal(lines[2], 'Лучшей версии нет: ещё не было ни одного круга, который дошёл бы до проверяющих.');
  } finally {
    n.done();
  }
});

test('«панель поставила» and bare scores are impossible in our own lines', () => {
  const evil = 'панель поставила 9,5 из 10';
  const s = setup('done', {
    ownerQuote: `${evil}, так что снимаю`,
    task: `Сделай контент-план на 12 постов для demo-project.\nКаждый пост ведёт на заявку.\nПроверь цены по сайту.\n`,
    lenses: [
      { id: 'facts', title: `Факты (${evil})`, canaryTypes: ['FACT-NUM'] },
      { id: 'language', title: 'Язык 8,5/10', canaryTypes: ['LANG'] },
      { id: 'generalist', title: 'Первый читатель', canaryTypes: ['BRIEF'] },
    ],
  });
  try {
    const P = runPaths(s.runDir);
    const cl = JSON.parse(fs.readFileSync(P.clusters, 'utf8'));
    cl.clusters[0].status = 'open';
    cl.clusters[0].severity = 'major';
    cl.clusters[0].problem = `Все проверяющие довольны, ${evil}`;
    cl.clusters[0].locator = 'оценка панели 7,5 из 10';
    fs.writeFileSync(P.clusters, JSON.stringify(cl));
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.deepEqual(lintReportText(md), [], 'nothing flagged outside quotations');
    for (const line of md.split('\n')) {
      if (/панел[ьи]\s+поставил/i.test(line) || /оценк[аи] панели/i.test(line) || /\d+[.,]\d\s*(из|\/)\s*10/.test(line)) {
        assert.ok(/^\s*>/.test(line) || /справочно/i.test(line), `only quoted or «справочно» lines may carry it: ${line}`);
      }
    }
    assert.ok(lintReportText(md, { includeQuotes: true }).length > 0, 'the quoted owner words are still shown verbatim');
    assert.match(md, /«Факты \(… …\)»/, 'a flagged lens title is masked in our own line');
    for (const l of summaryLines(s.runDir)) assert.deepEqual(lintReportText(l), []);
  } finally {
    s.done();
  }
});

test('cutLines: lines of OWNER-TASK.md that TASK.md dropped, Source line ignored', () => {
  assert.deepEqual(cutLines('a\nb\nc\nSource: owner\n', 'a\nc\n'), [{ n: 2, text: 'b' }]);
  assert.deepEqual(cutLines('a\r\nb\r\n', 'a\nb\n'), []);
  assert.deepEqual(cutLines(null, 'x'), []);
});

test('section 9 reads the cross-run ledger for this instrument', () => {
  const s = setup('done');
  try {
    // 26 attention canaries for instrument inst-report, 20 caught by their own lens
    const lenses = [{ id: 'facts', title: 'Факты' }];
    for (let r = 1; r <= 26; r++) {
      appendRunRows(s.dp, {
        run: { runId: `hist-${r}`, artifactType: 'marketing-plan', models: { optIn: [] } },
        round: 1,
        roundKind: 'working',
        instrumentId: 'inst-report',
        lenses,
        key: { canaries: [{ canary: 'C1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', band: 'start' }] },
        detections: [{ canary: 'C1', purpose: 'attention', targetLens: 'facts', lens: 'facts', job: 'j1', attempt: 1, outcome: r <= 20 ? 'caught' : 'missed' }],
        verdicts: [],
      });
    }
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /свою подложенную ошибку взгляд находил в 20 из 26 случаев: где-то от 56 до 91 из 100\./);
    assert.match(md, /Пропуск обязательного|пропуск обязательного/);
  } finally {
    s.done();
  }
});

test('cmd-report: writes the report and the owner copy, logs the event, --summary writes nothing, --comment adds section 14', async () => {
  const s = setup('done');
  try {
    const ctx = { dataHome: s.dh, json: false, env: {} };
    const P = runPaths(s.runDir);
    const sum = await reportCmd([s.runDir, '--summary'], ctx);
    assert.equal(sum.exitCode, 0);
    assert.ok(sum.payload.summaryRu.length >= 6, 'five lines + the audit line at least');
    assert.equal(fs.existsSync(P.report), false, '--summary writes nothing');
    const commentFile = path.join(s.root, 'comment.md');
    fs.writeFileSync(commentFile, 'Пост 7 я переписал по вашему слову.\n');
    const r = await reportCmd(['report', s.runDir, '--comment', commentFile], ctx);
    assert.equal(r.exitCode, 0);
    const md = fs.readFileSync(P.report, 'utf8');
    assert.match(md, /## 14\. Комментарий исполнителя\n\nЭто слова исполнителя\. Программа их не проверяла\.\n\n> Пост 7 я переписал по вашему слову\./);
    // a comment with a panel score is refused, quotes included
    const bad = path.join(s.root, 'bad-comment.md');
    fs.writeFileSync(bad, '> Панель поставила 9,5 из 10, все проверяющие довольны.\n');
    await assert.rejects(reportCmd(['report', s.runDir, '--comment', bad], ctx), /never shows/);
    const copy = path.join(s.root, 'reports', 'gauntlet-20261006-0930-aaaaaa.ru.md');
    assert.equal(fs.readFileSync(copy, 'utf8'), md);
    assert.equal(md.charCodeAt(0) === 0xfeff, false);
    assert.equal(md.includes('\r'), false);
    const events = readChained(P.ledger).filter((e) => e.type === 'report');
    assert.equal(events.length, 1);
    assert.equal(events[0].data.path, P.report);
    verifyRunIntegrity(s.runDir, { dataPaths: s.dp });
    await assert.rejects(reportCmd([s.runDir, '--nope'], ctx), /unknown option/);
    await assert.rejects(reportCmd([], ctx), /usage/);
    // a tampered ledger stops the command (exit 3)
    const lines = fs.readFileSync(P.ledger, 'utf8').split('\n');
    lines[1] = lines[1].replace('"task-set"', '"amend"');
    fs.writeFileSync(P.ledger, lines.join('\n'));
    await assert.rejects(reportCmd([s.runDir], ctx), (e) => e instanceof IntegrityError && e.code === 'TAMPER');
  } finally {
    s.done();
  }
});

const REUSED = 'Я включил тебе ультракод режима, давай просто быстро всё делай, не жалей токенов.';

test('owner decisions: every one is printed with its question; one quote behind different kinds is flagged', () => {
  const s = setup('done', {
    decisions: [
      { id: 'O1', ts: '2026-10-07T09:52:58.441+03:00', kind: 'raise-limit', set: { 'limits.maxRounds': '12' }, quote: REUSED, question: 'Поднять число кругов до двенадцати?', afterRound: 5 },
      { id: 'O2', ts: '2026-10-07T09:54:48.241+03:00', kind: 'amend', set: { what: 'sources' }, quote: REUSED, question: 'Можно поменять описание первоисточника?', narrowing: ['source S29 changed'] },
    ],
  });
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /Одна и та же цитата использована для разных решений: O1 \(Вы подняли лимит\), O2 \(Вы разрешили изменить настройки проверки: первоисточники\)/);
    assert.match(md, /На вопрос: Поднять число кругов до двенадцати\?/);
    assert.match(md, /На вопрос: Можно поменять описание первоисточника\?/);
    assert.deepEqual(lintReportText(md), []);
    const lines = summaryLines(s.runDir);
    assert.ok(lines.some((l) => /Одна и та же цитата для разных решений: 1/.test(l)), lines.join('\n'));
    for (const l of lines) assert.deepEqual(lintReportText(l), []);
  } finally {
    s.done();
  }
});

test('owner decisions: one quote used again for the same kind is not flagged; a decision without a question says so', () => {
  const s = setup('done', {
    decisions: [
      { id: 'O1', ts: '2026-10-07T09:00:00.000+03:00', kind: 'waive', clusters: ['C-01-03'], quote: 'это не гарантия, так и оставь, пост 7 ок', question: 'Снять находку про гарантию?' },
      { id: 'O2', ts: '2026-10-07T09:01:00.000+03:00', kind: 'waive', clusters: ['C-01-04'], quote: 'Это не гарантия, так и оставь, пост 7 ок.', question: null },
    ],
  });
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.doesNotMatch(md, /Одна и та же цитата/);
    assert.ok(md.includes(ph.decisions.noQuestion), 'a decision recorded without a question is marked');
    assert.equal(md.split(ph.decisions.noQuestion).length - 1, 1);
  } finally {
    s.done();
  }
});

test('ownerQuoteFlags: words recorded before the problem was found are flagged (ledger cluster event, round opening, run.json date)', async () => {
  const { ownerQuoteFlags } = await import('../../lib/report/report-ru.mjs');
  const f = {
    run: { limitsOptIn: { approvedBy: 'owner', quote: REUSED, date: '2026-10-05' } },
    ledger: [
      { type: 'round-open', round: 1, ts: '2026-10-06T22:21:00+03:00' },
      { type: 'round-open', round: 4, ts: '2026-10-07T03:00:00+03:00' },
      { type: 'cluster', ts: '2026-10-07T03:40:00+03:00', data: { newClusters: ['C-04-01'] } },
    ],
    decisions: [
      { id: 'O1', ts: '2026-10-07T05:00:00+03:00', kind: 'waive', clusters: ['C-04-01', 'C-01-02', 'C-04-09'], quote: REUSED, question: 'Снять находку?' },
    ],
  };
  const fl = ownerQuoteFlags(f);
  // C-04-01: from the cluster event; C-04-09: no cluster event, so the round opening (03:00); both after the 5th of October.
  // C-01-02: found 06.10 22:21, also after the bench run. All three predate nothing but the dated run.json quote.
  assert.deepEqual(fl.predates.map((p) => p.cluster).sort(), ['C-01-02', 'C-04-01', 'C-04-09']);
  assert.equal(fl.predates.find((p) => p.cluster === 'C-04-01').problemSince, '2026-10-07T03:40:00+03:00');
  assert.equal(fl.predates.find((p) => p.cluster === 'C-04-09').problemSince, '2026-10-07T03:00:00+03:00');
  assert.equal(fl.reuse.length, 0);
  const none = ownerQuoteFlags({ ...f, run: {} });
  assert.deepEqual(none.predates, []);
});

test('owner decisions: words recorded before the problem appeared are flagged in the report', async () => {
  const { recordEvent } = await import('../../lib/core/runstore.mjs');
  const s = setup('done', {
    decisions: [
      { id: 'O1', ts: '2020-01-01T09:00:00.000+03:00', kind: 'continue', quote: 'продолжай, всё остальное делай сам', question: 'Продолжать после остановки?' },
      { id: 'O2', ts: '2020-01-01T10:00:00.000+03:00', kind: 'waive', clusters: ['C-01-03'], quote: 'продолжай, всё остальное делай сам', question: 'Снять находку про гарантию?' },
    ],
  });
  try {
    // the cluster is created now (the ledger clock), long after the two decisions above
    recordEvent(s.runDir, 'cluster', { newClusters: ['C-01-03'] }, 1, { dataPaths: s.dp });
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /Ваши слова записаны раньше, чем появилась проблема `C-01-03`, к которой их приложили к решению O2/);
    assert.match(md, /Одна и та же цитата использована для разных решений: O1 \(Вы разрешили продолжать\), O2 \(Вы сняли проблему\)/);
    assert.deepEqual(lintReportText(md), []);
    assert.ok(summaryLines(s.runDir).some((l) => /слова записаны раньше, чем появилась проблема: 1/.test(l)));
  } finally {
    s.done();
  }
});

test('escapes recorded for the run (ledger add-escape) are printed under the owner\'s words and checked for quote reuse', async () => {
  const { appendEscape } = await import('../../lib/measure/mledger.mjs');
  const s = setup('done', {
    decisions: [{ id: 'O1', ts: '2026-10-07T09:00:00.000+03:00', kind: 'continue', quote: REUSED, question: 'Продолжать после остановки?' }],
  });
  try {
    const runId = JSON.parse(fs.readFileSync(path.join(s.runDir, 'run.json'), 'utf8')).runId;
    // an escape of another run never shows here
    appendEscape(s.dp, { runId: 'other-run', description: 'A wrong price on the site', severity: 'major', lens: 'none', ownerQuote: 'не про этот запуск', question: 'Записать это как пропущенную ошибку?' });
    assert.doesNotMatch(buildReport(s.runDir, { dataPaths: s.dp }), /не про этот запуск/);
    appendEscape(s.dp, { runId, description: 'A wrong price on the site', severity: 'major', lens: 'none', ownerQuote: REUSED, question: 'Записать неверную цену на сайте как пропущенную ошибку?' });
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.ok(md.includes(ph.decisions.escape), 'the escape is listed as a decision of the owner');
    assert.ok(md.includes('Записать неверную цену на сайте как пропущенную ошибку?'), 'with its question');
    assert.ok(md.includes(`Одна и та же цитата использована для разных решений: O1 (${ph.decisions.continue}), escape-1 (${ph.decisions.escape})`));
    assert.deepEqual(lintReportText(md), []);
    assert.ok(summaryLines(s.runDir, { dataPaths: s.dp }).some((l) => /Одна и та же цитата для разных решений: 1/.test(l)));
    // without the data home the report does not know about escapes
    assert.doesNotMatch(buildReport(s.runDir, {}), /Одна и та же цитата использована/);
  } finally {
    s.done();
  }
});
