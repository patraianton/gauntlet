// What changed in the review copy while reviewers worked (SPEC 14.13): the round is void, but the
// record says which files, how, when and which jobs were running; per-job scratch folders outside
// the copy; added tool scratch (__pycache__, .pytest_cache) is removed and tolerated, nothing else is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withEnv,
  readyRun,
  cli,
  drive,
  stepUntil,
  isReviewerSpawn,
  answerJobs,
  loadScript,
  roundDir,
  readJsonFile,
  ledgerOf,
  gateOf,
  jobsOf,
} from '../fixtures/engine/helpers.mjs';

async function reviewerRound(env, opts = {}) {
  const r = await readyRun(env, opts);
  const spawn = await stepUntil(r.runDir, isReviewerSpawn);
  const rd = roundDir(r.runDir, 1);
  const copyDir = readJsonFile(path.join(rd, 'round.json')).copyDir;
  return { r, spawn, rd, copyDir };
}

// A byte-code file the way CPython writes it: magic ending in CR LF, flags word 0, then the rest.
const PYC = Buffer.concat([Buffer.from([0xcb, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]), Buffer.from('payload')]);
const withSource = { beforeSetup: (r) => fs.writeFileSync(path.join(r.project.material, 'parse.py'), 'import json\n') };

const put = (copyDir, rel, text) => {
  const abs = path.join(copyDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};

function sealedListings(env) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/copy-files\.json$/.test(n)) out.push(p);
    }
  };
  walk(path.join(env.dataHome, 'sealed'));
  return out;
}

test('every reviewer job has its own scratch folder outside the review copy, named in its prompt', async () => {
  await withEnv(async (env) => {
    const { spawn, copyDir } = await reviewerRound(env);
    const reviewers = spawn.payload.jobs.filter((j) => j.role === 'reviewer');
    assert.ok(reviewers.length >= 2);
    const works = new Set();
    for (const j of reviewers) {
      const jobDir = path.dirname(j.promptPath);
      const work = path.join(jobDir, 'work');
      assert.ok(fs.statSync(work).isDirectory(), 'the scratch folder exists');
      assert.deepEqual(fs.readdirSync(work), [], 'and is empty');
      assert.ok(!work.toLowerCase().startsWith(copyDir.toLowerCase() + path.sep), 'outside the review copy');
      assert.ok(!copyDir.toLowerCase().startsWith(jobDir.toLowerCase() + path.sep), 'the copy is not inside the job folder either');
      const prompt = fs.readFileSync(j.promptPath, 'utf8');
      assert.ok(prompt.includes('`' + work + '`'), 'the prompt names the folder');
      assert.match(prompt, /Never create, change or delete anything inside the material folders/);
      assert.match(prompt, /python -B/);
      works.add(work);
    }
    assert.equal(works.size, reviewers.length, 'never shared between jobs');
  });
});

