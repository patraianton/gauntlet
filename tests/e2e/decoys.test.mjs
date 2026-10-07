// Decoys end to end with fake agents (SPEC 14.11): false findings are mixed into the verifier batches,
// stay sealed until the round closes, never become clusters, and a verifier that accepts one is not
// trusted. The decoy writer and the verifiers are scripted (lib/selftest/fake-agents.mjs).
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

test('decoys: a writer works beside the reviewers; its key stays sealed while the verifiers work and is revealed at close', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    assert.equal(spawn.payload.jobs.filter((j) => j.role === 'decoy').length, 1, 'one decoy writer beside the reviewers');
    assert.ok(spawn.payload.jobs.filter((j) => j.role === 'reviewer').length >= 3);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    // run until the verifiers are asked: the decoys are mixed in and still sealed
    const vs = await stepUntil(r.runDir, isVerifierSpawn);
    const rd = roundDir(r.runDir, 1);
    const stage = stageOf(env, r.runDir);
    assert.ok(fs.existsSync(path.join(stage, 'decoys.json')), 'the key is sealed in the data home');
    assert.ok(fs.existsSync(path.join(stage, 'decoy-mix.json')));
    for (const f of ['decoys.json', 'decoy-mix.json', 'decoy-results.json', 'decoy-writer']) assert.equal(fs.existsSync(path.join(rd, f)), false, `${f} is not in the run folder yet`);
    const key = readJsonFile(path.join(stage, 'decoys.json'));
    const round = readJsonFile(path.join(rd, 'round.json'));
    assert.equal(round.decoyCommitment, hashJson(key), 'the run folder holds the commitment, not the key');
    assert.ok(key.decoys.length >= 2);
    // the run folder never mentions a decoy's words before the reveal
    const ledgerText = fs.readFileSync(path.join(r.runDir, 'ledger.jsonl'), 'utf8');
    const folderText = ['verify-items.json', 'jobs.json', 'round.json'].map((f) => fs.readFileSync(path.join(rd, f), 'utf8')).join('\n') + ledgerText;
    assert.equal(/decoy-mix|decoys\.json/.test(ledgerText), false);
    // the verifier items: a decoy has the same shape as a real one and a cluster-like id that is no cluster
    const vi = readJsonFile(path.join(rd, 'verify-items.json'));
    const clusterIds = new Set(clustersOf(r.runDir).map((c) => c.id));
    const alien = vi.items.filter((i) => !clusterIds.has(i.cluster));
    // the true controls (SPEC 14.12) are items that are no cluster either; the decoys are the others
    const controlMix = jsonIf(path.join(stage, 'control-mix.json'), { items: [] });
    assert.ok(alien.length >= 2 && alien.length === readJsonFile(path.join(stage, 'decoy-mix.json')).items.length + controlMix.items.length);
    assert.equal(new Set(vi.items.map((i) => Object.keys(i).sort().join(','))).size, 1, 'the same fields for every item');
    for (const i of alien) assert.match(i.cluster, /^C-01-\d+$/);
    assert.deepEqual(vi.verify.filter((id) => alien.some((a) => a.cluster === id)), [], 'verify lists real clusters only');
    // the decoys' proofs are in the key only
    assert.ok(key.decoys.every((d) => d.proofQuote && !folderText.includes(d.whyFalse)));

    answerJobs(vs.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const end = await drive(r.runDir, { script: loadScript() });
    assert.equal(end.last.exitCode, 20, end.last.text);
    // revealed at close, and equal to the commitment
    assert.equal(fs.existsSync(stage), false, 'the sealed stage is gone');
    const revealed = readJsonFile(path.join(rd, 'decoys.json'));
    assert.equal(hashJson(revealed), round.decoyCommitment);
    const results = readJsonFile(path.join(rd, 'decoy-results.json'));
    assert.ok(results.results.length >= 2 && results.results.every((x) => x.outcome === 'rejected'));
    assert.deepEqual(results.tainted, []);
    assert.ok(ledgerOf(r.runDir).some((l) => l.type === 'decoy-reveal' && l.round === 1 && l.data.commitment === round.decoyCommitment));
    // never a cluster, never in the to-do list
    const clusters = clustersOf(r.runDir);
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    for (const d of revealed.decoys) {
      assert.equal(todo.includes(d.claim), false);
      assert.equal(clusters.some((c) => c.problem === d.claim || (d.quote && c.quote === d.quote && c.problem === d.claim)), false);
    }
    for (const x of readJsonFile(path.join(rd, 'decoy-mix.json')).items) assert.equal(clusters.some((c) => c.id === x.cluster), false);
    // the real result of the round is what it was without decoys
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    assert.equal(openOf(r.runDir).length, 3);
    // the audit knows the check
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
    assert.ok(audit.payload.checks.some((c) => c.id === 'decoys' && c.ok));
  });
});

