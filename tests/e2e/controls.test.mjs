// True controls end to end with fake agents (SPEC 14.12): reviewer findings that were matched to planted
// errors are mixed into the verifier batches as ordinary-looking items, stay sealed until the round closes,
// never become clusters, and a verifier that refutes or plays one down is not trusted for its refutations.
// The reviewers and the verifiers are scripted (lib/selftest/fake-agents.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hashJson } from '../../lib/core/hash.mjs';
import {
  withEnv,
  readyRun,
  fixRun,
  doneRun,
  cli,
  drive,
  stepUntil,
  isReviewerSpawn,
  answerJobs,
  applyFix,
  loadScript,
  roundDir,
  readJsonFile,
  ledgerOf,
  gateOf,
  clustersOf,
  openOf,
} from '../fixtures/engine/helpers.mjs';

const isVerifierSpawn = (e) => e.exitCode === 10 && e.payload.jobs.some((j) => j.role === 'verifier');
const runIdOf = (runDir) => readJsonFile(path.join(runDir, 'run.json')).runId;
const stageOf = (env, runDir, n = 1) => path.join(env.dataHome, 'sealed', runIdOf(runDir), `${String(n).padStart(2, '0')}-decoy-stage`);
const jsonIf = (p, d = null) => (fs.existsSync(p) ? readJsonFile(p) : d);

/** A pass-1 verifier that refutes every real item it is shown (one that acquits everything). */
const refuteFirstPass = (rec, answer) => {
  if (rec.role !== 'verifier' || rec.verifierPass !== 1) return answer;
  // (what the script has such a verifier say about a planted problem - a refutation or a cosmetic confirmation - is left as it is)
  return { ...answer, items: answer.items.map((it) => (it.verdict === 'refuted' || it.severity === 'cosmetic' ? it : { item: it.item, verdict: 'refuted', severity: null, evidence: 'Проверил место: замечание неверно.' })) };
};

