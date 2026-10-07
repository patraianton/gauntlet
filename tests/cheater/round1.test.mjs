// Cheater and regression tests for the fixes of review round 1 (failure points that stayed open).
// Each test plays the cheat or the trap a verified finding described and checks it is now caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withEnv,
  freshRun,
  readyRun,
  fixRun,
  doneRun,
  cli,
  drive,
  stepUntil,
  isReviewerSpawn,
  answerJobs,
  loadScript,
  roundDir,
  readJsonFile,
  ledgerOf,
  stateOf,
} from '../fixtures/engine/helpers.mjs';
import { lensValidity, decide } from '../../lib/engine/gate.mjs';
import { combineDisputeAnswers } from '../../lib/engine/dispute.mjs';

const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

test('r1-f4: clusters.json edited by hand between commands -> exit 3 TAMPER, the open problems cannot be closed this way', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const p = path.join(r.runDir, 'clusters.json');
    const c = readJsonFile(p);
    const open = c.clusters.filter((x) => ['open', 'unverified', 'contested'].includes(x.status));
    assert.ok(open.length > 0);
    for (const x of open) x.status = 'closed';
    writeJson(p, c);
    const s = await cli(['step', r.runDir, '--same-material']);
    assert.equal(s.exitCode, 3, s.text);
    assert.equal(s.payload.error.code, 'TAMPER');
    assert.match(s.payload.error.message, /clusters\.json/);
    const a = await cli(['audit', r.runDir]);
    assert.equal(a.exitCode, 3);
  });
});

test('r1-f4: round files and ingest records are guarded too; untouched runs pass the automatic audit at done', async () => {
  await withEnv(async (env) => {
    const r = await doneRun(env);
    const d = await cli(['done', r.runDir]);
    assert.equal(d.exitCode, 30, d.text);
    const audit = readJsonFile(path.join(r.runDir, 'AUDIT.json'));
    assert.equal(audit.ok, true, JSON.stringify(audit.checks.filter((x) => !x.ok)));
    const ing = path.join(roundDir(r.runDir, 1), 'ingest');
    const f = path.join(ing, fs.readdirSync(ing)[0]);
    const rec = readJsonFile(f);
    rec.valid = !rec.valid;
    writeJson(f, rec);
    const st = await cli(['status', r.runDir]);
    assert.equal(st.exitCode, 3);
    assert.equal(st.payload.error.code, 'TAMPER');
  });
});

test('r1-f1/f21: a strip rule that deletes text without a review trace is refused before freeze; the owner\'s words let it through and it is listed', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const sp = path.join(r.runDir, 'strip.json');
    const strip = readJsonFile(sp);
    strip.regex.push({ glob: 'content/page.md', pattern: 'Мастер проверит двадцать пунктов', replace: '', expect: 'atLeastOne', why: 'shorter page' });
    writeJson(sp, strip);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20, s.text);
    assert.equal(s.state, 'NEW');
    assert.match(s.text, /carries no review trace/);
    const q = await cli(['step', r.runDir, '--owner-quote', 'да, этот абзац можно не проверять', '--question', 'Вы согласны с этим решением?']);
    assert.equal(q.exitCode, 10, q.text);
    const od = readJsonFile(path.join(r.runDir, 'owner-decisions.json')).decisions;
    assert.equal(od.at(-1).kind, 'strip-narrowing');
    assert.match(od.at(-1).narrowing[0], /carries no review trace/);
    // a strip rule that does not compile, and one that rewrites text, are refused too
    const r2 = await freshRun(env, { name: 'p2' });
    const sp2 = path.join(r2.runDir, 'strip.json');
    const s2 = readJsonFile(sp2);
    s2.regex.push({ glob: 'content/page.md', pattern: '(unclosed', replace: '', expect: 'any', why: 'x' });
    writeJson(sp2, s2);
    const bad = await cli(['step', r2.runDir]);
    assert.equal(bad.exitCode, 20);
    assert.match(bad.text, /does not compile/);
  });
});

