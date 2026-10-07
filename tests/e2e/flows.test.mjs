// End-to-end flows of the step state machine with fake agents: matcher, disputes, waivers, plateau
// and the owner's continue, limits, give-up, the run lock, the --json signature, abort/cleanup,
// restore-best, the owner's stop in the middle of a round, Workflow token totals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical } from '../../lib/core/canon.mjs';
import { sha256 } from '../../lib/core/sha256-pure.js';
import {
  withEnv,
  readyRun,
  fixRun,
  freshRun,
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

test('matcher: a planted-error finding without a distinctive token goes to the matcher and is caught there', async () => {
  await withEnv(async (env) => {
    let runDir = null;
    // Privileged test code: quote only the unchanged start of the planted line, with no changed token.
    const vague = (rec, answer) => {
      if (rec.role !== 'reviewer') return answer;
      const runId = readJsonFile(path.join(runDir, 'run.json')).runId;
      const sealedPath = path.join(env.dataHome, 'sealed', runId, String(rec.round).padStart(2, '0') + '.key.json');
      const key = readJsonFile(fs.existsSync(sealedPath) ? sealedPath : path.join(roundDir(runDir, rec.round), 'canaries.json'));
      const findings = answer.findings.map((f) => {
        const c = key.canaries.find((k) => k.file === f.location.file && k.locator === f.location.locator && f.quote);
        if (!c) return f;
        let p = 0;
        while (p < c.before.length && c.before[p] === c.after[p]) p++;
        const prefix = c.after.slice(0, p).trim();
        if (prefix.length < 8) return f;
        return { ...f, quote: prefix, problem: 'Здесь что-то не так.', fix: 'Проверить.' };
      });
      return { ...answer, findings };
    };
    const r = await readyRun(env);
    runDir = r.runDir;
    const d = await drive(r.runDir, { script: loadScript(), mutate: vague });
    assert.ok(d.spawns.some((s) => s.payload.jobs.some((j) => j.role === 'matcher')), 'a matcher job was spawned');
    const dets = readJsonFile(path.join(roundDir(r.runDir, 1), 'detections.json')).detections;
    assert.ok(dets.some((x) => x.stage === 'matcher' && x.outcome === 'caught'));
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
    assert.equal(openOf(r.runDir).length, 3, 'matched planted-error findings left the real-issue pipeline');
  });
});

test('dispute: a dispute verifier withdraws a cluster in the next round; nobody else can close it', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const d = await cli(['dispute', r.runDir, '--cluster', 'C-01-02', '--argument', 'Сумма в строке верная, это цена для двух велосипедов.', '--evidence-quote', 'content/page.md::Пакет из трёх проверок: 3 × 15 € = 50 €']);
    assert.equal(d.exitCode, 0, d.text);
    const script = loadScript();
    script.dispute = { outcome: 'withdrawn' };
    const res = await drive(r.runDir, { script, stepArgs: ['--same-material'] });
    assert.ok(res.spawns.some((s) => s.payload.jobs.some((j) => j.role === 'dispute')));
    const c = clustersOf(r.runDir).find((x) => x.id === 'C-01-02');
    assert.equal(c.status, 'closed');
    const disp = readJsonFile(path.join(r.runDir, 'disputes.json')).disputes[0];
    assert.equal(disp.status, 'withdrawn');
    assert.equal(gateOf(r.runDir, 2).pendingDisputes, 0);
    assert.equal(openOf(r.runDir).length, 2);
  });
});

