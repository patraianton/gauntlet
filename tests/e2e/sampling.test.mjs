// A large data file goes through a whole round via a sample (SPEC 14.10, D40), with fake agents:
// the sample is drawn after the snapshot and sealed with the canary key, the planter and the
// reviewers get it in their job folders, planted errors sit only in sampled rows, the rewritten
// minimum and the receipts speak of sampled rows, and the report says how many rows were seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hashJson } from '../../lib/core/hash.mjs';
import { setClockForTests } from '../../lib/core/clock.mjs';
import {
  withEnv,
  readyRun,
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
  gateOf,
} from '../fixtures/engine/helpers.mjs';

const ROWS = 400;
const SAMPLE_ROWS = 12;

function csv(n) {
  const out = ['id,shop,visitors,url'];
  for (let i = 1; i <= n; i++) out.push(`r${String(i).padStart(3, '0')},Shop ${i} bv,${1000 + i * 13},https://shop-${i}.example.test/`);
  return out.join('\n') + '\n';
}

const rowText = (i) => `r${String(i).padStart(3, '0')},Shop ${i} bv,${1000 + i * 13},https://shop-${i}.example.test/`;

function sampleOpts(extra = {}) {
  return {
    mutateMaterial: (pr) => fs.writeFileSync(path.join(pr.material, 'data.csv'), csv(ROWS)),
    beforeSetup: (x) => {
      const p = path.join(x.runDir, 'run.json');
      const run = readJsonFile(p);
      run.limits = { ...run.limits, sampleThresholdRows: 100, sampleRows: SAMPLE_ROWS };
      run.limitsOptIn = { approvedBy: 'owner', quote: 'для проверки выборки возьми маленькую выборку', question: 'Что именно вы разрешаете?', date: '2026-10-07' };
      fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n');
    },
    ...extra,
  };
}

function runIdOf(runDir) {
  return readJsonFile(path.join(runDir, 'run.json')).runId;
}

function stageFile(env, runDir, n, rel) {
  return path.join(env.dataHome, 'sealed', runIdOf(runDir), `${String(n).padStart(2, '0')}-stage`, rel);
}