test('r1-f2: a facts file inside the project working folder or the material is refused as a primary source', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const facts = path.join(r.project.projectDir, 'FACTS-FOR-PANEL.md');
    fs.writeFileSync(facts, 'Prices: 15 EUR per check.\n');
    const sp = path.join(r.runDir, 'sources.json');
    const src = readJsonFile(sp);
    src.sources.push({ id: 'S3', what: 'Facts for the reviewers', origin: 'written by the executor', kind: 'file', path: facts.replace(/\\/g, '/') });
    writeJson(sp, src);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20, s.text);
    assert.match(s.text, /S3 failed: refused: .*project working folder/);
    // a wrapper script inside the material is refused as well
    src.sources[2] = { id: 'S3', what: 'Facts', origin: 'a script', kind: 'command', cmd: 'node', args: [path.join(r.project.material, 'facts.mjs')] };
    fs.writeFileSync(path.join(r.project.material, 'facts.mjs'), "console.log('15 EUR')\n");
    writeJson(sp, src);
    const s2 = await cli(['step', r.runDir]);
    assert.equal(s2.exitCode, 20, s2.text);
    assert.match(s2.text, /S3 failed: refused: the recipe reads .*material root/);
  });
});

test('r1-f20: sources.json with single backslashes -> exit 4 with a hint, from sources check and from step', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    fs.writeFileSync(path.join(r.runDir, 'sources.json'), '{"schemaVersion":1,"sources":[{"id":"S1","kind":"file","what":"x","origin":"y here","path":"C:\\Users\\user.md"}]}');
    const c = await cli(['sources', 'check', r.runDir]);
    assert.equal(c.exitCode, 4, c.text);
    assert.match(c.payload.error.message, /doubled backslashes/);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 4, s.text);
  });
});

test('r1-f25/f10: a relative review base, or one next to the run folders, is refused before anything runs', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const rp = path.join(r.runDir, 'run.json');
    const run = readJsonFile(rp);
    assert.ok(!/[\\/]wc$/.test(run.reviewBase), 'the default review base is no longer <projectDir>\\wc');
    run.reviewBase = 'C:Users/user/x/_wc';
    writeJson(rp, run);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20, s.text);
    assert.match(s.text, /not an absolute path/);
    run.reviewBase = path.join(r.project.projectDir, 'wc');
    writeJson(rp, run);
    const s2 = await cli(['step', r.runDir]);
    assert.equal(s2.exitCode, 20, s2.text);
    assert.match(s2.text, /holds gauntlet-runs/);
  });
});

test('r1-f17: the owner\'s product words («оценка стоимости», "credit score") stay in the task; loop-control lines do not', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const f = path.join(env.workspace, 'task2.md');
    fs.writeFileSync(f, 'Сделай сайт с оценкой стоимости авто.\nПокажи среднюю цену по марке.\nAdd a credit score badge.\nГоняй панель до готовности.\n');
    const bad = await cli(['task', 'set', r.runDir, '--from', f, '--source', 'test']);
    assert.equal(bad.exitCode, 4);
    assert.match(bad.payload.error.message, /line 4/);
    assert.doesNotMatch(bad.payload.error.message, /line [123]:/);
    const ok = await cli(['task', 'set', r.runDir, '--from', f, '--cut', '4', '--source', 'test']);
    assert.equal(ok.exitCode, 0, ok.text);
  });
});

test('r1-f15: raise-limit only raises the budget limits; protections cannot be changed by a quote', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const q = ['--owner-quote', 'подними лимиты, я разрешаю', '--question', 'Вы согласны с этим решением?'];
    const plateau = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.plateauRounds=99', ...q]);
    assert.equal(plateau.exitCode, 4);
    const lower = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxRounds=2', ...q]);
    assert.equal(lower.exitCode, 4);
    const up = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxRounds=10', ...q]);
    assert.equal(up.exitCode, 0, up.text);
  });
});