test('waive: only with the owner\'s quote; a waived cluster no longer blocks and is listed as the owner\'s decision', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const ready = await cli(['waive', r.runDir, '--cluster', 'C-01-03', '--owner-quote', 'дату в седьмом посте оставь, это другая акция', '--question', 'Вы согласны с этим решением?']);
    assert.equal(ready.exitCode, 4, 'r2-f9: no waiver between rounds, only after a stop report');
    const stop = await cli(['owner', r.runDir, '--kind', 'stop', '--owner-quote', 'стоп, покажи что осталось', '--question', 'Вы согласны с этим решением?']);
    assert.equal(stop.exitCode, 30, stop.text);
    const no = await cli(['waive', r.runDir, '--cluster', 'C-01-03', '--owner-quote', 'ok']);
    assert.equal(no.exitCode, 4);
    const w = await cli(['waive', r.runDir, '--cluster', 'C-01-03', '--owner-quote', 'дату в седьмом посте оставь, это другая акция', '--question', 'Вы согласны с этим решением?']);
    assert.equal(w.exitCode, 0, w.text);
    const cont = await cli(['owner', r.runDir, '--kind', 'continue', '--owner-quote', 'продолжай без седьмого поста', '--question', 'Вы согласны с этим решением?']);
    assert.equal(cont.exitCode, 0, cont.text);
    await drive(r.runDir, { script: loadScript(), stepArgs: ['--same-material'] });
    const g = gateOf(r.runDir, 2);
    assert.equal(g.open.blocker + g.open.major, 2);
    assert.equal(clustersOf(r.runDir).find((c) => c.id === 'C-01-03').status, 'waived');
    const od = readJsonFile(path.join(r.runDir, 'owner-decisions.json')).decisions;
    assert.ok(od.some((d) => d.kind === 'waive'));
    const sum = await cli(['report', r.runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => /^Ваши исключения: оставлено по вашему слову серьёзных проблем — 1;/.test(l)), sum.text);
  });
});

test('plateau: two rounds without fewer problems -> STOP_PLATEAU; the owner\'s continue restarts the count', async () => {
  await withEnv(async (env) => {
    const script = loadScript();
    script.reviewers['3'] = script.reviewers['2'];
    script.reviewers['4'] = script.reviewers['2'];
    const r = await fixRun(env);
    const d2 = await drive(r.runDir, { script, stepArgs: ['--same-material'] });
    assert.equal(d2.last.exitCode, 20);
    const d3 = await drive(r.runDir, { script, stepArgs: ['--same-material'] });
    assert.equal(d3.last.exitCode, 30, d3.last.text);
    assert.equal(gateOf(r.runDir, 3).decision, 'STOP_PLATEAU');
    assert.ok(fs.existsSync(path.join(r.runDir, 'REPORT.ru.md')));
    const st = await cli(['step', r.runDir]);
    assert.equal(st.exitCode, 30, 'a stopped run stays stopped without the owner');
    const cont = await cli(['owner', r.runDir, '--kind', 'continue', '--owner-quote', 'продолжай, я посмотрю позже', '--question', 'Вы согласны с этим решением?']);
    assert.equal(cont.exitCode, 0, cont.text);
    await drive(r.runDir, { script, stepArgs: ['--same-material'] });
    assert.equal(gateOf(r.runDir, 4).decision, 'FIX');
    assert.equal(gateOf(r.runDir, 4).plateau.stagnant, 1);
  });
});

test('limits: the panel token budget stops before a round starts; raise-limit on the owner\'s word resumes', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, {
      beforeSetup: (x) => {
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        run.limits = { ...run.limits, maxPanelTokens: 100000 };
        fs.writeFileSync(p, JSON.stringify(run, null, 2));
      },
    });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 30);
    assert.equal(s.payload.decision, 'STOP_LIMIT');
    assert.equal(fs.existsSync(path.join(r.runDir, 'rounds', '01')), false, 'no round was started');
    const up = await cli(['owner', r.runDir, '--kind', 'raise-limit', '--set', 'limits.maxPanelTokens=50000000', '--owner-quote', 'подними лимит до 50 миллионов', '--question', 'Вы согласны с этим решением?']);
    assert.equal(up.exitCode, 0, up.text);
    assert.equal(stateOf(r.runDir).state, 'READY');
    const go = await cli(['step', r.runDir]);
    assert.equal(go.exitCode, 10);
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('give-up: a missing reviewer answer is reprinted; --give-up counts it as an invalid attempt, never as approval', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    // The planter does not guard every lens, and only a guarded lens is re-run: lose the answer of a guarded one.
    const guarded = readJsonFile(path.join(roundDir(r.runDir, 1), 'round.json')).guarded || [];
    const reviewers = spawn.payload.jobs.filter((j) => j.role === 'reviewer' && guarded.some((id) => j.label.includes(id)));
    const lost = reviewers.find((j) => /conversion/.test(j.label)) || reviewers[0];
    const lostLens = guarded.find((id) => lost.label.includes(id));
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript(), skip: (rec) => rec.job === lost.job });
    const again = await cli(['step', r.runDir]);
    assert.equal(again.exitCode, 10);
    assert.deepEqual(again.payload.jobs.map((j) => j.job), [lost.job]);
    const gave = await cli(['step', r.runDir, '--give-up', 'missing']);
    assert.equal(gave.exitCode, 10, gave.text);
    assert.ok(gave.payload.jobs.some((j) => j.role === 'reviewer' && j.label.includes(lostLens)), 'the lens is re-run');
    const ing = readJsonFile(path.join(roundDir(r.runDir, 1), 'ingest', `${lost.job}.json`));
    assert.deepEqual(ing.reasons, ['given-up']);
    assert.ok(ledgerOf(r.runDir).some((l) => l.type === 'job-given-up' && l.data.job === lost.job));
  });
});