test('copy edited during review: the record names the files (added, changed, removed), with sizes, times and the jobs running', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env);
    assert.equal(sealedListings(env).length, 1, 'the file list of the planted copy is kept sealed while reviewers work');
    const page = path.join(copyDir, 'content', 'page.md');
    const sizeBefore = fs.statSync(page).size;
    fs.appendFileSync(page, '\nВсё уже проверено.\n');
    put(copyDir, 'content/extract-prices.json', '{"prices": [1, 2, 3]}\n');
    const files = fs.readdirSync(path.join(copyDir, 'content'));
    const gone = files.find((f) => f !== 'page.md' && f !== 'extract-prices.json');
    assert.ok(gone, 'the fixture has a third file to remove');
    // the (fake) agents read the material to answer, so the removal comes after their answers
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    fs.rmSync(path.join(copyDir, 'content', gone));
    const s = await cli(['step', r.runDir]);
    assert.equal(s.exitCode, 20);
    assert.equal(s.payload.decision, 'INVALID_ROUND');

    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    assert.equal(rec.listingKnown, true);
    assert.equal(rec.copyFolderMissing, false);
    assert.deepEqual(rec.counts, { added: 1, changed: 1, removed: 1, total: 3 });
    const by = Object.fromEntries(rec.files.map((f) => [f.rel, f]));
    assert.equal(by['content/extract-prices.json'].change, 'added');
    assert.equal(by['content/extract-prices.json'].bytes, 22);
    assert.equal(by['content/page.md'].change, 'changed');
    assert.equal(by['content/page.md'].bytesBefore, sizeBefore);
    assert.ok(by['content/page.md'].bytes > sizeBefore);
    assert.match(by['content/page.md'].mtime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
    assert.equal(by['content/' + gone].change, 'removed');
    assert.equal(by['content/' + gone].runningJobs, null, 'a removed file has no time');
    // the files were written while the reviewers were working: reviewer jobs are named
    assert.ok(by['content/page.md'].runningJobs.length >= 1);
    assert.ok(by['content/page.md'].runningJobs.some((j) => j.role === 'reviewer' && j.lens));
    assert.ok(by['content/page.md'].runningJobs.every((j) => j.role === 'decoy' || (j.role === 'reviewer' && j.lens)));
    const reviewers = jobsOf(r.runDir, 1).filter((j) => j.role === 'reviewer').map((j) => j.job);
    assert.ok(by['content/page.md'].runningJobs.some((j) => reviewers.includes(j.job)));
    assert.ok(rec.jobs.length >= reviewers.length && rec.jobs.every((j) => j.issuedAt));
    assert.ok(rec.jobs.filter((j) => j.role === 'reviewer').every((j) => j.answeredAt), 'the time each answer was finished is known');

    // ledger
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'copy-tampered');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.stage, 'while reviewers worked');
    assert.deepEqual(ev[0].data.counts, rec.counts);
    assert.deepEqual(ev[0].data.files.map((f) => f.rel).sort(), ['content/extract-prices.json', 'content/page.md', 'content/' + gone].sort());
    assert.ok(Array.isArray(ev[0].data.files.find((f) => f.rel === 'content/page.md').runningJobs));

    // gate reasons and the to-do (plain Russian)
    assert.match(gateOf(r.runDir, 1).reasons.join('\n'), /someone wrote into the review copy while reviewers worked/);
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    assert.match(todo, /Пока проверяющие работали, в копию для проверки что-то записали/);
    assert.match(todo, /Что изменилось в копии: новых файлов — 1, изменённых — 1, пропавших — 1\./);
    assert.match(todo, /новый файл: `content\/extract-prices\.json`; размер 22 байта; записан \d{4}-\d\d-\d\d \d\d:\d\d:\d\d; в это время работали: проверяющий «/);
    assert.match(todo, /изменён файл: `content\/page\.md`; размер был \d+ байт(?:а|ов)?, стал \d+ байт(?:а|ов)?;/);
    assert.ok(todo.includes('пропал файл: `content/' + gone + '`; размер был '));
    assert.ok(todo.includes('время записи неизвестно'));

    // the sealed list is gone with the round
    assert.equal(sealedListings(env).length, 0);

    // the report says the same in plain Russian
    await drive(r.runDir, { script: loadScript() });
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /Пока проверяющие работали, в копию для проверки что-то записали, поэтому круг не засчитан/);
    assert.match(md, /новый файл: `content\/extract-prices\.json`/);
    assert.match(md, /Это улика, а не доказательство/);
  });
});

test('a file written outside every job window names nobody running (an outside writer)', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env);
    const abs = put(copyDir, 'content/stray-note.txt', 'left here\n');
    const longAgo = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(abs, longAgo, longAgo);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    const f = rec.files.find((x) => x.rel === 'content/stray-note.txt');
    assert.deepEqual(f.runningJobs, []);
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    assert.match(todo, /ни один из помощников не работал: записал кто-то другой/);
  });
});

test('only tool scratch added (__pycache__ byte-code, .pytest_cache): removed by the engine, the round counts, ledger and report say so', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env, withSource);
    assert.ok(fs.existsSync(path.join(copyDir, 'content', 'parse.py')), 'the source of the byte-code is part of the planted copy');
    put(copyDir, 'content/__pycache__/parse.cpython-312.pyc', PYC);
    put(copyDir, 'content/.pytest_cache/v/cache/lastfailed', '{}');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.notEqual(s.payload?.decision, 'INVALID_ROUND', s.text);
    assert.ok(!fs.existsSync(path.join(rd, 'copy-tamper.json')), 'no tamper record for a tolerated round');
    assert.ok(!fs.existsSync(path.join(copyDir, 'content', '__pycache__')) && !fs.existsSync(path.join(copyDir, 'content', '.pytest_cache')), 'the scratch is removed from the copy');
    const ev = ledgerOf(r.runDir).filter((l) => l.type === 'copy-tampered');
    assert.equal(ev.length, 1);
    assert.match(ev[0].data.action, /only files that a tool writes by itself were added; they were removed and the round counts/);
    assert.deepEqual(ev[0].data.files.map((f) => f.rel).sort(), ['content/.pytest_cache/v/cache/lastfailed', 'content/__pycache__/parse.cpython-312.pyc']);
    assert.equal(readJsonFile(path.join(rd, 'round.json')).copyScratchRemoved, 2);
    // the round runs on and ends with a real decision, and the report names the removal
    const d = await drive(r.runDir, { script: loadScript() });
    assert.notEqual(gateOf(r.runDir, 1).decision, 'INVALID_ROUND');
    assert.ok(d.last.exitCode === 20 || d.last.exitCode === 30, d.last.text);
    const rep = await cli(['report', r.runDir]);
    assert.equal(rep.exitCode, 0, rep.text);
    const md = fs.readFileSync(path.join(r.runDir, 'REPORT.ru.md'), 'utf8');
    assert.match(md, /В копии появилось временных файлов, которые Python или pytest создают сами: 2\. Программа их удалила, копия снова равна подготовленной, круг засчитан\./);
  });
});

