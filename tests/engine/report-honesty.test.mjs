// Bug 12: the report and the summary must say the same about the honesty check, tell the truth about who
// stopped the run (the program first, the owner after), and say plainly when another version of the
// program rebuilt the report of an older run. A real mismatch is never turned into a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, readyRun, cli, readJsonFile, ledgerOf, stateOf } from '../fixtures/engine/helpers.mjs';
import { audit } from '../../lib/engine/audit.mjs';
import { run as reportCmd } from '../../lib/report/cmd-report.mjs';
import { recordEvent } from '../../lib/core/runstore.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { REPO_DIR, gitHead } from '../../lib/core/config.mjs';
import { notComparedLines } from '../../lib/report/report-ru.mjs';

const Q = 'Вы согласны с этим решением?';

/** A run that the token limit stops before any round starts. */
function limitRun(env) {
  return readyRun(env, {
    beforeSetup: (x) => {
      const p = path.join(x.runDir, 'run.json');
      const run = readJsonFile(p);
      run.limits = { ...run.limits, maxPanelTokens: 100000 };
      fs.writeFileSync(p, JSON.stringify(run, null, 2));
    },
  });
}

const reportText = (runDir) => fs.readFileSync(path.join(runDir, 'REPORT.ru.md'), 'utf8').replace(/\r\n/g, '\n');
const ownerStop = (runDir, quote = 'всё, останавливаемся') => cli(['owner', runDir, '--kind', 'stop', '--owner-quote', quote, '--question', Q]);

/** A copy of the parts of the repository that FROZEN.json hashes (taxonomy, catalog), with another word list. */
function fakeRepo(env, { sameVersion = false, changeCatalog = true, noGit = false } = {}) {
  const dir = path.join(env.root, 'fake-repo');
  fs.mkdirSync(path.join(dir, 'catalog'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'taxonomy'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO_DIR, 'catalog'))) fs.copyFileSync(path.join(REPO_DIR, 'catalog', f), path.join(dir, 'catalog', f));
  fs.copyFileSync(path.join(REPO_DIR, 'taxonomy', 'canary-types.json'), path.join(dir, 'taxonomy', 'canary-types.json'));
  if (changeCatalog) {
    const f = path.join(dir, 'catalog', 'trace-patterns.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n');
  }
  const pkg = readJsonFile(path.join(REPO_DIR, 'package.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version: sameVersion ? pkg.version : '9.9.9' }));
  const head = gitHead(REPO_DIR);
  if (sameVersion && head && !noGit) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head + '\n');
  }
  return dir;
}

test('owner stop after the program already stopped the run: the audit around the rebuilt report passes and report and summary agree', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'STOP_LIMIT');
    assert.ok(s.payload.summaryRu.includes('Проверка честности: пройдена.'), s.payload.summaryRu.join('\n'));
    const st = await ownerStop(r.runDir);
    assert.equal(st.exitCode, 30, st.text);
    assert.equal(stateOf(r.runDir).lastDecision, 'STOP_OWNER');
    const a = readJsonFile(path.join(r.runDir, 'AUDIT.json'));
    assert.equal(a.ok, true, JSON.stringify(a.checks.filter((c) => !c.ok)));
    const md = reportText(r.runDir);
    assert.doesNotMatch(md, /Проверка честности НЕ пройдена/);
    assert.match(md, /Проверка честности пройдена: все \d+ пунктов сходятся/);
    assert.ok(st.payload.summaryRu.includes('Проверка честности: пройдена.'), st.payload.summaryRu.join('\n'));
    const again = await cli(['audit', r.runDir]);
    assert.equal(again.exitCode, 0, again.text);
    assert.ok(ledgerOf(r.runDir).filter((e) => e.type === 'audit').every((e) => e.data.ok), 'no audit event of this run says failed');
    // the logged report numbers are the ones of the final state
    const rep = ledgerOf(r.runDir).filter((e) => e.type === 'report').at(-1);
    assert.equal(rep.data.numbers.decision, 'STOP_OWNER');
  });
});