test('controls: sealed with a commitment before the verifiers are asked, ordinary-looking, revealed at close, never a cluster', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const vs = await stepUntil(r.runDir, isVerifierSpawn);
    const rd = roundDir(r.runDir, 1);
    const stage = stageOf(env, r.runDir);
    // sealed in the data home; the run folder holds only the commitment
    assert.ok(fs.existsSync(path.join(stage, 'controls.json')));
    assert.ok(fs.existsSync(path.join(stage, 'control-mix.json')));
    for (const f of ['controls.json', 'control-mix.json', 'control-results.json']) assert.equal(fs.existsSync(path.join(rd, f)), false, `${f} is not in the run folder yet`);
    const key = readJsonFile(path.join(stage, 'controls.json'));
    const round = readJsonFile(path.join(rd, 'round.json'));
    assert.equal(round.controlCommitment, hashJson(key));
    assert.ok(key.controls.length >= 2, 'one control per planted error that was found');
    // the commitment is in the ledger before the first verifier job was issued
    const led = ledgerOf(r.runDir);
    const sealed = led.find((l) => l.type === 'controls-sealed' && l.round === 1);
    assert.equal(sealed.data.commitment, round.controlCommitment);
    const firstVerifier = led.find((l) => l.type === 'job-issued' && l.round === 1 && l.data?.role === 'verifier');
    assert.ok(sealed.seq < firstVerifier.seq);
    assert.equal(/controls\.json|control-mix/.test(JSON.stringify(led)), false, 'the ledger never names the sealed files');
    // every control is a real, planted defect: its planted class is major or blocker, it was found at that class
    for (const k of key.controls) {
      assert.match(k.control, /^K\d+$/);
      assert.ok(['blocker', 'major'].includes(k.plantedSeverity));
      assert.ok(k.claim.length > 10 && k.shown.length > 0);
    }
    // the verifier items: a control has the same shape as a real one and an id that is no cluster
    const vi = readJsonFile(path.join(rd, 'verify-items.json'));
    const clusterIds = new Set(clustersOf(r.runDir).map((c) => c.id));
    const mix = readJsonFile(path.join(stage, 'control-mix.json'));
    assert.ok(mix.items.length >= 1);
    const controlIds = new Set(mix.items.map((x) => x.cluster));
    for (const id of controlIds) {
      assert.equal(clusterIds.has(id), false);
      assert.match(id, /^C-01-\d+$/);
    }
    assert.equal(new Set(vi.items.map((i) => Object.keys(i).sort().join(','))).size, 1, 'the same fields for every item');
    const decoyMix = readJsonFile(path.join(stage, 'decoy-mix.json'));
    const decoyIds = new Set(decoyMix.items.map((x) => x.cluster));
    for (const id of controlIds) assert.equal(decoyIds.has(id), false, 'a control and a decoy never share an id');
    assert.deepEqual(vi.verify.filter((id) => controlIds.has(id)), [], 'verify lists real clusters only');
    // the controls are not told apart from real items in the words a verifier sees
    const controlItems = vi.items.filter((i) => controlIds.has(i.cluster));
    for (const i of controlItems) assert.ok(!/planted|подлож|control|контрол|canary/i.test(`${i.shown} ${i.claim} ${i.locator}`), `${i.item}: ${i.claim}`);

    answerJobs(vs.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const end = await drive(r.runDir, { script: loadScript() });
    assert.equal(end.last.exitCode, 20, end.last.text);
    // revealed at close, equal to the commitment
    assert.equal(fs.existsSync(stage), false, 'the sealed stage is gone');
    const revealed = readJsonFile(path.join(rd, 'controls.json'));
    assert.equal(hashJson(revealed), round.controlCommitment);
    const results = readJsonFile(path.join(rd, 'control-results.json'));
    assert.ok(results.results.length >= 1 && results.results.every((x) => x.outcome === 'kept'), JSON.stringify(results.results.map((x) => x.outcome)));
    assert.deepEqual(results.tainted, []);
    // never a cluster, never in the to-do list, never an open problem
    const clusters = clustersOf(r.runDir);
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    for (const k of revealed.controls) {
      assert.equal(todo.includes(k.claim), false);
      assert.equal(clusters.some((c) => c.problem === k.claim), false);
    }
    for (const x of readJsonFile(path.join(rd, 'control-mix.json')).items) assert.equal(clusters.some((c) => c.id === x.cluster), false);
    // the real result of the round is what it was without controls
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    assert.equal(openOf(r.runDir).length, 3);
    // the audit knows the check
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
    assert.ok(audit.payload.checks.some((c) => c.id === 'controls' && c.ok));
  });
});

test('controls: the verdicts go to the cross-run ledger and the report says in plain Russian how many real problems were dismissed', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const rows = fs.readFileSync(path.join(env.dataHome, 'measurements', 'controls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'control-results.json')).results;
    assert.equal(rows.length, res.length);
    assert.ok(rows.every((x) => x.outcome === 'kept' && x.round === 1 && x.contaminated === false && x.batchTainted === false && /^K\d+$/.test(x.control) && /^S?\w+/.test(String(x.canary))));
    const stats = await cli(['ledger', 'stats']);
    assert.equal(stats.exitCode, 0, stats.text);
    assert.match(stats.text, /true controls dismissed: 0\/\d+/);
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, new RegExp(`Показано ${res.length} (раз|раза)\\. Ошибочно отвергнуто: 0\\. Признано менее серьёзными, чем они есть: 0\\.`));
    // no jargon in the lines about controls
    const lines = md.split('\n').filter((l) => /настоящие проблемы, про которые|Настоящих известных проблем/.test(l)).join('\n');
    assert.ok(lines.length > 0);
    assert.equal(/[A-Za-z]{3,}/.test(lines), false, lines);
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.equal(sum.payload.summaryRu.some((l) => /настоящие проблемы, о которых мы почти наверняка знали/.test(l)), false, 'silent in the summary when nothing was dismissed');
  });
});

