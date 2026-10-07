// A primary source that refuses the reviewers (night 06-07.10.2026, window 1: Google answered HTTP 429
// all night and the lens that owned the source was invalid every round): documented attempts count
// toward a source-check minimum, the unavailability is visible, nothing is passed off as checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, fixRun, cli, roundDir, readJsonFile, ledgerOf, gateOf, jobsOf } from '../fixtures/engine/helpers.mjs';

/** The fake `facts` lens answers its M3 (source-check S1, count 2) as not done, with n attempts at S1 that were refused. */
function refusedBy(n, { outcome = 'unavailable', result = 'HTTP 429 Too Many Requests' } = {}) {
  return (rec, answer) => {
    if (rec.role !== 'reviewer' || rec.lens !== 'facts') return answer;
    return {
      ...answer,
      inspected: answer.inspected.map((i) => (i.minimumId === 'M3' ? { ...i, done: false, how: 'Источник S1 отказал каждый раз; попытки записаны в sourceChecks.' } : i)),
      sourceChecks: Array.from({ length: n }, (_, k) => ({ sourceId: 'S1', command: `read prices.txt attempt ${k + 1}`, outcome, result })),
      notVerified: [{ claim: 'Цена трёх проверок на странице акции.', whereLooked: 'S1: HTTP 429 при каждой попытке.' }],
    };
  };
}

function ingestOf(runDir, n, lens) {
  const dir = path.join(roundDir(runDir, n), 'ingest');
  return fs.readdirSync(dir).map((f) => readJsonFile(path.join(dir, f))).filter((r) => r.lens === lens);
}

test('a source that refuses the reviewers: documented attempts make the minimum done, the lens stays valid, the ledger and the to-do say so', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2) });
    const facts = ingestOf(r.runDir, 1, 'facts');
    assert.ok(facts.length >= 1);
    for (const rec of facts) {
      assert.equal(rec.valid, true, rec.reasons.join('; '));
      assert.deepEqual(rec.minimumNotDone, []);
      assert.equal(rec.minimumUnavailable.length, 1);
      assert.equal(rec.minimumUnavailable[0].minimumId, 'M3');
      assert.deepEqual(rec.sourceAttempts, [{ sourceId: 'S1', attempts: 2, ok: 0, unavailable: 2, excerpt: 'HTTP 429 Too Many Requests' }]);
    }
    const reason = (gateOf(r.runDir, 1).reasons || []).join(' | ');
    assert.doesNotMatch(reason, /minimum not done/);
    const ev = ledgerOf(r.runDir).filter((e) => e.type === 'source-unavailable' && e.round === 1);
    assert.ok(ev.length >= 1, 'a source-unavailable event is logged');
    const s = ev[ev.length - 1].data.sources.find((x) => x.sourceId === 'S1');
    assert.equal(s.state, 'unavailable');
    assert.deepEqual(s.lenses, ['facts']);
    const todo = fs.readFileSync(path.join(roundDir(r.runDir, 1), 'todo.md'), 'utf8');
    assert.match(todo, /Primary sources the reviewers could not reach/);
    assert.match(todo, /Source S1 was unavailable to reviewers in round 1/);
    assert.match(todo, /HTTP 429/);
  });
});

test('too few documented attempts, or attempts without an unavailable one, still leave the minimum not done', async () => {
  await withEnv(async (env) => {
    const one = await fixRun(env, { mutate: refusedBy(1) });
    const rec = ingestOf(one.runDir, 1, 'facts')[0];
    assert.equal(rec.valid, false);
    assert.deepEqual(rec.minimumNotDone, ['M3']);
    assert.ok(rec.reasons.some((x) => /minimum not done: M3/.test(x)));
  });
  await withEnv(async (env) => {
    const allOk = await fixRun(env, { mutate: refusedBy(3, { outcome: 'ok', result: 'price 45 EUR' }) });
    const rec = ingestOf(allOk.runDir, 1, 'facts')[0];
    assert.equal(rec.valid, false, 'a reviewer who got answers but says it did not finish is not rescued');
    assert.deepEqual(rec.minimumNotDone, ['M3']);
  });
});

test('the report says that the source was unavailable to reviewers in round N, in plain Russian', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2) });
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(rep.payload.reportPath, 'utf8');
    assert.match(md, /Источник `S1` был недоступен проверяющим в круге 1: не вышло 2 из 2 попыток/);
    assert.match(md, /ответ источника: HTTP 429/);
    assert.match(md, /Взгляд из-за этого недействительным не считается/);
    assert.ok(jobsOf(r.runDir, 1).length > 0);
  });
});