test('lock: a live lock is refused (exit 4); a stale lock is taken over and logged', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const lock = path.join(r.runDir, '.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid || process.pid, at: Date.now(), host: os.hostname(), token: 'other' }));
    if (process.ppid) {
      const s = await cli(['step', r.runDir]);
      assert.equal(s.exitCode, 4);
      assert.match(s.payload.error.message, /locked/);
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - 3 * 3600 * 1000, host: os.hostname(), token: 'old' }));
    const s2 = await cli(['step', r.runDir]);
    assert.equal(s2.exitCode, 10, s2.text);
    assert.ok(ledgerOf(r.runDir).some((l) => l.type === 'cleanup' && l.data.what === 'stale-lock'));
    assert.equal(fs.existsSync(lock), false, 'the lock is released after the step');
  });
});

test('--json envelope: sig = sha256(canonical(payload)), equal with the pure-JS sha256 the Workflow driver uses', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 10);
    assert.equal(s.sig, sha256(canonical(s.payload)));
    assert.equal(s.payload.parallel, true);
    const job = s.payload.jobs[0];
    assert.equal(job.role, 'lens-writer');
    assert.match(job.call, /^Read the file .+PROMPT\.md and do exactly what it says/);
    assert.ok(!/gauntlet-runs|gauntlet/.test(job.call), 'no run or repo path in the call');
    const prompt = fs.readFileSync(job.promptPath, 'utf8');
    assert.ok(!prompt.includes(r.runDir), 'the run folder path is not in the prompt');
    assert.ok(!/9,5|оценке панели/.test(prompt), 'the cut owner line never reaches an agent');
  });
});

test('abort, cleanup and restore-best', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const to = path.join(env.workspace, 'best-copy');
    const rbNoQuote = await cli(['restore-best', r.runDir, '--to', to]);
    assert.equal(rbNoQuote.exitCode, 4, 'r2-f19: only on the owner\'s words');
    const Q = ['--owner-quote', 'верни лучшую версию в отдельную папку', '--question', 'Вы согласны с этим решением?'];
    const rb = await cli(['restore-best', r.runDir, '--to', to, ...Q]);
    assert.equal(rb.exitCode, 0, rb.text);
    assert.ok(fs.existsSync(path.join(to, 'content', 'page.md')));
    const into = await cli(['restore-best', r.runDir, '--to', path.join(r.project.material, 'sub'), ...Q]);
    assert.equal(into.exitCode, 4, 'never into a folder inside the live material');
    const live = await cli(['restore-best', r.runDir, '--to', r.project.material, ...Q]);
    assert.equal(live.exitCode, 4, 'a live root needs --overwrite');
    // r2-f24: an overwrite makes the root equal to the best version (files added later are removed)
    fs.writeFileSync(path.join(r.project.material, 'EXTRA-added-after-best.md'), 'new section\n');
    const over = await cli(['restore-best', r.runDir, '--to', r.project.material, '--overwrite', ...Q]);
    assert.equal(over.exitCode, 0, over.text);
    assert.ok(!fs.existsSync(path.join(r.project.material, 'EXTRA-added-after-best.md')), 'the later file is gone');
    assert.deepEqual(over.payload.removed, ['EXTRA-added-after-best.md']);
    assert.equal(over.payload.liveVersionHash, over.payload.bestVersionHash, over.text);
    const noQuote = await cli(['abort', r.runDir, '--reason', 'owner changed the plan']);
    assert.equal(noQuote.exitCode, 4, 'r2-f4: open verified problems -> only on the owner\'s words');
    assert.match(noQuote.payload.error.message, /still open, unverified or contested/);
    const ab = await cli(['abort', r.runDir, '--reason', 'owner changed the plan', '--owner-quote', 'бросай этот запуск, план меняется', '--question', 'Вы согласны с этим решением?']);
    assert.equal(ab.exitCode, 0, ab.text);
    assert.equal(stateOf(r.runDir).state, 'ABORTED');
    assert.ok(fs.existsSync(path.join(r.runDir, 'REPORT.ru.md')));
    // a new run on the same material shows what the aborted one left open
    const again2 = await cli(['init', '--project', 'renamed', '--artifact-type', 'marketing-plan', '--root', `${r.project.material}=content`, '--project-dir', r.project.projectDir]);
    assert.equal(again2.exitCode, 0, again2.text);
    const ev = ledgerOf(again2.payload.runDir).find((l) => l.type === 'init');
    assert.ok(ev.data.earlierRuns[0].openSerious.length > 0, 'open verified problems carried into the record');
    assert.match(again2.text, /open verified problem/);
    const cl = await cli(['cleanup', r.runDir]);
    assert.equal(cl.exitCode, 0, cl.text);
    assert.ok(fs.existsSync(path.join(roundDir(r.runDir, 1), 'snapshot')), 'best/last snapshot kept');
    const again = await cli(['step', r.runDir]);
    assert.equal(again.exitCode, 0);
  });
});