test('controls: a verifier that refutes a real planted problem is untrusted for its refutations; a fresh verifier re-checks them and its word counts', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { passes: [1], mode: 'refute' } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script, mutate: refuteFirstPass });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const waves = d.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    assert.equal(waves.length, 2, JSON.stringify(waves.map((w) => w.payload.jobs.map((j) => j.role))));
    const jobs = readJsonFile(path.join(roundDir(r.runDir, 1), 'jobs.json')).jobs;
    assert.ok(jobs.some((j) => j.role === 'verifier' && j.verifierPass === 3), 'fresh verifiers re-check');
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'control-dismissed' && l.round === 1);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.wave, 1);
    assert.ok(ev[0].data.untrustedItems >= 3);
    // the acquittal of the first verifiers was never applied: the real problems are open
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    assert.equal(openOf(r.runDir).length, 3);
    const clusters = clustersOf(r.runDir);
    assert.ok(clusters.every((c) => (c.evidence || []).every((e) => jobs.find((j) => j.job === e.job)?.verifierPass !== 1)), 'no verdict of an untrusted verifier is in a cluster');
    // what happened is on the record
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'control-results.json'));
    assert.ok(res.results.some((x) => x.wave === 1 && x.outcome === 'dismissed'));
    assert.ok(res.results.some((x) => x.wave === 2 && x.outcome === 'kept'), 'the fresh verifiers were tested too');
    assert.ok(res.tainted.length >= 1 && res.tainted.every((t) => t.wave === 1 && t.reverify === true && t.controls.length >= 1));
    const rows = fs.readFileSync(path.join(env.dataHome, 'measurements', 'controls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((x) => x.outcome === 'dismissed' && x.batchTainted === true));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
    // the report and the summary say it in plain Russian
    await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    const dismissed = res.results.filter((x) => x.outcome === 'dismissed').length;
    const shown = res.results.length;
    assert.match(md, new RegExp(`Показано ${shown} (раз|раза)\\. Ошибочно отвергнуто: ${dismissed}\\.`));
    assert.match(md, /Агент, который отверг или занизил такую проблему, на веру не принят/);
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => new RegExp(`^Перепроверка ошибочно отвергла или занизила настоящие проблемы, о которых мы почти наверняка знали: ${dismissed} из ${shown}`).test(l)), sum.text);
  });
});

test('controls: a verifier that confirms a planted problem below its planted class is untrusted too', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { passes: [1], mode: 'downgrade' } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script, mutate: refuteFirstPass });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'control-results.json'));
    assert.ok(res.results.some((x) => x.wave === 1 && x.outcome === 'downgraded' && x.severity === 'cosmetic'));
    assert.ok(!res.results.some((x) => x.outcome === 'dismissed'));
    assert.equal(openOf(r.runDir).length, 3, 'the refutations of the untrusted verifier were re-checked');
    await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Ошибочно отвергнуто: 0\. Признано менее серьёзными, чем они есть: [1-9]/);
  });
});

test('controls: a verifier that plays a planted problem down keeps its confirmations that leave the classes alone', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { passes: [1], mode: 'downgrade' } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.equal(openOf(r.runDir).length, 3);
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'control-results.json'));
    assert.ok(res.tainted.length >= 1);
    // an honest confirmation of a real item stands: only the one item the script calls cosmetic goes to a fresh verifier
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'control-dismissed' && l.round === 1);
    assert.equal(ev.length, 1);
    assert.ok(ev[0].data.untrustedItems <= 1, `untrusted: ${ev[0].data.untrustedItems}`);
  });
});

