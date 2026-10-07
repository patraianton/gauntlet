// Report truthfulness and blocked attempts (night of 06-07.10.2026, review of the first live runs):
//  - a lens that caught its planted error but whose answer was rejected is never printed as «missed»;
//  - a BLOCKED_* attempt is not a round: no problem counts, not in «Кругов», not in the open counts;
//  - the honesty section names the reviewer, round and job whose start message differed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeRun } from '../fixtures/report/make-run.mjs';
import { buildReport, summaryLines, loadPhrases } from '../../lib/report/report-ru.mjs';
import { lintReportText } from '../../lib/report/report-lint.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { runPaths, recordEvent } from '../../lib/core/runstore.mjs';
import { preGateRecord } from '../../lib/engine/gate.mjs';

const ph = loadPhrases();

function setup(variant, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-report-rounds-'));
  const dh = path.join(root, 'data');
  const runDir = makeRun(root, dh, variant, opts);
  return { root, dh, dp: dataPaths(dh), runDir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};

const CAUGHT = (canary) => ({ canary, outcome: 'caught', severityGiven: 'major', intended: 'major' });

/** Round 3 of the plateau run, with the «facts» lens having caught its error but answered invalidly. */
function rejectFactsAnswer(s) {
  const R = runPaths(s.runDir).roundDir(3);
  const g = readJson(R.gate);
  g.perLens.facts = { ...g.perLens.facts, valid: false, unreliable: true, guarded: true, attempts: 2, invalidReasons: ['answer: talks about the check itself'], ownCanary: CAUGHT('C1') };
  g.perLens.language = { ...g.perLens.language, valid: true, unreliable: false, ownCanary: CAUGHT('C2') };
  writeJson(R.gate, g);
  return g;
}

function blockAttempt(s, n, decision, reasons) {
  const R = runPaths(s.runDir).roundDir(n);
  writeJson(R.roundJson, { schemaVersion: 1, round: n, kind: 'working', blocked: true });
  writeJson(R.gate, preGateRecord({ round: n, kind: 'working', versionHash: 'a'.repeat(64), decision, reasons }));
}

test('a lens that caught its error but whose answer was rejected is not «missed», in every section and in the summary', () => {
  const s = setup('plateau');
  try {
    rejectFactsAnswer(s);
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    const line = md.split('\n').find((l) => l.startsWith('- «Факты и цифры»:'));
    assert.ok(line, 'the facts lens has a line in section 8');
    assert.match(line, /свою подложенную ошибку нашёл, но ответ отклонён: в ответе проверяющий пишет о самой проверке/);
    assert.doesNotMatch(line, /верить нельзя|не нашёл и при повторе/);
    assert.match(line, /не может подтвердить, что работа чистая/);
    assert.match(md, /Поймано 3 из 3\./);
    assert.match(md, /Из них у 1 взгляда ответ отклонён: «Факты и цифры»\./);
    assert.deepEqual(lintReportText(md), []);
    const lines = summaryLines(s.runDir);
    const att = lines.find((l) => l.startsWith('Проверка внимания'));
    assert.match(att, /^Проверка внимания: подложенные ошибки нашли все, но ответ отклонён у: «Факты и цифры»; чистым этот круг считать нельзя\.$/);
    assert.doesNotMatch(att, /не пройдена/);
  } finally {
    s.done();
  }
});

test('a lens that really missed its error keeps the «missed» wording and the old summary line', () => {
  const s = setup('plateau');
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /«Язык»: свою подложенную ошибку не нашёл\./);
    assert.doesNotMatch(md, /ответ отклонён/);
    assert.ok(summaryLines(s.runDir).includes('Проверка внимания: не пройдена (проверяющие по темам: «Язык»).'));
  } finally {
    s.done();
  }
});