test('decoys: the verdicts go to the cross-run ledger (rejected / shown) and the report says it in plain Russian', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const rows = fs.readFileSync(path.join(env.dataHome, 'measurements', 'decoys.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'decoy-results.json')).results;
    assert.equal(rows.length, res.length);
    assert.ok(rows.every((x) => x.outcome === 'rejected' && x.round === 1 && x.contaminated === false && x.batchTainted === false));
    const stats = await cli(['ledger', 'stats']);
    assert.equal(stats.exitCode, 0, stats.text);
    assert.match(stats.text, /decoys rejected: \d+\/\d+/);
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, new RegExp(`Перепроверка отклонила ${res.length} из ${res.length} заведомо ложных замечаний`));
    assert.match(md, /Заведомо ложных замечаний на перепроверку показано пока мало/);
    // no jargon in the lines about decoys
    const lines = md.split('\n').filter((l) => /заведомо ложн/.test(l)).join('\n');
    assert.equal(/[A-Za-z]{3,}/.test(lines), false, lines);
  });
});

/** A pass-1 verifier that says «confirmed, major» to every real item it is shown (a lenient one). */
const lenientFirstPass = (rec, answer) => {
  if (rec.role !== 'verifier' || rec.verifierPass !== 1) return answer;
  return { ...answer, items: answer.items.map((it) => (it.verdict === 'confirmed' ? it : { ...it, verdict: 'confirmed', severity: 'major', evidence: 'Подтверждаю, так и есть.' })) };
};

test('decoys: a verifier that confirms a decoy is not trusted; its other confirmations are re-checked by a fresh verifier, whose word counts', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.decoy = { confirm: { passes: [1] } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script, mutate: lenientFirstPass });
    assert.equal(d.last.exitCode, 20, d.last.text);
    // a second wave of verifiers: fresh ones (pass 3) for what the lenient ones confirmed
    const waves = d.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    assert.equal(waves.length, 2, JSON.stringify(waves.map((w) => w.payload.jobs.map((j) => j.role))));
    const jobs = readJsonFile(path.join(roundDir(r.runDir, 1), 'jobs.json')).jobs;
    assert.ok(jobs.some((j) => j.role === 'verifier' && j.verifierPass === 3), 'fresh verifiers re-check');
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'decoy-confirmed' && l.round === 1);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.wave, 1);
    assert.ok(ev[0].data.untrustedItems >= 3);
    // the invented quote is dropped by the fresh verifier: the lenient «confirmed» was never applied
    const c = clustersOf(r.runDir).find((x) => /70%/.test(x.quote || ''));
    assert.equal(c.status, 'dropped');
    assert.ok(c.evidence.every((e) => jobs.find((j) => j.job === e.job)?.verifierPass !== 1), 'the lenient verdicts are not in the cluster');
    // the real open problems are what the honest verifiers say
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    assert.equal(openOf(r.runDir).length, 3);
    // what happened is on the record, with the first-wave decoys counted as accepted
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'decoy-results.json'));
    assert.ok(res.results.some((x) => x.wave === 1 && x.outcome === 'confirmed'));
    assert.ok(res.results.some((x) => x.wave === 2 && x.outcome === 'rejected'), 'the fresh verifiers were tested too');
    assert.ok(res.tainted.length >= 1 && res.tainted.every((t) => t.wave === 1 && t.reverify === true));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
    // the report and the summary say so
    await cli(['report', r.runDir]);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Перепроверка приняла за настоящие \d+ заведомо ложн/);
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => /^Перепроверка приняла за настоящие заведомо ложные замечания: \d+ из \d+/.test(l)), sum.text);
  });
});