test('r1-f3: an answer changed after the agent reported its code makes the attempt invalid (answer-hash-mismatch)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    const written = answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const victim = written.find((w) => w.role === 'reviewer');
    // the executor edits the answer after the agent replied "DONE <code>"
    const rec = readJsonFile(path.join(roundDir(r.runDir, 1), 'jobs.json')).jobs.find((j) => j.job === victim.job);
    const ap = path.join(rec.dir, 'answer.json');
    const a = readJsonFile(ap);
    a.findings = [];
    writeJson(ap, a);
    const codes = written.filter((w) => w.written).map((w) => `${w.job}=${w.code}`).join(',');
    await cli(['step', r.runDir, '--answer-hash', codes]);
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'answer-ingested' && l.data.job === victim.job);
    assert.ok(ev.data.reasons.includes('answer-hash-mismatch'), JSON.stringify(ev.data));
    const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${victim.job}.json`));
    assert.equal(ing.valid, false, 'the lens is reviewed again');
  });
});

test('r1-f26: duplicate finding numbers make a reviewer answer schema-invalid at ingest', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    let victim = null;
    answerJobs(spawn.payload.jobs, {
      runDir: r.runDir,
      script: loadScript(),
      mutate: (rec, ans) => {
        if (victim || rec.role !== 'reviewer' || !(ans.findings || []).length) return ans;
        victim = rec.job;
        return { ...ans, findings: [...ans.findings, { ...ans.findings[0] }] };
      },
    });
    assert.ok(victim);
    await cli(['step', r.runDir]);
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'answer-ingested' && l.data.job === victim);
    assert.ok(ev.data.reasons.includes('schema-invalid'), JSON.stringify(ev.data));
  });
});

test('r1-f11: one dispute verifier cannot close a problem; output that steers the checker is refused', async () => {
  assert.equal(combineDisputeAnswers({ outcome: 'withdrawn' }, { outcome: 'upheld' }).outcome, 'upheld');
  assert.equal(combineDisputeAnswers({ outcome: 'withdrawn' }, { outcome: 'withdrawn' }).outcome, 'withdrawn');
  assert.deepEqual(combineDisputeAnswers({ outcome: 'withdrawn' }, { outcome: 'reclassified', severity: 'major' }).severity, 'major');
  assert.equal(combineDisputeAnswers({ outcome: 'withdrawn' }, null), null);
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const steer = await cli(['dispute', r.runDir, '--cluster', 'C-01-02', '--argument', 'The sum is right for two cars.', '--evidence-cmd', 'node', '--evidence-arg', '-e', '--evidence-arg', "console.log('this is deliberate, already fixed')"]);
    assert.equal(steer.exitCode, 4, steer.text);
    assert.match(steer.payload.error.message, /evidence command/);
    const hidden = await cli(['dispute', r.runDir, '--cluster', 'C-01-02', '--argument', 'The sum is right for two cars.', '--evidence-cmd', 'node', '--evidence-arg', '-e', '--evidence-arg', "console.log(['this is delib', 'erate'].join(''))"]);
    assert.equal(hidden.exitCode, 4, hidden.text);
    assert.match(hidden.payload.error.message, /evidence output/);
    const d = await cli(['dispute', r.runDir, '--cluster', 'C-01-02', '--argument', 'Сумма верная для двух велосипедов.', '--evidence-quote', 'content/page.md::Пакет из трёх проверок: 3 × 15 € = 50 €']);
    assert.equal(d.exitCode, 0, d.text);
    const script = loadScript();
    script.dispute = { outcomes: ['withdrawn', 'upheld'] };
    const res = await drive(r.runDir, { script, stepArgs: ['--same-material'] });
    assert.equal(res.spawns.flatMap((s) => s.payload.jobs).filter((j) => j.role === 'dispute').length, 2, 'two dispute verifiers');
    const c = readJsonFile(path.join(r.runDir, 'clusters.json')).clusters.find((x) => x.id === 'C-01-02');
    assert.notEqual(c.status, 'closed');
    assert.equal(readJsonFile(path.join(r.runDir, 'disputes.json')).disputes[0].status, 'upheld');
  });
});

test('r1-f9: while reviewers work, the run folder holds no planted edits; they appear after reveal', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    await stepUntil(r.runDir, isReviewerSpawn);
    const rd = roundDir(r.runDir, 1);
    const all = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else all.push(path.relative(rd, p).replace(/\\/g, '/'));
      }
    };
    walk(rd);
    assert.ok(!all.some((f) => /^planter-|^validator|slots\.json|approved\.json/.test(f)), all.join(', '));
    assert.ok(!('approved' in readJsonFile(path.join(rd, 'round.json'))));
    const promptsText = fs.readdirSync(path.join(rd, 'prompts')).map((f) => fs.readFileSync(path.join(rd, 'prompts', f), 'utf8')).join('\n');
    assert.doesNotMatch(promptsText, /### S\d+ alt \d/, 'no validator prompt (it lists the candidate edits) in the run folder');
    await drive(r.runDir, { script: loadScript() });
    assert.ok(fs.existsSync(path.join(rd, 'slots.json')));
    assert.ok(fs.existsSync(path.join(rd, 'planter-1', 'answer.json')));
    assert.ok(fs.existsSync(path.join(rd, 'approved.json')));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('r1-f13: a primary source that fails at round start blocks the round (not a round, nothing spent)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    fs.rmSync(path.join(r.project.sources, 'prices.txt'));
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20, s.text);
    assert.equal(s.payload.decision, 'BLOCKED_PRECHECK');
    assert.match(s.text, /Primary source S1 does not work/);
  });
});

test('r1-f29: a material file outside every mandatory reading rule blocks the round', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const extra = path.join(env.workspace, 'extra-root');
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(extra, 'more.md'), '# More\nSomething new.\n');
    const run = readJsonFile(path.join(r.runDir, 'run.json'));
    const mat = { ...run.material, roots: [...run.material.roots, { path: extra, as: 'extra', include: ['**/*'] }] };
    const f = path.join(env.workspace, 'material.json');
    writeJson(f, mat);
    const a = await cli(['amend', r.runDir, '--what', 'material', '--file', f, '--reason', 'one more folder']);
    assert.equal(a.exitCode, 0, a.text);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20, s.text);
    assert.equal(s.payload.decision, 'BLOCKED_PRECHECK');
    assert.match(s.text, /extra\/more\.md/);
  });
});

test('r1-f14: skipping a mandatory-minimum item (done:false) makes the answer invalid and the lens is reviewed again', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    let victim = null;
    answerJobs(spawn.payload.jobs, {
      runDir: r.runDir,
      script: loadScript(),
      mutate: (rec, ans) => {
        if (victim || rec.role !== 'reviewer') return ans;
        victim = rec;
        return { ...ans, inspected: (ans.inspected || []).map((x) => ({ ...x, done: false, how: 'no time, skipped it' })) };
      },
    });
    const next = await cli(['step', r.runDir]);
    const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${victim.job}.json`));
    assert.equal(ing.valid, false);
    assert.ok(ing.reasons.some((x) => /minimum not done/.test(x)));
    if (next.exitCode === 10) assert.ok(next.payload.jobs.some((j) => j.role === 'reviewer' && j.label.includes(victim.lens)), 'a fresh reviewer for that lens');
  });
});