test('abort while reviewers are out: only on the owner words; the key is revealed as evidence and audit still passes', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    await stepUntil(r.runDir, isReviewerSpawn);
    // r3-f8: a round in progress is a re-roll risk: only on the owner's words
    const noQuote = await cli(['abort', r.runDir, '--reason', 'owner changed the plan']);
    assert.equal(noQuote.exitCode, 4, noQuote.text);
    assert.match(noQuote.payload.error.message, /middle of a round/);
    const ab = await cli(['abort', r.runDir, '--reason', 'owner changed the plan', '--owner-quote', 'останови, план меняется', '--question', 'Вы согласны с этим решением?']);
    assert.equal(ab.exitCode, 0, ab.text);
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('owner stop in the middle of a round: recorded, applied at the gate -> STOP_OWNER', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, isReviewerSpawn);
    const st = await cli(['owner', r.runDir, '--kind', 'stop', '--owner-quote', 'стоп, дальше не надо', '--question', 'Вы согласны с этим решением?']);
    assert.equal(st.exitCode, 0, st.text);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 30, d.last.text);
    assert.equal(gateOf(r.runDir, 1).decision, 'STOP_OWNER');
  });
});

test('workflow driver: --driver workflow needs the recorded opt-in', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const s = await cli(['step', r.runDir, '--driver', 'workflow']);
    assert.equal(s.exitCode, 4);
    assert.match(s.payload.error.message, /recorded opt-in/);
  });
});

function optInWorkflow(runDir) {
  const p = path.join(runDir, 'run.json');
  const run = JSON.parse(fs.readFileSync(p, 'utf8'));
  run.driver = { mode: 'workflow', workflowOptIn: { quote: 'да, через Workflow', question: 'Что именно вы разрешаете?', date: '2026-10-06' } };
  fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n');
}

test('workflow driver: a new invocation (budget counter back at 0) is counted whole, not as a difference', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    optInWorkflow(r.runDir);
    const s = await cli(['step', r.runDir, '--driver', 'workflow']);
    assert.equal(s.exitCode, 10, s.text);
    answerJobs(s.payload.jobs, { runDir: r.runDir, script: loadScript() });
    // first invocation reported 2000, then the workflow was started again and reports 700 (first) and 900
    const a = await cli(['step', r.runDir, '--driver', 'workflow', '--usage-total', '2000', '--usage-first']);
    assert.equal(a.exitCode, 20, a.text);
    await cli(['step', r.runDir, '--driver', 'workflow', '--usage-total', '700', '--usage-first']);
    await cli(['step', r.runDir, '--driver', 'workflow', '--usage-total', '900']);
    const lines = fs.readFileSync(path.join(r.runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.tokens), [2000, 700, 200]);
    assert.equal(stateOf(r.runDir).tokens.spent, 2900);
  });
});

test('workflow driver: --usage-total records the budget delta once per call', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    optInWorkflow(r.runDir);
    const s = await cli(['step', r.runDir, '--usage-total', '1000', '--driver', 'workflow']);
    assert.equal(s.exitCode, 10);
    answerJobs(s.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s2 = await cli(['step', r.runDir, '--usage-total', '1500', '--driver', 'workflow']);
    assert.equal(s2.exitCode, 20);
    const lines = fs.readFileSync(path.join(r.runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.source, l.tokens]), [['workflow-budget', 1000], ['workflow-budget', 500]]);
    assert.equal(stateOf(r.runDir).tokens.spent, 1500);
  });
});