test('a round over a large data file: sample sealed until reveal, given to planter and reviewers, shown in the report', async (t) => {
  // The run id (and with it every seeded draw of the fake agents) depends on the minute of the clock;
  // a fixed clock makes the whole run, round 2 included, the same every time (the minute was picked so that
  // round 2 ends as described below; another minute seeds the fake agents differently).
  setClockForTests(() => new Date(2036, 0, 1, 10, 2, 0));
  t.after(() => setClockForTests(null));
  await withEnv(async (env) => {
    const r = await readyRun(env, sampleOpts());
    const runDir = r.runDir;

    // the lens writer was told about the large file (setup prompt, kept in setup/lens-writer-1)
    const lwDir = path.join(runDir, 'setup', 'lens-writer-1');
    const lwPrompt = fs.readdirSync(lwDir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(lwDir, f), 'utf8')).join('\n');
    assert.match(lwPrompt, /content\/data\.csv \(text\) — LARGE DATA FILE \(\d+ KB, 400 rows\): reviewers read a random sample of at most 12 rows/);
    assert.match(fs.readFileSync(path.join(runDir, 'SETUP-SUMMARY.ru.md'), 'utf8'), /## Большие файлы с данными[\s\S]*`content\/data\.csv`: 400 строк/);
    assert.match(fs.readFileSync(path.join(runDir, 'SETUP-SUMMARY.ru.md'), 'utf8'), /Пределы шире обычных/);

    // 1. the planter's job: the pre-planting sample is in its folder, the prompt names it
    const planterSpawn = await stepUntil(runDir, (e) => e.payload.jobs.some((j) => j.role === 'planter'), { script: loadScript() });
    const pj = planterSpawn.payload.jobs.find((j) => j.role === 'planter');
    const pdir = path.dirname(pj.promptPath);
    assert.ok(fs.existsSync(path.join(pdir, 'SAMPLE-1.md')), 'the planter gets the sample file');
    const pprompt = fs.readFileSync(pj.promptPath, 'utf8');
    assert.ok(!pprompt.includes('<<JOB_FILE:'), 'the job folder token is replaced');
    assert.ok(pprompt.includes(path.join(pdir, 'SAMPLE-1.md')), 'the prompt names the sample file by its full path');
    assert.match(pprompt, /LARGE DATA FILE \(\d+ KB, 400 rows\): put an edit here only inside a row listed in/);
    const sample1 = readJsonFile(stageFile(env, runDir, 1, 'sample.json'));
    assert.equal(sample1.files.length, 1);
    assert.equal(sample1.files[0].file, 'content/data.csv');
    assert.equal(sample1.files[0].rows, ROWS);
    assert.equal(sample1.files[0].chosen.length, SAMPLE_ROWS);
    assert.ok(!fs.existsSync(path.join(roundDir(runDir, 1), 'sample.json')), 'the selection is sealed with the key: not in the run folder yet');
    const sampleMd = fs.readFileSync(path.join(pdir, 'SAMPLE-1.md'), 'utf8');
    for (const n of sample1.files[0].chosen) assert.ok(sampleMd.includes(`## Row ${n} (line ${n + 1})\n\n${rowText(n)}\n`), `row ${n} is shown exactly`);
    assert.equal((sampleMd.match(/^## Row /gm) || []).length, SAMPLE_ROWS);

    // 2. the planter's first answer puts the error in a row that is NOT in the sample: refused by code
    const outside = [...Array(ROWS).keys()].map((i) => i + 1).find((n) => !sample1.files[0].chosen.includes(n));
    const slotsStaged = readJsonFile(stageFile(env, runDir, 1, 'slots.json')).slots;
    let refused = false;
    const mutate = (rec, answer) => {
      if (rec.role !== 'planter' || rec.attempt !== 1) return answer;
      refused = true;
      return {
        ...answer,
        candidates: [
          {
            slot: slotsStaged[0].slot,
            alt: 1,
            file: 'content/data.csv',
            locator: `row ${outside}`,
            before: `Shop ${outside} bv,${1000 + outside * 13}`,
            after: `Shop ${outside} bv,${1000 + outside * 13 + 1}`,
            description: 'A visitor count that differs from the table.',
            howProvable: 'Compare with the other columns.',
            intendedSeverity: 'major',
          },
        ],
      };
    };
    let env2 = planterSpawn;
    // answer the planter (mutated) and go on until the reviewers are printed
    {
      const written = answerJobs(env2.payload.jobs, { runDir, script: loadScript(), mutate });
      assert.ok(refused && written.every((w) => w.written));
      const codes = written.map((w) => `${w.job}=${w.code}`).join(',');
      env2 = await stepUntilFrom(runDir, ['--answer-hash', codes]);
    }
    const checks1 = readJsonFile(stageFile(env, runDir, 1, 'planter-1/code-checks.json')).checks;
    assert.ok(checks1.some((c) => !c.ok && c.errors.some((e) => e.startsWith('outside-sample'))), JSON.stringify(checks1));
    assert.ok(env2.payload.jobs.some((j) => j.role === 'planter' || j.role === 'validator' || j.role === 'reviewer'));

    // 3. go on to the reviewers
    const revSpawn = env2.payload.jobs.some((j) => j.role === 'reviewer') ? env2 : await stepUntil(runDir, isReviewerSpawn, { script: loadScript() });
    const reviewers = revSpawn.payload.jobs.filter((j) => j.role === 'reviewer');
    assert.ok(reviewers.length >= 4);
    const key = readJsonFile(path.join(env.dataHome, 'sealed', runIdOf(runDir), '01.key.json'));
    const planted = key.canaries.filter((c) => c.file === 'content/data.csv');
    const finalSample = readJsonFile(stageFile(env, runDir, 1, 'sample.json'));
    for (const c of planted) {
      const n = Number(/(?:^|\n)r(\d+),/.exec(c.before)?.[1]);
      assert.ok(finalSample.files[0].chosen.includes(n), `the planted row ${n} is in the sample`);
    }
    for (const j of reviewers) {
      const dir = path.dirname(j.promptPath);
      const prompt = fs.readFileSync(j.promptPath, 'utf8');
      assert.ok(fs.existsSync(path.join(dir, 'SAMPLE-1.md')), 'every reviewer gets the sample file');
      assert.ok(!prompt.includes('<<JOB_FILE:'));
      assert.match(prompt, /LARGE DATA FILE \(\d+ KB, 400 rows\): not read whole/);
      // the planted errors are visible in the sample, like the rest of the rows
      const md = fs.readFileSync(path.join(dir, 'SAMPLE-1.md'), 'utf8');
      for (const c of planted) assert.ok(md.includes(c.after.trim().split('\n')[0]), 'the planted text is in the sample file');
      assert.ok(!/canar|planted|подлож/i.test(md), 'nothing in the sample shows which rows carry an error');
    }
    // the generalist reads everything: its rule is rewritten
    const gen = reviewers.find((j) => j.label === 'reviewer:generalist');
    const genPrompt = fs.readFileSync(gen.promptPath, 'utf8');
    assert.match(genPrompt, /- M1 \(all-files\): every sampled row of the large data files listed below, and every summary number/);
    assert.ok(genPrompt.includes(`content/data.csv: ${finalSample.files[0].chosen.length} of ${ROWS} rows, in ${path.join(path.dirname(gen.promptPath), 'SAMPLE-1.md')}`), 'the minimum names the sample file with its full path');
    // receipts about the sampled file point at sampled rows only
    const jobs = readJsonFile(path.join(roundDir(runDir, 1), 'jobs.json')).jobs.filter((j) => j.role === 'reviewer');
    const lines = new Set([1, ...finalSample.files[0].chosen.map((n) => n + 1)]);
    for (const j of jobs) for (const c of j.challenges || []) if (c.kind === 'line' && c.file === 'content/data.csv') assert.ok(lines.has(c.line), `receipt line ${c.line} is a sampled row`);

    // 4. finish round 1
    const d = await drive(runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const rd = roundDir(runDir, 1);
    assert.ok(fs.existsSync(path.join(rd, 'sample.json')), 'revealed with the key');
    assert.ok(!fs.existsSync(stageFile(env, runDir, 1, 'sample.json')), 'the sealed stage is emptied');
    const sealed = readJsonFile(path.join(rd, 'sample.json'));
    assert.deepEqual(sealed, finalSample);
    const led = ledgerOf(runDir).filter((l) => l.round === 1);
    const slotsEv = led.find((l) => l.type === 'slots');
    const commitEv = led.find((l) => l.type === 'canary-commit');
    assert.match(slotsEv.data.sampleCommitment, /^[0-9a-f]{64}$/);
    assert.equal(commitEv.data.sampleCommitment, hashJson(sealed), 'the final selection matches what was committed before the reviewers started');
    assert.ok(led.findIndex((l) => l.type === 'canary-commit') < led.findIndex((l) => l.type === 'canary-reveal'));
    // the job folders (with the sample files) are gone with the round
    for (const j of reviewers) assert.ok(!fs.existsSync(path.dirname(j.promptPath)), 'job folder deleted');
    assert.ok(gateOf(runDir, 1).decision);

    // 5. the audit passes and the report states the coverage honestly
    const aud = await cli(['audit', runDir]);
    assert.equal(aud.exitCode, 0, aud.text);
    const rep = await cli(['report', runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const report = fs.readFileSync(path.join(runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(report, /Большие файлы с данными проверяющие целиком не читали/);
    assert.match(report, new RegExp(`Круг 1, файл \`content/data\\.csv\`: проверяющие видели выборку ${finalSample.files[0].chosen.length} строк из ${ROWS}; ошибки вне выборки могли остаться\\.`));
    assert.match(report, /«Готово» здесь значит/);
    const sum = await cli(['report', runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => /Большие файлы с данными \(их 1\) проверены только по выборке: в круге 1, например, файл `content\/data\.csv` — \d+ строк из 400\. Ошибки вне выборки могли остаться/.test(l)), sum.text);

    // 6. the next round draws another sample (the executor fixes between rounds and cannot know it)
    applyFix(r.project);
    const d2 = await drive(runDir, { script: loadScript() });
    // Round 2 ran a full review through its own draw. The fake planter cannot fill the generalist's slot
    // here (its error kind needs a requirement line, and the middle of the reading order is data rows that
    // are mostly outside this round's sample), so the round asks for a repeat for exactly that one reason:
    // every lens that did get an attention check was valid and caught its planted error.
    assert.equal(d2.last.exitCode, 20, d2.last.text);
    const gate2 = gateOf(runDir, 2);
    assert.equal(gate2.decision, 'FIX');
    assert.deepEqual(gate2.reasons, ['lens generalist: no attention check this round']);
    for (const lens of ['facts', 'language', 'conversion']) {
      assert.equal(gate2.perLens[lens].valid, true, lens);
      assert.equal(gate2.perLens[lens].guarded, true, lens);
      assert.equal(gate2.perLens[lens].ownCanary.outcome, 'caught', lens);
    }
    const sample2 = readJsonFile(path.join(roundDir(runDir, 2), 'sample.json'));
    assert.notDeepEqual(sample2.files[0].chosen, sealed.files[0].chosen);
    assert.equal(sample2.files[0].rows, ROWS);
    const aud2 = await cli(['audit', runDir]);
    assert.equal(aud2.exitCode, 0, aud2.text);
  });
});

/** step once (with extra args) and keep answering until an exit other than 10, or a reviewer wave is printed. */
async function stepUntilFrom(runDir, extraArgs) {
  let extra = extraArgs;
  for (let i = 0; i < 30; i++) {
    const e = await cli(['step', runDir, ...extra]);
    if (e.exitCode !== 10 || isReviewerSpawn(e)) return e;
    const written = answerJobs(e.payload.jobs, { runDir, script: loadScript() });
    const codes = written.filter((w) => w.written && w.code).map((w) => `${w.job}=${w.code}`);
    extra = codes.length ? ['--answer-hash', codes.join(',')] : [];
  }
  throw new Error('stepUntilFrom: the reviewers were never printed');
}

test('a run without large files draws no sample and writes no sample file', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, {});
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.ok(!fs.existsSync(path.join(roundDir(r.runDir, 1), 'sample.json')));
    const led = ledgerOf(r.runDir);
    assert.ok(led.filter((l) => l.type === 'slots' || l.type === 'canary-commit').every((l) => !('sampleCommitment' in l.data)));
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    assert.ok(!/выборк/.test(fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8')), 'no coverage lines without a sample');
  });
});

test('bench mode: the rows of a fixed key join the sample, whether or not the draw reached them', async () => {
  await withEnv(async (env) => {
    const canary = (n, slot, lens, type) => ({
      canary: `C${n + 1}`,
      slot,
      purpose: 'attention',
      targetLens: lens,
      type,
      file: 'content/data.csv',
      locator: `row ${n * 100 + 17}`,
      before: `Shop ${n * 100 + 17} bv,${1000 + (n * 100 + 17) * 13}`,
      after: `Shop ${n * 100 + 17} bv,${1000 + (n * 100 + 17) * 13 + 10}`,
      description: 'visitor count changed',
      howProvable: 'compare with the table',
      intendedSeverity: 'major',
      prePlanted: false,
    });
    const key = { schemaVersion: 1, canaries: [canary(0, 'S1', 'facts', 'FACT-NUM'), canary(1, 'S2', 'language', 'FACT-NUM'), canary(2, 'S3', 'conversion', 'FACT-NUM'), canary(3, 'S4', 'generalist', 'FACT-NUM')] };
    const keyPath = path.join(env.workspace, 'bench.key.json');
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    const opts = sampleOpts();
    const r = await readyRun(env, {
      ...opts,
      beforeSetup: (x) => {
        opts.beforeSetup(x);
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        run.canaries = { ...run.canaries, fixedKey: { path: keyPath, prePlanted: false, approvedBy: 'owner', quote: 'прогони бенч на старом ключе', question: 'Что именно вы разрешаете?', date: '2026-10-07' } };
        fs.writeFileSync(p, JSON.stringify(run, null, 2));
      },
    });
    const first = await stepUntil(r.runDir, isReviewerSpawn);
    const sealedSample = readJsonFile(stageFile(env, r.runDir, 1, 'sample.json'));
    const wanted = [17, 117, 217, 317];
    for (const n of wanted) assert.ok(sealedSample.files[0].chosen.includes(n), `row ${n} of a planted error is in the sample`);
    assert.equal(sealedSample.files[0].chosen.length, SAMPLE_ROWS + sealedSample.files[0].forCanary.length);
    assert.deepEqual([...sealedSample.files[0].forCanary].sort((a, b) => a - b), wanted.filter((n) => sealedSample.files[0].forCanary.includes(n)));
    // the planted rows are in every reviewer's sample file
    for (const j of first.payload.jobs.filter((x) => x.role === 'reviewer')) {
      const md = fs.readFileSync(path.join(path.dirname(j.promptPath), 'SAMPLE-1.md'), 'utf8');
      for (const n of wanted) assert.ok(md.includes(`## Row ${n} (line ${n + 1})`));
      assert.ok(md.includes(`Shop 17 bv,${1000 + 17 * 13 + 10}`), 'the planted text, not the original, is shown');
    }
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.deepEqual(readJsonFile(path.join(roundDir(r.runDir, 1), 'sample.json')), sealedSample);
    // the matcher side works over sampled rows: every lens caught the planted error of its own in the large file
    const dets = readJsonFile(path.join(roundDir(r.runDir, 1), 'detections.json')).detections;
    const own = dets.filter((x) => x.purpose === 'attention' && x.lens === x.targetLens);
    assert.deepEqual([...new Set(own.map((x) => x.canary))].sort(), ['C1', 'C2', 'C3', 'C4']);
    for (const c of ['C1', 'C2', 'C3', 'C4']) assert.ok(own.some((x) => x.canary === c && x.outcome === 'caught'), `${c}: ${JSON.stringify(own.filter((x) => x.canary === c).map((x) => [x.lens, x.attempt, x.outcome]))}`);
    const aud = await cli(['audit', r.runDir]);
    assert.equal(aud.exitCode, 0, aud.text);
  });
});

test('the sealed sample cannot be changed between the draw and the reveal (integrity failure, exit 3)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, sampleOpts());
    await stepUntil(r.runDir, isReviewerSpawn, { script: loadScript() });
    const p = stageFile(env, r.runDir, 1, 'sample.json');
    const sel = readJsonFile(p);
    const commit = ledgerOf(r.runDir).find((l) => l.type === 'canary-commit' && l.round === 1);
    assert.equal(commit.data.sampleCommitment, hashJson(sel), 'untouched: the file is what was committed');
    // someone edits the selection before the reveal: the rows the reviewers were told to read are no longer the sealed ones
    sel.files[0].chosen = sel.files[0].chosen.slice(1);
    fs.writeFileSync(p, JSON.stringify(sel));
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 3, d.last.text);
    assert.match(d.last.text, /sealed sample changed after it was committed/);
    assert.ok(!ledgerOf(r.runDir).some((l) => l.type === 'canary-reveal'), 'the key was not revealed');
  });
});

test('a planted copy whose rows no longer match the sample ends as a clean BLOCKED_PRECHECK, not a crash', async () => {
  await withEnv(async (env) => {
    // a bench key whose edit adds a line break to a row: the copy then has one row more than the sample counted
    const row = 17;
    const canary = (n, slot, lens) => ({
      canary: `C${n + 1}`,
      slot,
      purpose: 'attention',
      targetLens: lens,
      type: 'FACT-NUM',
      file: 'content/data.csv',
      locator: `row ${row + n * 100}`,
      before: `Shop ${row + n * 100} bv,${1000 + (row + n * 100) * 13}`,
      after: n === 0 ? `Shop ${row} bv,${1000 + row * 13}\nr999,Extra shop,1,https://x.example.test/` : `Shop ${row + n * 100} bv,${1000 + (row + n * 100) * 13 + 10}`,
      description: 'visitor count changed',
      howProvable: 'compare with the table',
      intendedSeverity: 'major',
      prePlanted: false,
    });
    const key = { schemaVersion: 1, canaries: [canary(0, 'S1', 'facts'), canary(1, 'S2', 'language'), canary(2, 'S3', 'conversion'), canary(3, 'S4', 'generalist')] };
    const keyPath = path.join(env.workspace, 'bench-badrow.key.json');
    fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
    const opts = sampleOpts();
    const r = await readyRun(env, {
      ...opts,
      beforeSetup: (x) => {
        opts.beforeSetup(x);
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        run.canaries = { ...run.canaries, fixedKey: { path: keyPath, prePlanted: false, approvedBy: 'owner', quote: 'прогони бенч на старом ключе', question: 'Что именно вы разрешаете?', date: '2026-10-07' } };
        fs.writeFileSync(p, JSON.stringify(run, null, 2));
      },
    });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.equal(gateOf(r.runDir, 1).decision, 'BLOCKED_PRECHECK');
    const todo = fs.readFileSync(path.join(roundDir(r.runDir, 1), 'todo.md'), 'utf8');
    assert.match(todo, /rows of content\/data\.csv changed while the review copy was prepared \(401 rows, 400 expected\)/);
    assert.match(todo, /leave the rows of large data files as they are/);
    assert.ok(!ledgerOf(r.runDir).some((l) => l.type === 'canary-commit'), 'nothing was sealed or sent to reviewers');
    // the run is still usable: audit passes
    const aud = await cli(['audit', r.runDir]);
    assert.equal(aud.exitCode, 0, aud.text);
  });
});

test('audit: a changed revealed sample fails the audit, an untouched one passes the sample check', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env, sampleOpts());
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const ok = await cli(['audit', r.runDir]);
    assert.equal(ok.exitCode, 0, ok.text);
    assert.ok(readJsonFile(path.join(r.runDir, 'AUDIT.json')).checks.some((c) => c.id === 'sample' && c.ok));
    const p = path.join(roundDir(r.runDir, 1), 'sample.json');
    const sel = readJsonFile(p);
    sel.files[0].chosen = sel.files[0].chosen.slice(1);
    fs.writeFileSync(p, JSON.stringify(sel));
    const bad = await cli(['audit', r.runDir]);
    assert.equal(bad.exitCode, 3, bad.text);
    const checks = readJsonFile(path.join(r.runDir, 'AUDIT.json')).checks;
    // the guard between commands (D28) sees the edit first; the `sample` check is the second net (a unit test covers it alone)
    assert.ok(checks.some((c) => !c.ok && c.details.some((x) => x.includes('rounds/01/sample.json'))), JSON.stringify(checks));
  });
});