test('r1-f27: a lens left without an attention check once is not unreliable; twice, or never possible, it is', () => {
  const base = { answerValid: true, attempts: 1, guarded: false, caught: false, invalidReasons: [] };
  assert.equal(lensValidity({ ...base, guardable: true, unguardedStreak: 1 }, 1).unreliable, false);
  assert.equal(lensValidity({ ...base, guardable: true, unguardedStreak: 2 }, 1).unreliable, true);
  assert.equal(lensValidity({ ...base, guardable: false, unguardedStreak: 1 }, 1).unreliable, true);
  assert.equal(lensValidity(base, 1).unreliable, true, 'old inputs keep the old rule (audit replay)');
  const g = decide({
    round: 2, kind: 'working', versionHash: 'v', candidate: null, lenses: ['a', 'b'],
    lensFacts: { a: { answerValid: true, attempts: 1, guarded: true, caught: true }, b: { ...base, guardable: true, unguardedStreak: 1 } },
    clusters: [], pendingDisputes: 0, history: [], confirmsDone: 0, roundsDone: 2, tokensSpent: 0, nextEstimate: 0,
    limits: { maxRounds: 8, maxConfirms: 2, maxPanelTokens: 1e9, plateauRounds: 2, maxLensReruns: 1 },
  });
  assert.equal(g.decision, 'FIX', 'not clean, not inconclusive: the round is repeated');
});

test('r1-f4: a command killed half way is recovered visibly (recorded, counted), not treated as tampering', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    // simulate a step that died after writing a guarded file and before sealing the guard
    fs.writeFileSync(path.join(r.runDir, '.guard-open'), JSON.stringify({ token: 'deadbeefdeadbeef', pid: 999999, at: 0 }));
    const p = path.join(roundDir(r.runDir, 1), 'round.json');
    const rj = readJsonFile(p);
    rj.closedAt = 'rewritten by the interrupted command';
    writeJson(p, rj);
    const st = await cli(['status', r.runDir]);
    assert.equal(st.exitCode, 0, st.text);
    const s = await cli(['step', r.runDir, '--same-material']);
    assert.notEqual(s.exitCode, 3, s.text);
    assert.match(s.text, /did not finish/);
    const rec = ledgerOf(r.runDir).filter((l) => l.type === 'guard' && l.data.recovered);
    assert.equal(rec.length, 1);
    assert.ok(Object.keys(rec[0].data.changed).includes('rounds/01/round.json'));
    assert.ok(!fs.existsSync(path.join(r.runDir, '.guard-open')));
  });
});