test('decoys: when the fresh verifier accepts a decoy too, what it confirmed stays unverified (no third wave) and is never an open fact', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.decoy = { confirm: { passes: [1, 3] } };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script, mutate: lenientFirstPass });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const waves = d.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    assert.equal(waves.length, 2, 'no third wave');
    const c = clustersOf(r.runDir);
    const sum = c.find((x) => /50 €/.test(x.quote || ''));
    assert.equal(sum.status, 'unverified', 'confirmed only by untrusted verifiers');
    assert.equal(c.find((x) => /70%/.test(x.quote || '')).status, 'dropped');
    const res = readJsonFile(path.join(roundDir(r.runDir, 1), 'decoy-results.json'));
    assert.ok(res.tainted.some((t) => t.wave === 2 && t.reverify === false));
    // unverified serious problems still count as open for the gate: the round does not look clean
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('decoys in a confirm round: in both passes; a tainted verifier is replaced for its slot only', async () => {
  await withEnv(async (env) => {
    const r = await doneRun(env).catch(() => null);
    assert.ok(r, 'the plain flow reaches DONE with decoys in every round');
    const vi3 = readJsonFile(path.join(roundDir(r.runDir, 3), 'verify-items.json'));
    const mix = readJsonFile(path.join(roundDir(r.runDir, 3), 'decoy-mix.json'));
    for (const p of [1, 2]) assert.ok(mix.items.filter((x) => x.pass === p).length >= 1, `decoys in pass ${p}`);
    assert.equal(vi3.kind, 'confirm');
    const results = readJsonFile(path.join(roundDir(r.runDir, 3), 'decoy-results.json')).results;
    assert.ok(results.every((x) => x.outcome === 'rejected'));
    assert.deepEqual(new Set(results.map((x) => x.pass)), new Set([1, 2]));
  });
  await withEnv(async (env) => {
    const script = loadScript();
    script.decoy = { confirm: { rounds: [3], passes: [1] } };
    const r = await fixRun(env);
    applyFix(r.project);
    await drive(r.runDir, { script });
    const d3 = await drive(r.runDir, { script });
    assert.equal(d3.last.exitCode, 20, d3.last.text);
    const waves = d3.spawns.filter((s) => s.payload.jobs.some((j) => j.role === 'verifier'));
    assert.equal(waves.length, 2, 'a second wave in the confirm round');
    const jobs = readJsonFile(path.join(roundDir(r.runDir, 3), 'jobs.json')).jobs;
    assert.ok(jobs.some((j) => j.role === 'verifier' && j.verifierPass === 3), 'the pass-1 slot was re-checked');
    assert.equal(jobs.some((j) => j.role === 'verifier' && j.verifierPass === 4), false, 'the untainted pass-2 slot kept its verdict');
    // the blind round is still clean: nothing was left open by the replacement
    assert.equal(gateOf(r.runDir, 3).decision, 'DONE');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('decoys: a lost decoy writer means no decoys in that round; the round goes on and the report says so', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script, skip: (rec) => rec.role === 'decoy' });
    const gave = await cli(['step', r.runDir, '--give-up', 'missing']);
    assert.ok([10, 20].includes(gave.exitCode), gave.text);
    const d = await drive(r.runDir, { script });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const rd = roundDir(r.runDir, 1);
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'decoys-ingested');
    assert.equal(ev.data.ok, false);
    assert.equal(fs.existsSync(path.join(rd, 'decoys.json')), false);
    const vi = readJsonFile(path.join(rd, 'verify-items.json'));
    const controlIds = new Set(readJsonFile(path.join(rd, 'control-mix.json')).items.map((x) => x.cluster));
    assert.deepEqual(new Set(vi.items.map((i) => i.cluster).filter((id) => !controlIds.has(id))), new Set(vi.verify), 'only real items (and true controls) were verified');
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    await cli(['report', r.runDir]);
    assert.match(fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8'), /ни разу не получилось подмешать/);
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('decoys: a writer that sends only unusable proposals (a quote that is not in the file, no proof) gives no decoys', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.decoyWriter = {
      decoys: script.decoyWriter.decoys.map((d) => ({ ...d, proofQuote: 'a proof that is nowhere in the work at all' })),
    };
    const r = await readyRun(env);
    const d = await drive(r.runDir, { script });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'decoys-ingested');
    assert.equal(ev.data.chosen, 0);
    assert.ok(ev.data.rejected >= 1);
    assert.equal(fs.existsSync(path.join(roundDir(r.runDir, 1), 'decoys.json')), false);
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
  });
});