test('controls: a lazy verifier that calls everything cosmetic and so fails a control does not acquit the real problems (SPEC 14.12)', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { passes: [1], mode: 'downgrade' } };
    const r = await readyRun(env);
    // every confirmation of the first pass becomes cosmetic, controls and real items alike
    const lazy = (rec, answer) => {
      if (rec.role !== 'verifier' || rec.verifierPass !== 1) return answer;
      return { ...answer, items: answer.items.map((it) => (it.verdict === 'confirmed' ? { ...it, severity: 'cosmetic' } : it)) };
    };
    const d = await drive(r.runDir, { script, mutate: lazy });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const jobs = readJsonFile(path.join(roundDir(r.runDir, 1), 'jobs.json')).jobs;
    assert.ok(jobs.some((j) => j.role === 'verifier' && j.verifierPass === 3), 'fresh verifiers re-check the played-down items');
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'control-dismissed' && l.round === 1);
    assert.equal(ev.length, 1);
    assert.ok(ev[0].data.untrustedItems >= 3 && ev[0].data.reverify >= 3);
    // the lazy verdicts were never applied: the real problems are open, the round does not look clean
    assert.equal(openOf(r.runDir).length, 3);
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    const clusters = clustersOf(r.runDir);
    assert.ok(clusters.every((c) => (c.evidence || []).every((e) => jobs.find((j) => j.job === e.job)?.verifierPass !== 1)), 'no verdict of the untrusted verifier is in a cluster');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('controls: a control confirmed without a class is undecided, not a downgrade', async () => {
  const { controlOutcome, playsDown } = await import('../../lib/measure/controls.mjs');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: null }, 'major'), 'undecided');
  assert.equal(controlOutcome({ verdict: 'confirmed' }, 'blocker'), 'undecided');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'cosmetic' }, 'major'), 'downgraded');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'major' }, 'major'), 'kept');
  assert.equal(playsDown({ verdict: 'confirmed', severity: 'cosmetic' }, 'major'), true);
  assert.equal(playsDown({ verdict: 'confirmed', severity: 'cosmetic' }, null), true);
  assert.equal(playsDown({ verdict: 'confirmed', severity: 'cosmetic' }, 'cosmetic'), false);
  assert.equal(playsDown({ verdict: 'confirmed', severity: 'major' }, 'blocker'), false);
  assert.equal(playsDown({ verdict: 'refuted', severity: null }, 'major'), false);
});

test('controls: when the fresh verifier acquits a planted problem too, what it refuted stays unverified (no third wave) and is never closed', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { passes: [1, 3], mode: 'refute' } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script, mutate: (rec, answer) => (rec.role === 'verifier' && [1, 3].includes(rec.verifierPass) ? refuteFirstPass({ ...rec, verifierPass: 1 }, answer) : answer) });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const waves = d.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    assert.equal(waves.length, 2, 'no third wave');
    const c = clustersOf(r.runDir);
    for (const x of c.filter((q) => /50 €/.test(q.quote || ''))) assert.equal(x.status, 'unverified', 'acquitted only by untrusted verifiers');
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'control-results.json'));
    assert.ok(res.tainted.some((t) => t.wave === 2 && t.reverify === false));
    // unverified serious problems still count as open for the gate: the round does not look clean
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('controls in a confirm round: in both passes; a tainted verifier is replaced for its slot only', async () => {
  await withEnv(async (env) => {
    const r = await doneRun(env).catch(() => null);
    assert.ok(r, 'the plain flow reaches DONE with controls in every round');
    const mix = readJsonFile(path.join(roundDir(r.runDir, 3), 'control-mix.json'));
    for (const p of [1, 2]) assert.ok(mix.items.filter((x) => x.pass === p).length >= 1, `controls in pass ${p}`);
    const results = readJsonFile(path.join(roundDir(r.runDir, 3), 'control-results.json')).results;
    assert.ok(results.every((x) => x.outcome === 'kept'));
    assert.deepEqual(new Set(results.map((x) => x.pass)), new Set([1, 2]));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
  await withEnv(async (env) => {
    const script = loadScript();
    script.control = { dismiss: { rounds: [3], passes: [1], mode: 'refute' } };
    const r = await fixRun(env);
    applyFix(r.project);
    await drive(r.runDir, { script });
    const d3 = await drive(r.runDir, { script });
    assert.equal(d3.last.exitCode, 20, d3.last.text);
    const waves = d3.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    // nothing real was refuted, but the failed verifier also made a major item cosmetic: that one confirmation is re-checked
    assert.equal(waves.length, 2, 'only the played-down confirmation is re-checked');
    const second = d3.spawns.filter((x) => x.payload.jobs.some((j) => j.role === 'verifier'))[1];
    assert.equal(second.payload.jobs.every((j) => j.role === 'verifier'), true);
    const results = readJsonFile(path.join(roundDir(r.runDir, 3), 'control-results.json'));
    assert.ok(results.results.some((x) => x.pass === 1 && x.outcome === 'dismissed'));
    assert.equal(gateOf(r.runDir, 3).decision, 'DONE', 'the blind round is still clean');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('controls: the sealed key altered after its commitment -> exit 3 at the reveal', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const vs = await stepUntil(r.runDir, isVerifierSpawn);
    const keyPath = path.join(stageOf(env, r.runDir), 'controls.json');
    const key = readJsonFile(keyPath);
    key.controls[0].plantedSeverity = 'cosmetic';
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    answerJobs(vs.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 3, s.text);
    assert.equal(s.payload.error.code, 'COMMITMENT_MISMATCH');
  });
});

test('controls: an abort while the verifiers are out reveals the key as evidence; the audit still passes', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    await stepUntil(r.runDir, isVerifierSpawn);
    assert.ok(fs.existsSync(path.join(stageOf(env, r.runDir), 'controls.json')));
    const ab = await cli(['abort', r.runDir, '--reason', 'owner changed the plan', '--owner-quote', 'останови, план меняется', '--question', 'Остановить запуск, пока проверяющие ещё работают?']);
    assert.equal(ab.exitCode, 0, ab.text);
    assert.equal(fs.existsSync(stageOf(env, r.runDir)), false);
    assert.ok(fs.existsSync(path.join(roundDir(r.runDir, 1), 'controls.json')));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
    assert.ok(audit.payload.checks.some((c) => c.id === 'controls' && c.ok));
  });
});