test('workflow driver: --usage-delta books exactly what the driver reports, never a difference of totals', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    optInWorkflow(r.runDir);
    const s = await cli(['step', r.runDir, '--driver', 'workflow']);
    assert.equal(s.exitCode, 10, s.text);
    answerJobs(s.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s2 = await cli(['step', r.runDir, '--usage-delta', '340000', '--driver', 'workflow']);
    assert.equal(s2.exitCode, 20, s2.text);
    const lines = fs.readFileSync(path.join(r.runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.source, l.tokens, l.suspect ?? false]), [['workflow-budget', 340000, false]]);
    assert.equal(lines[0].total, undefined, 'no turn total is stored');
    assert.equal(stateOf(r.runDir).tokens.spent, 340000);
    assert.equal(stateOf(r.runDir).tokens.suspectRecords, 0);
  });
});

test('workflow driver: a usage record above twice the round estimate is booked but flagged suspect, in status and report', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    optInWorkflow(r.runDir);
    const s = await cli(['step', r.runDir, '--driver', 'workflow']);
    assert.equal(s.exitCode, 10, s.text);
    answerJobs(s.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const est = JSON.parse(fs.readFileSync(path.join(r.runDir, 'run.json'), 'utf8')).limits.roundTokenEstimate;
    assert.ok(est > 0);
    const big = 2 * est + 1;
    const s2 = await cli(['step', r.runDir, '--usage-delta', String(big), '--driver', 'workflow']);
    assert.equal(s2.exitCode, 20, s2.text);
    const lines = fs.readFileSync(path.join(r.runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].tokens, big, 'still counted: the stop rule errs on the safe side');
    assert.equal(lines[0].suspect, true);
    assert.match(s2.text, /suspect/);
    assert.equal(stateOf(r.runDir).tokens.suspectRecords, 1);
    const st = await cli(['status', r.runDir]);
    assert.match(st.text, /SUSPECT/);
    await cli(['step', r.runDir, '--usage-delta', String(2 * est), '--driver', 'workflow']);
    const l2 = fs.readFileSync(path.join(r.runDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(l2[l2.length - 1].suspect, undefined, 'exactly twice the estimate is not suspect');
  });
});

test('workflow driver: --usage-delta needs --driver workflow, must be a non-negative number, and excludes --usage-total', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    optInWorkflow(r.runDir);
    const a = await cli(['step', r.runDir, '--usage-delta', '5']);
    assert.equal(a.exitCode, 4);
    assert.match(a.payload.error.message, /--driver workflow/);
    const b = await cli(['step', r.runDir, '--usage-delta', '-5', '--driver', 'workflow']);
    assert.equal(b.exitCode, 4);
    assert.match(b.payload.error.message, /non-negative/);
    const c = await cli(['step', r.runDir, '--usage-delta', '5', '--usage-total', '9', '--driver', 'workflow']);
    assert.equal(c.exitCode, 4);
    assert.match(c.payload.error.message, /not both/);
  });
});

test('status and todo commands', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const st = await cli(['status', r.runDir]);
    assert.equal(st.exitCode, 0);
    assert.equal(st.payload.rounds[0].decision, 'FIX');
    const td = await cli(['todo', r.runDir]);
    assert.equal(td.exitCode, 0);
    assert.match(td.payload.todo, /Open problems/);
    assert.ok(!/C-01-01/.test(td.payload.todo), 'dropped clusters are not in the to-do');
  });
});

test('lens writer: an invalid plan is re-issued once with the errors; a second invalid plan stops setup', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    const twoLenses = (rec, answer) => (rec.role === 'lens-writer' ? { ...answer, lenses: answer.lenses.slice(0, 2) } : answer);
    const d = await drive(r.runDir, { script: loadScript(), mutate: twoLenses });
    assert.equal(d.spawns.length, 2, 'issued twice');
    const second = fs.readFileSync(path.join(r.runDir, 'setup', 'lens-writer-2', `${d.spawns[1].payload.jobs[0].job}.md`), 'utf8');
    assert.match(second, /at least 3 items|3 to 7 lenses/);
    assert.equal(d.last.exitCode, 30);
    assert.equal(d.last.payload.decision, 'STOP_INCONCLUSIVE');
    assert.equal(fs.existsSync(path.join(r.runDir, 'FROZEN.json')), false);
  });
});

