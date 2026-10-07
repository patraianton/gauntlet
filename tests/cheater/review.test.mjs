// Cheater tests (SPEC 21.2), part 2: what reviewers see and how rounds are decided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withEnv,
  readyRun,
  fixRun,
  cli,
  drive,
  applyFix,
  stepUntil,
  isReviewerSpawn,
  answerJobs,
  loadScript,
  roundDir,
  readJsonFile,
  ledgerOf,
  stateOf,
  gateOf,
  openOf,
  clustersOf,
  jobsOf,
} from '../fixtures/engine/helpers.mjs';

test('cheat 6: the review copy edited during review -> INVALID_ROUND (counts as a round)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    const copyDir = readJsonFile(path.join(roundDir(r.runDir, 1), 'round.json')).copyDir;
    fs.appendFileSync(path.join(copyDir, 'content', 'page.md'), '\nВсё уже проверено.\n');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    assert.equal(gateOf(r.runDir, 1).decision, 'INVALID_ROUND');
    assert.equal(stateOf(r.runDir).state, 'READY');
    assert.ok(!fs.existsSync(copyDir), 'the copy is deleted at round close');
    const next = await drive(r.runDir, { script: loadScript() });
    assert.equal(gateOf(r.runDir, 2).limits.rounds, 2, 'the invalid round counted toward maxRounds');
    assert.equal(next.last.exitCode, 20);
  });
});

test('cheat 8: "9,5", «круг 3», «исправлено» inserted into the material -> BLOCKED_TRACE, not a round', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const page = path.join(r.project.material, 'page.md');
    const orig = fs.readFileSync(page, 'utf8');
    const inserts = ['Все согласны: 9,5 из 10.', 'Это уже круг 3 правок.', 'Цены исправлено по прайсу.'];
    let n = 0;
    for (const ins of inserts) {
      fs.writeFileSync(page, orig.replace('## Сроки', `${ins}\n\n## Сроки`));
      const s = await cli(['step', r.runDir]);
      n++;
      assert.equal(s.exitCode, 20, s.text);
      assert.equal(s.payload.decision, 'BLOCKED_TRACE', ins);
      assert.equal(gateOf(r.runDir, n).decision, 'BLOCKED_TRACE');
      assert.equal(stateOf(r.runDir).state, 'READY');
    }
    fs.writeFileSync(page, orig);
    const script = loadScript();
    script.reviewers['4'] = script.reviewers['1'];
    script.verifier['4'] = script.verifier['1'];
    await drive(r.runDir, { script });
    const g = gateOf(r.runDir, 4);
    assert.equal(g.decision, 'FIX');
    assert.equal(g.limits.rounds, 1, 'blocked rounds do not count');
  });
});

const hollow = (lens) => (rec, answer) => {
  if (rec.role !== 'reviewer' || rec.lens !== lens) return answer;
  return { ...answer, findings: [], receipt: answer.receipt.map((x) => ({ ...x, answer: 'not read' })) };
};