test('controls: a revealed key edited after the round closed -> the run no longer passes its integrity check (the audit says which file)', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const keyPath = path.join(roundDir(r.runDir, 1), 'controls.json');
    const key = readJsonFile(keyPath);
    key.controls[0].claim = 'edited after the round closed';
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 3);
    const c = audit.payload.checks.find((x) => x.id === 'chain');
    assert.equal(c.ok, false);
    assert.ok(c.details.some((t) => /rounds\/01\/controls\.json/.test(t)), JSON.stringify(c.details));
  });
});

test('controlLedgerProblems: the ledger says controls were sealed but round.json carries no commitment -> a problem (check 13)', async () => {
  const { controlLedgerProblems } = await import('../../lib/engine/control-run.mjs');
  const ev = (seq, type, data = {}) => ({ seq, type, round: 1, data });
  const sealed = [ev(1, 'controls-sealed', { chosen: 2, removedFindings: 3, commitment: 'sha256:aa' })];
  const lost = controlLedgerProblems(1, { decoysRevealed: true, closedAt: 'x' }, sealed);
  assert.equal(lost.length, 1);
  assert.match(lost[0], /2 control\(s\) were sealed, but round\.json carries no control commitment/);
  // none chosen: nothing to commit, nothing wrong; no event at all (older run): nothing wrong either
  assert.deepEqual(controlLedgerProblems(1, {}, [ev(1, 'controls-sealed', { chosen: 0, removedFindings: 0 })]), []);
  assert.deepEqual(controlLedgerProblems(1, {}, []), []);
  // another round's event does not count
  assert.deepEqual(controlLedgerProblems(2, {}, sealed), []);
});