test('amend: narrowing needs the owner quote; a wider source list does not; the candidate is cleared; audit passes', async () => {
  await withEnv(async (env) => {
    const r = await fixRun(env);
    applyFix(r.project);
    await drive(r.runDir, { script: loadScript() });
    assert.ok(stateOf(r.runDir).candidate, 'clean round 2 set a candidate');
    const strip = readJsonFile(path.join(r.runDir, 'strip.json'));
    strip.excludeGlobs.push('content/AUTHOR-NOTES.md');
    const sf = path.join(env.workspace, 'strip-new.json');
    fs.writeFileSync(sf, JSON.stringify(strip));
    const a = await cli(['amend', r.runDir, '--what', 'strip', '--file', sf, '--reason', 'hide the notes']);
    assert.equal(a.exitCode, 4);
    assert.match(a.payload.error.message, /exclude glob/);
    const src = readJsonFile(path.join(r.runDir, 'sources.json'));
    src.sources.push({ id: 'S3', what: 'Another price check', origin: 'The booking system price of one check.', kind: 'command', cmd: 'node', args: [path.join(r.project.sources, 'one-check-price.mjs')], expect: 'nonempty' });
    const f2 = path.join(env.workspace, 'sources-new.json');
    fs.writeFileSync(f2, JSON.stringify(src));
    const b = await cli(['amend', r.runDir, '--what', 'sources', '--file', f2, '--reason', 'one more source']);
    assert.equal(b.exitCode, 0, b.text);
    assert.equal(stateOf(r.runDir).candidate, null, 'every amend clears the candidate');
    const audit = await cli(['audit', r.runDir]);
    assert.equal(audit.exitCode, 0, audit.text);
  });
});

test('run files conform to the repository schemas', async () => {
  const { validate, loadSchema } = await import('../../lib/core/schema.mjs');
  await withEnv(async (env) => {
    const r = await fixRun(env);
    const check = (name, file) => {
      const v = validate(loadSchema(name), readJsonFile(file));
      assert.ok(v.ok, `${name}: ${JSON.stringify(v.errors.slice(0, 5))}`);
    };
    check('run', path.join(r.runDir, 'run.json'));
    check('state', path.join(r.runDir, 'state.json'));
    check('clusters', path.join(r.runDir, 'clusters.json'));
    check('lenses', path.join(r.runDir, 'lenses.json'));
    check('frozen', path.join(r.runDir, 'FROZEN.json'));
    check('gate', path.join(roundDir(r.runDir, 1), 'gate.json'));
    check('jobs', path.join(roundDir(r.runDir, 1), 'jobs.json'));
    check('detections', path.join(roundDir(r.runDir, 1), 'detections.json'));
    check('canary-key', path.join(roundDir(r.runDir, 1), 'canaries.json'));
    for (const l of ledgerOf(r.runDir)) assert.ok(validate(loadSchema('ledger-event'), l).ok, l.type);
  });
});

