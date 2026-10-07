// A blocked attempt (BLOCKED_PRECHECK / BLOCKED_TRACE) holds a round folder number but is not a round:
// it is left out of the round limit, the plateau, the best version, status and the report.
// And the best version is kept from every reviewed round, whatever the lenses' validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, readyRun, cli, drive, gateOf, stateOf, readJsonFile } from '../fixtures/engine/helpers.mjs';
import { loadScript } from '../../lib/selftest/scenarios.mjs';
import { runPaths } from '../../lib/core/runstore.mjs';
import { audit } from '../../lib/engine/audit.mjs';

test('a blocked attempt keeps its folder number but counts nowhere; the next round is a normal round 2', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const page = path.join(r.project.material, 'page.md');
    const orig = fs.readFileSync(page, 'utf8');
    fs.writeFileSync(page, orig.replace('## Сроки', 'Цены исправлено по прайсу.\n\n## Сроки'));
    const blocked = await cli(['step', r.runDir]);
    assert.equal(blocked.exitCode, 20, blocked.text);
    assert.equal(blocked.payload.decision, 'BLOCKED_TRACE');
    fs.writeFileSync(page, orig);

    // the attempt used folder 01 and is marked blocked
    assert.equal(gateOf(r.runDir, 1).decision, 'BLOCKED_TRACE');
    assert.equal(readJsonFile(path.join(runPaths(r.runDir).roundDir(1).roundJson)).blocked, true);

    // the status says it is not a round
    const st = await cli(['status', r.runDir]);
    assert.match(st.text, /attempt 1 \(not a round, no reviewer ran\): BLOCKED_TRACE/);
    assert.match(st.text, /Rounds held: 0; blocked attempts \(not counted anywhere\): 1/);
    assert.equal(st.payload.rounds[0].notARound, true);

    // the next round runs under the next folder number, with the blocked attempt out of every count
    const script = loadScript();
    script.reviewers['2'] = script.reviewers['1'];
    script.verifier['2'] = script.verifier['1'];
    const d = await drive(r.runDir, { script });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const g = gateOf(r.runDir, 2);
    assert.equal(g.decision, 'FIX');
    assert.equal(g.limits.rounds, 1, 'one working round counted toward maxRounds');
    assert.deepEqual(g.history.map((h) => h.round), [2], 'the history holds the reviewed round only');
    const st2 = await cli(['status', r.runDir]);
    assert.match(st2.text, /Rounds held: 1; blocked attempts \(not counted anywhere\): 1/);

    // the owner report: the attempt is told as an attempt, with no counts; the round count is 1
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /- Попытка круга \(папка `rounds\\01`\) не состоялась: в копии нашлись следы прошлых проверок/);
    assert.doesNotMatch(md, /- Круг 1 \(/);
    assert.match(md, /- Круг 2 \(рабочий\): открытых серьёзных проблем/);
    assert.match(md, /Кругов проведено: 1 /);
    assert.match(md, /Попыток круга, не дошедших до проверяющих: 1 \(номера папок: 1\)/);
  });
});

test('the best version is recorded from a round whose lens answer was rejected, and the audit replays it', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    // every attempt of one lens talks about the check itself: its answer is rejected, the lens never validates
    let lens = null;
    const d = await drive(r.runDir, {
      script: loadScript(),
      mutate: (rec, answer) => {
        if (rec.role !== 'reviewer') return answer;
        lens ??= rec.lens;
        if (rec.lens !== lens) return answer;
        return { ...answer, notChecked: [{ what: 'the honeypot at the end of the plan', why: 'not reached' }] };
      },
    });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const g = gateOf(r.runDir, 1);
    assert.equal(g.perLens[lens].valid, false);
    assert.ok(g.perLens[lens].invalidReasons.some((x) => x.includes('talks about the check itself')), JSON.stringify(g.perLens[lens]));
    assert.equal(g.decision, 'FIX');
    assert.equal(g.best.round, 1);
    assert.equal(g.best.lensesValid, false);
    const st = stateOf(r.runDir);
    assert.equal(st.best.round, 1);
    assert.equal(readJsonFile(runPaths(r.runDir).best).round, 1, 'best.json exists, so restore-best has something to restore');
    // the audit replays the gate with the stored input (which carries the rule)
    const a = audit(r.runDir, {}, { record: false });
    const gate = a.checks.find((c) => c.id === 'gate');
    assert.equal(gate.ok, true, JSON.stringify(gate));
    // the report says the best round was not fully checked
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => /^Лучшая версия — круг 1; в нём не все взгляды были проверены полностью/.test(l)), sum.payload.summaryRu.join('\n'));
  });
});