test('the report does not also say "required item not done" for an item the refusal made impossible', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2) });
    const rep = await cli(['report', r.runDir]);
    const md = fs.readFileSync(rep.payload.reportPath, 'utf8');
    assert.match(md, /Источник `S1` был недоступен/);
    assert.doesNotMatch(md, /обязательный пункт не выполнен: M3/);
    assert.doesNotMatch(md, /M3: Источник S1 отказал каждый раз/);
  });
});

test('an entry that has no outcome but whose result is an error status is read as unavailable', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2, { outcome: undefined, result: 'HTTP 429 Too Many Requests' }) });
    const rec = ingestOf(r.runDir, 1, 'facts')[0];
    assert.equal(rec.valid, true, rec.reasons.join('; '));
    assert.equal(rec.minimumUnavailable.length, 1);
  });
});

test('when the code read the source fine at the round start and every reviewer attempt failed, ledger, to-do and report say it is suspicious', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2) });
    const check = readJsonFile(path.join(roundDir(r.runDir, 1), 'sources-check.json'));
    assert.ok(check.results.find((x) => x.id === 'S1')?.ok, 'the fixture source answers at the round start');
    const ev = ledgerOf(r.runDir).filter((e) => e.type === 'source-unavailable' && e.round === 1).pop();
    const s = ev.data.sources.find((x) => x.sourceId === 'S1');
    assert.equal(s.suspicious, true);
    assert.equal(s.precheckOk, true);
    const todo = fs.readFileSync(path.join(roundDir(r.runDir, 1), 'todo.md'), 'utf8');
    assert.match(todo, /read this source without trouble/);
    assert.doesNotMatch(todo, /lens facts/, 'the to-do names no lens');
    const rep = await cli(['report', r.runDir]);
    const md = fs.readFileSync(rep.payload.reportPath, 'utf8');
    assert.match(md, /программа прочитала источник `S1` без труда/);
  });
});

test('verifier prompts carry the list of sources that refused the reviewers', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: refusedBy(2) });
    const prompts = path.join(roundDir(r.runDir, 1), 'prompts');
    const verifierJobs = jobsOf(r.runDir, 1).filter((j) => j.role === 'verifier' || j.role === 'dispute');
    assert.ok(verifierJobs.length > 0, "the fixture scenario verifies findings");
    const texts = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
    const verifierText = texts.filter((t) => /## Items|## Disputes/.test(t));
    assert.ok(verifierText.length > 0);
    for (const t of verifierText) assert.match(t, /Sources that refused the reviewers in this round[\s\S]*- S1: 2 of 2 documented attempt/);
  });
});

test('one invented "unavailable" entry among real answers does not escape the suspicious flag when the code read the source fine', async () => {
  await withEnv(async (env) => {
    const mixed = (rec, answer) => {
      if (rec.role !== 'reviewer' || rec.lens !== 'facts') return answer;
      return {
        ...answer,
        sourceChecks: [
          { sourceId: 'S1', command: 'read prices.txt attempt 1', outcome: 'ok', result: 'price 45 EUR' },
          { sourceId: 'S1', command: 'read prices.txt attempt 2', outcome: 'unavailable', result: 'HTTP 429 Too Many Requests' },
        ],
      };
    };
    const r = await fixRun(env, { mutate: mixed });
    const check = readJsonFile(path.join(roundDir(r.runDir, 1), 'sources-check.json'));
    assert.ok(check.results.find((x) => x.id === 'S1')?.ok, 'the fixture source answers at the round start');
    const ev = ledgerOf(r.runDir).filter((e) => e.type === 'source-unavailable' && e.round === 1).pop();
    const s = ev.data.sources.find((x) => x.sourceId === 'S1');
    assert.equal(s.state, 'partial');
    assert.equal(s.suspicious, true);
    assert.equal(s.precheckOk, true);
    const rep = await cli(['report', r.runDir]);
    const md = fs.readFileSync(rep.payload.reportPath, 'utf8');
    assert.match(md, /программа прочитала источник `S1` без труда/);
  });
});

test('a new gate input carries the plateau and best rules, and audit replays it', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, {});
    const input = readJsonFile(path.join(roundDir(r.runDir, 1), 'gate-input.json'));
    assert.equal(input.plateauRule, 'reviewed');
    assert.equal(input.bestRule, 'reviewed');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});