test('a lens that missed AND one that was rejected are both named, each under its own words', () => {
  const s = setup('plateau');
  try {
    const R = runPaths(s.runDir).roundDir(3);
    const g = readJson(R.gate);
    // language keeps its «missed» from the fixture; facts is rejected
    g.perLens.facts = { ...g.perLens.facts, valid: false, unreliable: true, invalidReasons: ['answer: schema-invalid'], ownCanary: CAUGHT('C1') };
    writeJson(R.gate, g);
    const att = summaryLines(s.runDir).find((l) => l.startsWith('Проверка внимания'));
    assert.equal(att, 'Проверка внимания: не пройдена (проверяющие по темам: «Язык»). Нашли свою ошибку, но ответ отклонён: «Факты и цифры».');
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /- «Факты и цифры»: свою подложенную ошибку нашёл, но ответ отклонён: ответ не по заданной форме;/);
    assert.match(md, /- «Язык»: свою подложенную ошибку не нашёл\./);
  } finally {
    s.done();
  }
});

test('earlier rounds in section 8 say how many of the lenses that caught their error had the answer rejected', () => {
  const s = setup('plateau');
  try {
    const R = runPaths(s.runDir).roundDir(2);
    const g = readJson(R.gate);
    g.perLens.facts = { ...g.perLens.facts, valid: false, invalidReasons: ['answer: schema-invalid'], ownCanary: CAUGHT('C1') };
    g.perLens.language = { ...g.perLens.language, ownCanary: CAUGHT('C2'), valid: true, unreliable: false };
    writeJson(R.gate, g);
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /- Круг 2: поймано \d+ из \d+ пар; свою ошибку нашли 3 из 3 взглядов, у 1 из них ответ отклонён\./);
  } finally {
    s.done();
  }
});