test('the stop reason is told in order: the program stopped first, the owner said stop after', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const st = await ownerStop(r.runDir);
    const line = st.payload.summaryRu[0];
    assert.equal(line, 'Не готово: остановлено, потому что сначала кончился лимит (токенов), а потом вы сами тоже сказали остановить проверку.');
    assert.ok(reportText(r.runDir).includes(`## 1. Итог одной строкой\n\n${line}\n`));
    assert.match(stateOf(r.runDir).stoppedReason, /owner asked to stop; the program had already stopped the run: STOP_LIMIT/);
    const gate = ledgerOf(r.runDir).filter((e) => e.type === 'gate' && e.data.decision === 'STOP_OWNER').at(-1);
    assert.equal(gate.data.reasons[0], 'owner asked to stop');
    assert.match(gate.data.reasons[1], /STOP_LIMIT/);
    // a second «stop» keeps both
    const st2 = await ownerStop(r.runDir, 'ещё раз: стоп');
    assert.equal(st2.payload.summaryRu[0], line);
  });
});

test('an owner stop on a run the program had not stopped is told as before', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const st = await ownerStop(r.runDir);
    assert.equal(st.exitCode, 30, st.text);
    assert.equal(st.payload.summaryRu[0], 'Не готово: остановлено, потому что вы сами остановили проверку.');
    assert.equal(readJsonFile(path.join(r.runDir, 'AUDIT.json')).ok, true);
  });
});

test('a report older than the last events is named, never reported as a broken honesty check; rebuilding clears it', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const up = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxPanelTokens=50000000', '--owner-quote', 'подними лимит', '--question', Q]);
    assert.equal(up.exitCode, 0, up.text);
    const a = await cli(['audit', r.runDir]);
    assert.equal(a.exitCode, 0, a.text);
    assert.deepEqual(a.payload.notCompared.map((n) => `${n.id}:${n.kind}`), ['report:stale']);
    assert.match(a.text, /NOT COMPARED report: the report on disk is older than the last \d+ state-changing event/);
    assert.match(a.text, /NEXT: nothing is broken, but say to the owner which comparison could not be made/);
    const sum = await cli(['report', r.runDir, '--summary']);
    const lines = sum.payload.summaryRu;
    assert.ok(lines.some((l) => /Проверка честности: пройдена не полностью/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /Отчёт, лежащий в папке, собран раньше последних событий запуска/.test(l) && /командой report/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /НЕ пройдена/.test(l)));
    // rebuilding writes a report that matches the files and the summary says plain «пройдена»
    const w = await cli(['report', r.runDir]);
    assert.equal(w.exitCode, 0, w.text);
    assert.ok(w.payload.summaryRu.includes('Проверка честности: пройдена.'), w.payload.summaryRu.join('\n'));
    const rep = ledgerOf(r.runDir).filter((e) => e.type === 'report').at(-1);
    assert.ok(rep.data.numbers, 'the report command logs the numbers too');
    const b = await cli(['audit', r.runDir]);
    assert.equal(b.exitCode, 0);
    assert.deepEqual(b.payload.notCompared, []);
  });
});

test('a real mismatch is still a failure: wrong numbers logged for the current state, or about to be logged', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const good = ledgerOf(r.runDir).filter((e) => e.type === 'report').at(-1).data.numbers;
    // 1. a report event with other numbers and no later state change
    recordEvent(r.runDir, 'report', { path: 'REPORT.ru.md', numbers: { ...good, tokens: good.tokens + 1 }, sha256: 'x' }, null, { dataPaths: dataPaths(env.dataHome) });
    const bad = await cli(['audit', r.runDir]);
    assert.equal(bad.exitCode, 3, bad.text);
    assert.match(bad.text, /FAIL report: report numbers differ from the run files/);
    // 2. the numbers a command is about to log differ from the files
    const ctx = { dataHome: env.dataHome, repoDir: REPO_DIR, env: process.env };
    const res = audit(r.runDir, ctx, { automatic: true, record: false, rebuildingReport: true, reportNumbers: { ...good, decision: 'DONE' } });
    assert.equal(res.ok, false);
    assert.match(res.checks.find((c) => c.id === 'report').details[0], /about to be logged/);
    const okRes = audit(r.runDir, ctx, { automatic: true, record: false, rebuildingReport: true, reportNumbers: good });
    assert.equal(okRes.checks.find((c) => c.id === 'report').ok, true);
  });
});

test('a report logged with another set of numbers is compared on the common ones and says so', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const good = ledgerOf(r.runDir).filter((e) => e.type === 'report').at(-1).data.numbers;
    const dp = dataPaths(env.dataHome);
    const { tokens: _t, ...fewer } = good;
    recordEvent(r.runDir, 'report', { path: 'REPORT.ru.md', numbers: { ...fewer, oldField: 1 }, sha256: 'x' }, null, { dataPaths: dp });
    const a = await cli(['audit', r.runDir]);
    assert.equal(a.exitCode, 0, a.text);
    assert.equal(a.payload.notCompared[0].kind, 'fields');
    assert.equal(notComparedLines(a.payload).length, 1);
    // a difference in a common field is still a failure
    recordEvent(r.runDir, 'report', { path: 'REPORT.ru.md', numbers: { ...fewer, decision: 'DONE', oldField: 1 }, sha256: 'x' }, null, { dataPaths: dp });
    const b = await cli(['audit', r.runDir]);
    assert.equal(b.exitCode, 3, b.text);
  });
});