test('scratch together with any other new file is never tolerated', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env, withSource);
    put(copyDir, 'content/__pycache__/parse.cpython-312.pyc', PYC);
    put(copyDir, 'content/helper.py', 'import json\n');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    assert.deepEqual(rec.counts, { added: 2, changed: 0, removed: 0, total: 2 });
    assert.equal(rec.files.find((f) => f.rel === 'content/__pycache__/parse.cpython-312.pyc').scratch, true);
    assert.equal(rec.files.find((f) => f.rel === 'content/helper.py').scratch, false);
    const todo = fs.readFileSync(path.join(rd, 'todo.md'), 'utf8');
    assert.match(todo, /новый файл: `content\/helper\.py`/);
    assert.match(todo, /это временный файл, который Python или pytest создают сами; такие новые файлы допускаются, но здесь были и другие изменения/);
  });
});

test('scratch that does not look like scratch is not tolerated: wrong byte-code header, byte-code without its source, a pytest cache file pytest does not write', async () => {
  const cases = [
    ['content/__pycache__/parse.cpython-312.pyc', 'a note for the other reviewers, not byte-code'],
    ['content/__pycache__/other.cpython-312.pyc', PYC],
    ['content/.pytest_cache/notes.txt', 'a note'],
    ['content/.pytest_cache/v/cache/lastfailed', 'not json: a note for the other reviewers'],
  ];
  for (const [rel, body] of cases) {
    await withEnv(async (env) => {
      const { r, spawn, rd, copyDir } = await reviewerRound(env, withSource);
      put(copyDir, rel, body);
      answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
      const s = await cli(['step', r.runDir]);
      assert.equal(s.payload.decision, 'INVALID_ROUND', rel);
      const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
      assert.equal(rec.files.find((f) => f.rel === rel).scratch, false, rel);
    });
  }
});

test('scratch together with a changed material file is not tolerated: only pure additions are', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env);
    fs.appendFileSync(path.join(copyDir, 'content', 'page.md'), '\nx\n');
    put(copyDir, 'content/__pycache__/parse.cpython-312.pyc', 'bytecode');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    assert.equal(rec.counts.changed, 1);
    assert.equal(rec.counts.added, 1);
  });
});

test('the copy folder gone altogether: the record says so', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env);
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    fs.rmSync(copyDir, { recursive: true, force: true });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    assert.equal(rec.copyFolderMissing, true);
    assert.ok(rec.counts.removed > 0 && rec.counts.added === 0);
    assert.match(fs.readFileSync(path.join(rd, 'todo.md'), 'utf8'), /Папка с копией пропала целиком\./);
  });
});

test('a round started before this change (no sealed file list): still INVALID_ROUND, and the record says the files cannot be named', async () => {
  await withEnv(async (env) => {
    const { r, spawn, rd, copyDir } = await reviewerRound(env);
    for (const p of sealedListings(env)) fs.rmSync(p);
    fs.appendFileSync(path.join(copyDir, 'content', 'page.md'), '\nx\n');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    const s = await cli(['step', r.runDir]);
    assert.equal(s.payload.decision, 'INVALID_ROUND');
    const rec = readJsonFile(path.join(rd, 'copy-tamper.json'));
    assert.equal(rec.listingKnown, false);
    assert.equal(rec.counts.total, 0);
    assert.match(fs.readFileSync(path.join(rd, 'todo.md'), 'utf8'), /Список файлов копии на момент её подготовки не сохранился/);
  });
});

test('the copy edited while the planter works: the ledger event names the files too (before planting)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const spawn = await stepUntil(r.runDir, (e) => e.exitCode === 10 && e.payload.jobs.some((j) => j.role === 'planter'));
    const copyDir = readJsonFile(path.join(roundDir(r.runDir, 1), 'round.json')).copyDir;
    put(copyDir, 'content/helper.py', 'print(1)\n');
    answerJobs(spawn.payload.jobs, { runDir: r.runDir, script: loadScript() });
    await stepUntil(r.runDir, isReviewerSpawn);
    const ev = ledgerOf(r.runDir).find((l) => l.type === 'copy-tampered');
    assert.equal(ev.data.stage, 'before planting');
    assert.deepEqual(ev.data.files.map((f) => [f.rel, f.change]), [['content/helper.py', 'added']]);
  });
});