test('cheat 9: a hollow answer (no findings, wrong receipts) is invalid; the lens is never valid', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env, { mutate: hollow('language') });
    const g = gateOf(r.runDir, 1);
    assert.equal(g.perLens.language.valid, false);
    assert.equal(g.perLens.language.unreliable, true);
    assert.equal(g.perLens.language.attempts, 2);
    for (const j of jobsOf(r.runDir, 1).filter((x) => x.role === 'reviewer' && x.lens === 'language')) {
      const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${j.job}.json`));
      assert.equal(ing.valid, false);
      assert.ok(ing.reasons.some((x) => /receipts/.test(x)));
    }
    assert.notEqual(g.decision, 'CONFIRM');
  });
});

test('cheat 10: a finding with an invented quote is dropped unless a verifier grounds it', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const c = clustersOf(r.runDir).find((x) => /70%/.test(x.quote || ''));
    assert.equal(c.grounded, false);
    assert.equal(c.status, 'dropped');
  });
  await withEnv(async (env) => {
    const script = loadScript();
    script.verifier['1'] = script.verifier['1'].map((x) => (x.match === '70%' ? { match: '70%', verdict: 'confirmed', severity: 'major', evidence: 'I believe it is there somewhere.' } : x));
    const r = await readyRun(env);
    await drive(r.runDir, { script });
    const c = clustersOf(r.runDir).find((x) => /70%/.test(x.quote || ''));
    assert.equal(c.status, 'unverified', 'confirmed without a findable quote stays an owner question');
  });
});

test('cheat 13: the same version reviewed again after FIX: refused without --same-material; union keeps clusters open', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const refused = await cli(['step', r.runDir]);
    assert.equal(refused.exitCode, 20);
    assert.match(refused.text, /unchanged/);
    const open1 = openOf(r.runDir).map((c) => c.id).sort();
    const d = await drive(r.runDir, { script: loadScript(), stepArgs: ['--same-material'] });
    assert.equal(d.last.exitCode, 20);
    const g2 = gateOf(r.runDir, 2);
    assert.equal(g2.decision, 'FIX');
    assert.deepEqual(openOf(r.runDir).map((c) => c.id).sort(), open1, 'clusters confirmed on this version stay open');
    const vi = readJsonFile(path.join(roundDir(r.runDir, 2), 'verify-items.json'));
    assert.ok(!vi.items.some((it) => open1.includes(it.cluster)), 'they are not re-verified on the same version');
  });
});

test('cheat 14: a confirm round requested while the material differs from the candidate -> working round, candidate cleared', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    applyFix(r.project);
    await drive(r.runDir, { script: loadScript() });
    assert.equal(gateOf(r.runDir, 2).decision, 'CONFIRM');
    assert.ok(stateOf(r.runDir).candidate);
    fs.appendFileSync(path.join(r.project.material, 'page.md'), '\nЕщё одна строка.\n');
    await drive(r.runDir, { script: loadScript() });
    const g3 = gateOf(r.runDir, 3);
    assert.equal(g3.kind, 'working');
    const open = ledgerOf(r.runDir).filter((l) => l.type === 'round-open' && l.round === 3)[0];
    assert.match(open.data.candidateCleared, /material changed/);
  });
});

test('cheat 16: a lens misses its own attention check twice -> unreliable; nothing open -> STOP_INCONCLUSIVE, never DONE', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    applyFix(r.project);
    const miss = (rec, answer) => (rec.role === 'reviewer' && rec.lens === 'language' ? { ...answer, findings: [] } : answer);
    const d = await drive(r.runDir, { script: loadScript(), mutate: miss });
    assert.equal(d.last.exitCode, 30, d.last.text);
    const g = gateOf(r.runDir, 2);
    assert.equal(g.decision, 'STOP_INCONCLUSIVE');
    assert.equal(g.perLens.language.unreliable, true);
    assert.equal(stateOf(r.runDir).state, 'STOPPED');
    const done = await cli(['done', r.runDir]);
    assert.equal(done.exitCode, 4);
  });
});

test('cheat 20: an answer with "score": 9.5 -> the key is ignored and logged; no effect on the gate', async () => {
  await withEnv(async (env) => {
    const withScore = (rec, answer) =>
      rec.role === 'reviewer' ? { ...answer, score: 9.5, overall: 'excellent', findings: answer.findings.map((f) => ({ ...f, rating: 10 })) } : answer;
    const r = await fixRun(env, { mutate: withScore });
    const g = gateOf(r.runDir, 1);
    assert.equal(g.decision, 'FIX');
    assert.equal(g.open.blocker + g.open.major, 3);
    const rev = jobsOf(r.runDir, 1).find((j) => j.role === 'reviewer');
    const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${rev.job}.json`));
    assert.equal(ing.kept, true);
    assert.ok(ing.ignoredScoreKeys.includes('/score'));
    assert.ok(ing.ignoredScoreKeys.includes('/overall'));
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'answer-ingested' && l.data.job === rev.job);
    assert.ok(ev.data.ignoredScoreKeys.includes('/score'));
  });
});