test('decoys: the sealed key altered after its commitment -> exit 3 at the reveal', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const vs = await stepUntil(r.runDir, isVerifierSpawn);
    const keyPath = path.join(stageOf(env, r.runDir), 'decoys.json');
    const key = readJsonFile(keyPath);
    key.decoys[0].claim = 'changed after the commitment so that it reads like a real defect in the work';
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    answerJobs(vs.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 3, s.text);
    assert.equal(s.payload.error.code, 'COMMITMENT_MISMATCH');
  });
});

test('decoys: an abort while the verifiers are out reveals the key as evidence; the audit still passes', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    await stepUntil(r.runDir, isVerifierSpawn);
    assert.ok(fs.existsSync(path.join(stageOf(env, r.runDir), 'decoys.json')));
    const ab = await cli(['abort', r.runDir, '--reason', 'owner changed the plan', '--owner-quote', 'останови, план меняется', '--question', 'Остановить запуск, пока проверяющие ещё работают?']);
    assert.equal(ab.exitCode, 0, ab.text);
    assert.equal(fs.existsSync(stageOf(env, r.runDir)), false);
    assert.ok(fs.existsSync(path.join(roundDir(r.runDir, 1), 'decoys.json')));
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('decoys: switched off by the run settings only with the owner\'s words; then no writer is asked and the report is silent about them', async () => {
  await withEnv(async (env) => {
    const edit = (x, quote) => {
      const p = path.join(x.runDir, 'run.json');
      const run = readJsonFile(p);
      run.canaries = { ...run.canaries, decoysPerRound: 0 };
      if (quote) run.limitsOptIn = { approvedBy: 'owner', quote, question: 'Что именно вы разрешаете?', date: '2026-10-07' };
      fs.writeFileSync(p, JSON.stringify(run, null, 2));
    };
    // without the owner's words the freeze is refused
    const bad = await readyRun(env, { beforeSetup: (x) => edit(x, null) }).then(() => null, (e) => e);
    assert.ok(bad && /limitsOptIn|looser|setup did not freeze/i.test(String(bad.message)), String(bad && bad.message));
    const r = await readyRun(env, { name: 'off', beforeSetup: (x) => edit(x, 'не надо ложных замечаний, это мешает') });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.equal(d.spawns.some((s) => s.payload.jobs.some((j) => j.role === 'decoy')), false);
    assert.equal(ledgerOf(r.runDir).some((l) => l.type === 'decoys-ingested'), false);
    await cli(['report', r.runDir]);
    assert.equal(/заведомо ложн/.test(fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8').replace(/Пределы шире[^\n]*|заведомо ложных замечаний в круге[^\n]*/g, '')), false);
    const sumTxt = fs.readFileSync(path.join(r.runDir, 'SETUP-SUMMARY.ru.md'), 'utf8');
    assert.match(sumTxt, /заведомо ложных замечаний в круге 0 \(обычно 8\)/);
  });
});

test('decoysActive: never in a bench run, never with the setting at 0, only when the run has the writer\'s template', async () => {
  const { decoysActive } = await import('../../lib/engine/decoy-run.mjs');
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'pl-old-'));
  try {
    const rc = (has) => ({ run: { canaries: { decoysPerRound: 8 } }, paths: { templatesDir: has ? dir : path.join(dir, 'none') } });
    fs.writeFileSync(path.join(dir, 'decoy-writer.md'), 'x');
    assert.equal(decoysActive(rc(true)), true);
    assert.equal(decoysActive(rc(false)), false);
    assert.equal(decoysActive({ run: { canaries: { decoysPerRound: 8, fixedKey: { path: 'x' } } }, paths: { templatesDir: dir } }), false);
    assert.equal(decoysActive({ run: { canaries: { decoysPerRound: 0 } }, paths: { templatesDir: dir } }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