test('controlLedgerProblems: the commitment must come before the first verifier job, the reveal after the last verifier answer', async () => {
  const { controlLedgerProblems } = await import('../../lib/engine/control-run.mjs');
  const round = { controlCommitment: 'sha256:aa', decoysRevealed: true, closedAt: 'x' };
  const ev = (seq, type, data = {}) => ({ seq, type, round: 1, data });
  const good = [ev(1, 'controls-sealed', { commitment: 'sha256:aa' }), ev(2, 'job-issued', { job: 'v1', role: 'verifier' }), ev(3, 'answer-ingested', { job: 'v1', role: 'verifier' }), ev(4, 'decoy-reveal')];
  assert.deepEqual(controlLedgerProblems(1, round, good), []);
  // a verifier was asked before the commitment
  const late = [ev(1, 'job-issued', { job: 'v1', role: 'verifier' }), ev(2, 'controls-sealed', { commitment: 'sha256:aa' }), ev(3, 'answer-ingested', { job: 'v1', role: 'verifier' }), ev(4, 'decoy-reveal')];
  assert.ok(controlLedgerProblems(1, round, late).some((p) => /issued before the controls were committed/.test(p)));
  // revealed before a verifier answer
  const early = [ev(1, 'controls-sealed', { commitment: 'sha256:aa' }), ev(2, 'job-issued', { job: 'v1', role: 'verifier' }), ev(3, 'decoy-reveal'), ev(4, 'answer-ingested', { job: 'v1', role: 'verifier' })];
  assert.ok(controlLedgerProblems(1, round, early).some((p) => /revealed before the answer/.test(p)));
  // a commitment that is not the round's, no event at all, no reveal
  assert.ok(controlLedgerProblems(1, round, [ev(1, 'controls-sealed', { commitment: 'sha256:bb' }), ev(2, 'decoy-reveal')]).some((p) => /differs from the round's/.test(p)));
  assert.ok(controlLedgerProblems(1, round, [ev(1, 'decoy-reveal')]).some((p) => /no controls-sealed event/.test(p)));
  assert.ok(controlLedgerProblems(1, round, [ev(1, 'controls-sealed', { commitment: 'sha256:aa' })]).some((p) => /no reveal event/.test(p)));
  assert.ok(controlLedgerProblems(1, { ...round, decoysRevealed: false }, [ev(1, 'controls-sealed', { commitment: 'sha256:aa' })]).some((p) => /not revealed when the round closed/.test(p)));
});

test('controls: switched off by the run settings only with the owner\'s words; then none are mixed in and the report is silent about them', async () => {
  await withEnv(async (env) => {
    const edit = (x, quote) => {
      const p = path.join(x.runDir, 'run.json');
      const run = readJsonFile(p);
      run.canaries = { ...run.canaries, controlsPerRound: 0 };
      if (quote) run.limitsOptIn = { approvedBy: 'owner', quote, question: 'Что именно вы разрешаете?', date: '2026-10-07' };
      fs.writeFileSync(p, JSON.stringify(run, null, 2));
    };
    const bad = await readyRun(env, { beforeSetup: (x) => edit(x, null) }).then(() => null, (e) => e);
    assert.ok(bad && /limitsOptIn|looser|setup did not freeze/i.test(String(bad.message)), String(bad && bad.message));
    const r = await readyRun(env, { name: 'off', beforeSetup: (x) => edit(x, 'не надо подмешивать настоящие проблемы, это мешает') });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.equal(ledgerOf(r.runDir).some((l) => l.type === 'controls-sealed'), false);
    assert.equal(fs.existsSync(path.join(roundDir(r.runDir, 1), 'controls.json')), false);
    await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8').replace(/Пределы шире[^\n]*|известных настоящих проблем, подмешиваемых к перепроверке, в круге[^\n]*/g, '');
    assert.equal(/настоящие проблемы, про которые мы почти наверняка знаем/.test(md), false);
    const sumTxt = fs.readFileSync(path.join(r.runDir, 'SETUP-SUMMARY.ru.md'), 'utf8');
    assert.match(sumTxt, /известных настоящих проблем, подмешиваемых к перепроверке, в круге 0 \(обычно 4\)/);
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('controls: the setup summary tells the owner in plain Russian that real known problems are mixed in', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const sum = fs.readFileSync(path.join(r.runDir, 'SETUP-SUMMARY.ru.md'), 'utf8');
    assert.match(sum, /подмешиваются и настоящие проблемы, о которых мы почти наверняка знаем \(не больше 4 на круг\)/);
  });
});

test('controlsActive: never in a bench run, never with the setting at 0 or absent', async () => {
  const { controlsActive } = await import('../../lib/engine/control-run.mjs');
  assert.equal(controlsActive({ run: { canaries: { controlsPerRound: 4 } } }), true);
  assert.equal(controlsActive({ run: { canaries: { controlsPerRound: 4, fixedKey: { path: 'x' } } } }), false);
  assert.equal(controlsActive({ run: { canaries: { controlsPerRound: 0 } } }), false);
  assert.equal(controlsActive({ run: { canaries: {} } }), false);
});