test('bench mode: a fixed canary key skips the planter; the key is sealed, committed and revealed like any other', async () => {
  await withEnv(async (env) => {
    const key = {
      schemaVersion: 1,
      canaries: [
        { canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', file: 'content/page.md', locator: 'Цены', before: '- Обычная цена проверки: 25 €.', after: '- Обычная цена проверки: 35 €.', description: 'normal price changed', howProvable: 'S1', intendedSeverity: 'major', prePlanted: false },
        { canary: 'C2', slot: 'S2', purpose: 'attention', targetLens: 'language', type: 'LANG', file: 'content/page.md', locator: 'FAQ', before: 'Около сорока минут на один велосипед.', after: 'Около сорока минут на один велосипэд.', description: 'typo', howProvable: 'spelling', intendedSeverity: 'major', prePlanted: false },
        { canary: 'C3', slot: 'S3', purpose: 'attention', targetLens: 'conversion', type: 'PATH', file: 'content/plan.json', locator: 'post 11', before: '"cta": "Перейдите на сайт и выберите время"', after: '"cta": "Перейдите в приложение и выберите время"', description: 'wrong channel', howProvable: 'page', intendedSeverity: 'major', prePlanted: false },
        { canary: 'C4', slot: 'S4', purpose: 'attention', targetLens: 'generalist', type: 'OMIT-REQ', file: 'content/plan.json', locator: 'post 2', before: 'Двадцать пунктов за сорок минут. Каждый пункт мастер отмечает в листе осмотра и показывает вам.', after: 'Двадцать пунктов за сорок минут.', description: 'sentence removed', howProvable: 'page', intendedSeverity: 'major', prePlanted: false },
      ],
    };
    const keyPath = path.join(env.workspace, 'bench.key.json');
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    const r = await readyRun(env, {
      beforeSetup: (x) => {
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        run.canaries = { ...run.canaries, fixedKey: { path: keyPath, prePlanted: false, approvedBy: 'owner', quote: 'прогони бенч на старом ключе', question: 'Что именно вы разрешаете?', date: '2026-10-06' } };
        fs.writeFileSync(p, JSON.stringify(run, null, 2));
      },
    });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.spawns[0].payload.jobs[0].role, 'reviewer', 'no planter in bench mode');
    assert.ok(!d.spawns.some((s) => s.payload.jobs.some((j) => j.role === 'planter' || j.role === 'validator')));
    const revealed = readJsonFile(path.join(roundDir(r.runDir, 1), 'canaries.json'));
    assert.equal(revealed.canaries.length, 4);
    assert.ok(ledgerOf(r.runDir).some((l) => l.type === 'canary-commit' && l.data.fixed === true));
    const g = gateOf(r.runDir, 1);
    for (const l of ['facts', 'language', 'conversion', 'generalist']) assert.equal(g.perLens[l].valid, true, l);
    assert.equal(g.decision, 'FIX');
  });
});

test('confirm-extra: an opt-in second model reviews in the confirm round only; its findings count, it has no validity of its own', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, {
      beforeSetup: (x) => {
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        run.models = { optIn: [{ role: 'confirm-extra', model: 'opus', approvedBy: 'owner', quote: 'в последнем круге добавь opus', question: 'Что именно вы разрешаете?', date: '2026-10-06' }] };
        fs.writeFileSync(p, JSON.stringify(run, null, 2));
      },
    });
    await drive(r.runDir, { script: loadScript() });
    assert.ok(!jobsOf(r.runDir, 1).some((j) => j.confirmExtra), 'not in working rounds');
    applyFix(r.project);
    await drive(r.runDir, { script: loadScript() });
    const d3 = await drive(r.runDir, { script: loadScript() });
    const extra = jobsOf(r.runDir, 3).filter((j) => j.confirmExtra);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].model, 'opus');
    assert.ok(d3.spawns.some((s) => s.payload.jobs.some((j) => j.model === 'opus' && /:extra$/.test(j.label))));
    const g3 = gateOf(r.runDir, 3);
    assert.deepEqual(Object.keys(g3.perLens).sort(), ['conversion', 'facts', 'generalist', 'language']);
    assert.equal(g3.decision, 'DONE');
  });
});

test('give-up: a planter lost twice stops the round as inconclusive; a lost verifier leaves items unverified', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const p1 = await cli(['step', r.runDir]);
    assert.equal(p1.payload.jobs[0].role, 'planter');
    const p2 = await cli(['step', r.runDir, '--give-up', 'missing']);
    assert.equal(p2.exitCode, 10);
    assert.equal(p2.payload.jobs[0].role, 'planter');
    assert.notEqual(p2.payload.jobs[0].job, p1.payload.jobs[0].job);
    const p3 = await cli(['step', r.runDir, '--give-up', 'missing']);
    assert.equal(p3.exitCode, 30);
    assert.equal(p3.payload.decision, 'STOP_INCONCLUSIVE');
  });
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, (e) => e.payload.jobs.some((j) => j.role === 'verifier'));
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript(), skip: (rec) => rec.role === 'verifier' });
    const s = await cli(['step', r.runDir, '--give-up', 'missing']);
    assert.ok([20, 30].includes(s.exitCode), s.text);
    const unverified = clustersOf(r.runDir).filter((c) => c.status === 'unverified');
    assert.ok(unverified.length >= 3, 'fail-closed: nothing is dropped or confirmed without a verifier');
    assert.equal(gateOf(r.runDir, 1).decision, 'FIX');
  });
});