test('another version of the program rebuilds the report of an older run: everything else is checked, the word-list comparison is named as not made', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const repoDir = fakeRepo(env);
    const ctx = { dataHome: env.dataHome, repoDir, env: process.env, json: false };
    const sum = await reportCmd([r.runDir, '--summary'], ctx);
    const lines = sum.payload.summaryRu;
    const joined = lines.join('\n');
    assert.ok(lines.some((l) => /^Проверка честности: пройдена не полностью/.test(l)), joined);
    assert.doesNotMatch(joined, /НЕ пройдена/);
    assert.doesNotMatch(joined, /цифры отчёта совпадают с записями/);
    assert.match(joined, /Отчёт собран другой версией программы, чем та, которой начат запуск \(запуск начат версией 0\.1\.0.*отчёт собран версией 9\.9\.9/);
    assert.match(joined, /список слов — следов прошлых проверок \(файл catalog\/trace-patterns\.json\)/);
    // the report file carries the same statement in section 13
    const w = await reportCmd([r.runDir], ctx);
    assert.equal(w.exitCode, 0);
    const md = reportText(r.runDir);
    const sec = md.slice(md.indexOf('## 13.'));
    assert.match(sec, /Проверка честности пройдена не полностью/);
    assert.match(sec, /Отчёт собран другой версией программы/);
    assert.doesNotMatch(sec, /НЕ пройдена/);
    for (const l of w.payload.summaryRu) if (/другой версией/.test(l)) assert.ok(sec.includes(l), 'summary and section 13 use the same words');
    // the AUDIT.json carries it too, and the rest of the checks ran and passed
    const a = readJsonFile(path.join(r.runDir, 'AUDIT.json'));
    assert.equal(a.ok, true);
    assert.deepEqual(a.notCompared.map((n) => n.id), ['frozen']);
    assert.equal(a.checks.length, 13);
    // but a command that goes on with the run refuses: its word lists are not the ones the run started with
    const { step } = await import('../../lib/engine/step.mjs');
    await assert.rejects(step(r.runDir, { ctx }), (e) => e.code === 'FROZEN_MISMATCH');
  });
});

test('the same program version with other word lists is an edit, not a version change: the audit fails and names the frozen settings', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const ctx = { dataHome: env.dataHome, repoDir: fakeRepo(env, { sameVersion: true }), env: process.env, json: false };
    const sum = await reportCmd([r.runDir, '--summary'], ctx);
    const joined = sum.payload.summaryRu.join('\n');
    assert.match(joined, /Проверка честности: НЕ пройдена \(не сходятся пункты: настройки не менялись после заморозки\)/);
    assert.doesNotMatch(joined, /цепочка записей/);
  });
});

test('a copy of the program that has no readable git head does not excuse an edited word list (A3)', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const frozen = readJsonFile(path.join(r.runDir, 'FROZEN.json'));
    if (!frozen.tool?.gitHead) return; // the program under test runs without .git: nothing to compare
    const ctx = { dataHome: env.dataHome, repoDir: fakeRepo(env, { sameVersion: true, noGit: true }), env: process.env, json: false };
    const sum = await reportCmd([r.runDir, '--summary'], ctx);
    const joined = sum.payload.summaryRu.join('\n');
    assert.match(joined, /Проверка честности: НЕ пройдена/);
    assert.doesNotMatch(joined, /пройдена не полностью/);
  });
});

test('a change in the run\'s own frozen files is never excused as a version change', async () => {
  await withEnv(async (env) => {
    const r = await limitRun(env);
    await cli(['step', r.runDir]);
    const f = path.join(r.runDir, 'templates', 'reviewer.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\nextra line\n');
    const ctx = { dataHome: env.dataHome, repoDir: fakeRepo(env), env: process.env, json: false };
    const res = audit(r.runDir, ctx, { automatic: true, record: false });
    assert.equal(res.ok, false);
    assert.equal(res.checks[0].id, 'frozen');
    assert.match(res.checks[0].details[0], /templates\/reviewer\.md/);
  });
});