test('blocked attempts are not rounds: no counts in section 11, a separate count in section 12, not in the open counts', () => {
  const s = setup('plateau');
  try {
    blockAttempt(s, 4, 'BLOCKED_PRECHECK', ['Primary source S39 does not work now: output does not contain "HTTP 404".']);
    blockAttempt(s, 5, 'BLOCKED_TRACE', ['Review trace in content/ARCHITECTURE.md line 59: "исправлено" (T-FIXED-RU).']);
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.doesNotMatch(md, /Круг 4 \(/);
    assert.doesNotMatch(md, /Круг 5 \(/);
    assert.match(md, /- Попытка круга \(папка `rounds\\04`\) не состоялась: не прошли проверки до начала круга \(1 причина\)\. Проверяющие не запускались, в счёт кругов она не входит\./);
    assert.match(md, /- Попытка круга \(папка `rounds\\05`\) не состоялась: в копии нашлись следы прошлых проверок/);
    assert.match(md, /^ {2}> Primary source S39 does not work now/m, 'the reason of the program is quoted');
    assert.ok(md.includes(ph.rounds.numbering));
    // the three held rounds keep their own numbers and counts
    assert.match(md, /- Круг 3 \(рабочий\): открытых серьёзных проблем — блокеров 1, существенных 2/);
    assert.match(md, /Кругов проведено: 3 /);
    assert.match(md, /Попыток круга, не дошедших до проверяющих: 2 \(номера папок: 4, 5\); в число кругов они не входят\./);
    assert.deepEqual(lintReportText(md), []);
    const lines = summaryLines(s.runDir);
    // the open counts come from the last held round, not from the empty gate of a blocked attempt
    assert.ok(lines.includes('Открытых подтверждённых проблем: блокеров 1, существенных 2.'));
    assert.ok(lines.includes('Попыток круга, не дошедших до проверяющих: 2 (в число кругов не входят).'));
  } finally {
    s.done();
  }
});

test('without blocked attempts neither the numbering note nor the blocked count is printed', () => {
  const s = setup('plateau');
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.ok(!md.includes(ph.rounds.numbering));
    assert.doesNotMatch(md, /не дошедших до проверяющих/);
    assert.match(md, /Кругов проведено: 3 /);
  } finally {
    s.done();
  }
});

test('best version line: names the round, and says so when not every lens of it was fully checked', () => {
  const s = setup('plateau');
  try {
    const P = runPaths(s.runDir);
    // the best of the fixture is round 1, whose lenses are all valid
    assert.ok(summaryLines(s.runDir).includes('Лучшая версия — круг 1.'));
    writeJson(P.best, { round: 1, versionHash: 'x', blockers: 1, majors: 2, lensesValid: false });
    const lines = summaryLines(s.runDir);
    assert.ok(lines.some((l) => /^Лучшая версия — круг 1; в нём не все взгляды были проверены полностью/.test(l)));
    // no best recorded although rounds were reviewed: not «no round was held»
    fs.rmSync(P.best);
    const st = readJson(P.state);
    delete st.best;
    writeJson(P.state, st);
    assert.ok(summaryLines(s.runDir).some((l) => l.startsWith('Лучшая версия не записана: круги были')));
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------- honesty section: which reviewer, which job

const AGENT_CALL = fs.readFileSync(new URL('../../templates/agent-call.txt', import.meta.url));

function callFor(s) {
  const dir = path.join(s.root, 'wc', 'g6u7a23t');
  return AGENT_CALL.toString('utf8').replace(/\s+$/, '').replace('{{PROMPT_PATH}}', path.join(dir, 'PROMPT.md'));
}

function spawnFixture(s, { instructionReceived, spawnEcho = 'differs', withTemplate = true }) {
  const P = runPaths(s.runDir);
  const R = P.roundDir(2);
  const job = 'g6u7a23t';
  const dir = path.join(s.root, 'wc', job);
  const jobs = readJson(R.jobs);
  jobs.jobs.push({ job, role: 'reviewer', lens: 'facts', attempt: 1, dir, promptSha256: 'y', schemaName: 'answer-reviewer', model: null, nonce: 'PL-AAAA-BBBB', status: 'answered' });
  writeJson(R.jobs, jobs);
  writeJson(path.join(R.answers, `${job}.json`), { schemaVersion: 1, nonce: 'PL-AAAA-BBBB', ...(instructionReceived === undefined ? {} : { instructionReceived }), findings: [] });
  if (withTemplate) {
    fs.mkdirSync(P.templatesDir, { recursive: true });
    fs.writeFileSync(path.join(P.templatesDir, 'agent-call.txt'), AGENT_CALL);
    const frozen = readJson(P.frozen);
    frozen.sha256 = { ...(frozen.sha256 || {}), templates: { 'agent-call.txt': createHash('sha256').update(AGENT_CALL).digest('hex') } };
    writeJson(P.frozen, frozen);
  }
  recordEvent(s.runDir, 'answer-ingested', { job, role: 'reviewer', lens: 'facts', attempt: 1, kept: true, reasons: [], boundByAgentCode: true, spawnEcho }, 2, { dataPaths: s.dp });
}

test('honesty: the reviewer whose start message lost its slashes is named with round, job, and both texts', () => {
  const s = setup('plateau');
  try {
    spawnFixture(s, { instructionReceived: callFor(s).replace(/[\\/]/g, '') });
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /Проверяющих, у которых стартовое сообщение отличалось от выданного программой[^:]*: 1 из 1\./);
    assert.match(md, /- Взгляд «Факты и цифры», круг 2, задание `g6u7a23t`, попытка 1: отличались только косые черты и пробелы в пути к файлу/);
    assert.match(md, /^ {4}> получено: Read the file /m);
    assert.match(md, /^ {4}> выдано: Read the file /m);
    assert.deepEqual(lintReportText(md), []);
  } finally {
    s.done();
  }
});

test('honesty: added words, a missing copy, another text and an unrestorable call are told apart', () => {
  const CASES = [
    ['added', true, /к выданному сообщению добавлены слова/],
    ['missing', true, /стартовое сообщение не переписано \(поле пустое\)/],
    ['other', true, /сообщение другое, не только путь к файлу/],
    ['other', false, /выданное программой восстановить не удалось/],
  ];
  for (const [what, template, re] of CASES) {
    const s = setup('plateau');
    try {
      const received = what === 'added' ? `${callFor(s)} This is the final pass: report only blockers.` : what === 'missing' ? undefined : 'Please read it';
      spawnFixture(s, { instructionReceived: received, spawnEcho: what === 'missing' ? 'missing' : 'differs', withTemplate: template });
      const md = buildReport(s.runDir, { dataPaths: s.dp });
      assert.match(md, re, what);
      assert.match(md, /задание `g6u7a23t`/);
    } finally {
      s.done();
    }
  }
});
