// Bug 14: the owner reads REAL round numbers (only rounds that reached the reviewers), with the run
// folder in brackets where it differs: «круг 3 (папка 04)». An attempt that never reached the
// reviewers is listed as an attempt. Evidence runs: one run (3 real rounds in folders 02-04, an
// attempt in 01: «Лучшая версия — круг 4» in a run limited to 3 rounds) and another (the real
// round 7 in folder 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRun } from '../fixtures/report/make-run.mjs';
import { buildReport, summaryLines, loadPhrases } from '../../lib/report/report-ru.mjs';
import { lintReportText } from '../../lib/report/report-lint.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { runPaths } from '../../lib/core/runstore.mjs';
import { preGateRecord } from '../../lib/engine/gate.mjs';

const ph = loadPhrases();
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};

/**
 * The 'plateau' fixture holds real rounds in folders 01-03. Move them to the given folders and put a
 * blocked attempt into each of `attempts`.
 */
function runWithFolders(folders, attempts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-report-roundnum-'));
  const dh = path.join(root, 'data');
  const runDir = makeRun(root, dh, 'plateau');
  const P = runPaths(runDir);
  for (let i = folders.length - 1; i >= 0; i--) {
    const from = i + 1;
    const to = folders[i];
    if (from === to) continue;
    fs.renameSync(P.roundDir(from).dir, P.roundDir(to).dir);
    for (const f of ['gate', 'roundJson']) {
      const file = P.roundDir(to)[f];
      if (fs.existsSync(file)) {
        const j = readJson(file);
        j.round = to;
        writeJson(file, j);
      }
    }
  }
  for (const n of attempts) {
    const R = P.roundDir(n);
    writeJson(R.roundJson, { schemaVersion: 1, round: n, kind: 'working', blocked: true });
    writeJson(R.gate, preGateRecord({ round: n, kind: 'working', versionHash: 'a'.repeat(64), decision: 'BLOCKED_PRECHECK', reasons: ['Primary source S1 does not work now.'] }));
  }
  return { root, dp: dataPaths(dh), runDir, P, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('an attempt in folder 01 and real rounds in folders 02-04: the owner reads rounds 1-3, never round 4', () => {
  const s = runWithFolders([2, 3, 4], [1]);
  try {
    writeJson(s.P.best, { round: 4, versionHash: 'x', blockers: 1, majors: 2, lensesValid: true });
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    // section 8: the last round with planted errors and the earlier rounds
    assert.match(md, /Последний круг с подложенными ошибками — круг 3 \(папка 04\)\./);
    assert.match(md, /- Круг 1 \(папка 02\): поймано \d+ из \d+ пар;/);
    assert.match(md, /- Круг 2 \(папка 03\): поймано \d+ из \d+ пар;/);
    // section 11: real number first, the folder in the same brackets as the kind
    assert.match(md, /- Круг 1 \(рабочий, папка 02\): открытых серьёзных проблем — блокеров 1, существенных 2; решение: исправлять\./);
    assert.match(md, /- Круг 2 \(рабочий, папка 03\): /);
    assert.match(md, /- Круг 3 \(рабочий, папка 04\): .*остановка: улучшения нет\./);
    // the attempt is an attempt: named by its folder, never a numbered round
    assert.match(md, /- Попытка круга \(папка `rounds\\01`\) не состоялась:/);
    assert.match(md, /Кругов проведено: 3 /);
    assert.match(md, /Попыток круга, не дошедших до проверяющих: 1 \(номера папок: 01\); в число кругов они не входят\./);
    assert.ok(md.includes(ph.rounds.numbering));
    assert.doesNotMatch(md, /[Кк]руг 4(?!\d)/, 'folder 04 is never called round 4');
    assert.deepEqual(lintReportText(md), []);
    const lines = summaryLines(s.runDir);
    assert.ok(lines.includes('Лучшая версия — круг 3 (папка 04).'), lines.join('\n'));
    assert.ok(lines.includes('Попыток круга, не дошедших до проверяющих: 1 (в число кругов не входят).'));
    assert.ok(!lines.some((l) => /[Кк]руг 4/.test(l)));
  } finally {
    s.done();
  }
});

test('an attempt between real rounds shifts only the rounds after it', () => {
  // folders: 01 real (round 1), 02 attempt, 03 real (round 2), 04 real (round 3)
  const s = runWithFolders([1, 3, 4], [2]);
  try {
    writeJson(s.P.best, { round: 3, versionHash: 'x', blockers: 1, majors: 2, lensesValid: true });
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /- Круг 1 \(рабочий\): /, 'folder 01 is round 1: nothing in brackets');
    assert.match(md, /- Круг 2 \(рабочий, папка 03\): /);
    assert.match(md, /- Круг 3 \(рабочий, папка 04\): /);
    assert.match(md, /- Попытка круга \(папка `rounds\\02`\) не состоялась:/);
    assert.match(md, /\(номера папок: 02\)/);
    assert.ok(summaryLines(s.runDir).includes('Лучшая версия — круг 2 (папка 03).'));
    assert.deepEqual(lintReportText(md), []);
  } finally {
    s.done();
  }
});

test('with no attempt the numbers are the folder numbers and nothing is in brackets', () => {
  const s = runWithFolders([1, 2, 3], []);
  try {
    const md = buildReport(s.runDir, { dataPaths: s.dp });
    assert.match(md, /- Круг 3 \(рабочий\): /);
    assert.doesNotMatch(md, /\(папка 0\d\)/);
    assert.doesNotMatch(md, /рабочий, папка/);
    assert.ok(summaryLines(s.runDir).includes('Лучшая версия — круг 1.'));
  } finally {
    s.done();
  }
});