test('big files that cannot be sampled: lens writer, owner summary, reviewers and report all say so; the group of small csv files is sampled', async (t) => {
  setClockForTests(() => new Date(2036, 0, 1, 10, 2, 0));
  t.after(() => setClockForTests(null));
  await withEnv(async (env) => {
    const r = await readyRun(env, {
      mutateMaterial: (pr) => {
        fs.writeFileSync(path.join(pr.material, 'dump.sql'), 'INSERT INTO shops VALUES (1, \'Shop 1 bv\', 1013);\n'.repeat(900));
        fs.writeFileSync(path.join(pr.material, 'object.json'), JSON.stringify({ shops: { blob: 'abc '.repeat(6000) } }));
        for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(pr.material, `part${i}.csv`), csv(360));
      },
      beforeSetup: (x) => {
        const p = path.join(x.runDir, 'run.json');
        const run = readJsonFile(p);
        // smaller thresholds mean less is read whole, so they need the owner's words
        run.limits = { ...run.limits, sampleThresholdBytes: 20000, sampleRows: 12 };
        run.limitsOptIn = { approvedBy: 'owner', quote: 'для проверки выборки возьми маленькую выборку', question: 'Что именно вы разрешаете?', date: '2026-10-07' };
        fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n');
      },
    });
    const runDir = r.runDir;
    const lwDir = path.join(runDir, 'setup', 'lens-writer-1');
    const lwPrompt = fs.readdirSync(lwDir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(lwDir, f), 'utf8')).join('\n');
    assert.match(lwPrompt, /content\/dump\.sql \(text\) — LARGE DATA FILE THAT CANNOT BE SAMPLED \(\d+ KB, \.sql\)/);
    assert.match(lwPrompt, /content\/object\.json \(json\) — LARGE DATA FILE THAT CANNOT BE SAMPLED/);
    assert.match(lwPrompt, /content\/part1\.csv \(text\) — LARGE DATA FILE \(\d+ KB, 360 rows\)[^\n]*one of 5 files of the same kind in its folder/);
    const summary = fs.readFileSync(path.join(runDir, 'SETUP-SUMMARY.ru.md'), 'utf8');
    assert.match(summary, /## Большие файлы, из которых нельзя выбрать строки\n\nИх 2\./);
    assert.match(summary, /`content\/dump\.sql`: \d+ КБ/);
    assert.match(summary, /`content\/part1\.csv`: 360 строк[^\n]*один из 5 файлов одного вида в этой папке/);

    // the reviewers' prompt
    const planterSpawn = await stepUntil(runDir, (e) => e.payload.jobs.some((j) => j.role === 'planter'), { script: loadScript() });
    const planterPrompt = fs.readFileSync(planterSpawn.payload.jobs.find((j) => j.role === 'planter').promptPath, 'utf8');
    assert.match(planterPrompt, /content\/dump\.sql \(text, \d+ bytes\) — LARGE DATA FILE THAT CANNOT BE SAMPLED[^\n]*do not put an edit here/);
    const revSpawn = await stepUntil(runDir, isReviewerSpawn, { script: loadScript() });
    const reviewers = revSpawn.payload.jobs.filter((j) => j.role === 'reviewer');
    assert.ok(reviewers.length >= 4);
    for (const j of reviewers) {
      const prompt = fs.readFileSync(j.promptPath, 'utf8');
      assert.match(prompt, /content\/dump\.sql \(text, \d+ bytes\) — LARGE DATA FILE THAT CANNOT BE SAMPLED[^\n]*too big to read whole[^\n]*check its structure and spot-check it/);
      assert.match(prompt, /content\/object\.json \(json, \d+ bytes\) — LARGE DATA FILE THAT CANNOT BE SAMPLED/);
      assert.match(prompt, /content\/part3\.csv \(text, \d+ bytes\) — LARGE DATA FILE \(\d+ KB, 360 rows\): not read whole[^\n]*one of 5 files/);
    }
    const sealed = readJsonFile(stageFile(env, runDir, 1, 'sample.json'));
    assert.deepEqual(sealed.unsampled.map((u) => u.file), ['content/dump.sql', 'content/object.json']);
    assert.equal(sealed.files.length, 5);
    assert.ok(sealed.files.every((f) => f.grouped && f.grouped.files === 5));
    const slotsEv = ledgerOf(runDir).find((l) => l.type === 'slots' && l.round === 1);
    assert.equal(slotsEv.data.unsampledFiles, 2);

    // finish the round; the audit still passes (the list is part of the sealed selection) and the report says it
    const d = await drive(runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    const aud = await cli(['audit', runDir]);
    assert.equal(aud.exitCode, 0, aud.text);
    const rep = await cli(['report', runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const report = fs.readFileSync(path.join(runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(report, /Некоторые большие файлы с данными не делятся на строки-записи/);
    assert.match(report, /Круг 1, файл `content\/dump\.sql` \(\d+ КБ\): целиком не проверен, только устройство и отдельные места\./);
    assert.match(report, /Круг 1, файл `content\/object\.json`/);
    assert.match(report, /Круг 1, файл `content\/part2\.csv`: проверяющие видели выборку \d+ строк из 360; ошибки вне выборки могли остаться\. Это один из 5 файлов одного вида в этой папке/);
    assert.match(report, /«Готово» здесь не значит «эти файлы проверены целиком»/);
    const sum = await cli(['report', runDir, '--summary']);
    assert.ok(sum.payload.summaryRu.some((l) => /Большие файлы, из которых нельзя выбрать строки \(их 2\), целиком не проверены: в круге 1, например, файл `content\/dump\.sql`/.test(l)), sum.text);
  });
});
