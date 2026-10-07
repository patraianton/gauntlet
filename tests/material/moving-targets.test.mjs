// Moving targets (night 06-07.10.2026): a recipe that reads something the executor changes during the
// run is flagged by its shape; setup and amend keep it only on the owner's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { movingTargetProblems, gitMovingProblems, gitRootOf } from '../../lib/material/sources.mjs';
import { summariseSourceAttempts, sourceMinimumRescue } from '../../lib/engine/ingest.mjs';
import { crossFieldRules } from '../../templates/check-answer.mjs';
import { withEnv, freshRun, drive, cli, loadScript, readJsonFile, ledgerOf } from '../fixtures/engine/helpers.mjs';

const H1 = 'dca1edbd629f658db68314c9db29e1d2076b0e04';
const H2 = '733b6dc473b5e86f274e9a5383eb19b642524ba6';
const none = { gitRoot: () => null };
const git = (id, ...args) => ({ id, kind: 'command', cmd: 'git', args: ['-C', 'C:/p/repo', ...args] });
const keys = (list, opts = none) => movingTargetProblems(list, opts).map((p) => p.key);

test('the recipes that blocked window 2 are flagged: an abbreviated hash, a branch name, origin/<branch>', () => {
  // S29: git show 10d8d4a:reports/SPEND.md   S33: git log -3 ... magiclink   S35: git log -4 ... origin/feature/staging
  const out = movingTargetProblems(
    [git('S29', 'show', '10d8d4a:reports/SPEND.md'), git('S33', 'log', '-3', '--format=%h %s', 'magiclink'), git('S35', 'log', '-4', '--format=%h %ad %s', '--date=iso', 'origin/feature/staging')],
    none,
  );
  assert.equal(out.length, 3);
  assert.match(out[0].key, /^source S29: git revision "10d8d4a" is an abbreviated hash/);
  assert.match(out[1].key, /^source S33: git revision "magiclink" is not a full commit hash/);
  assert.match(out[2].key, /^source S35: git revision "origin\/feature\/staging" is not a full commit hash/);
  for (const p of out) {
    assert.match(p.suggest, /rev-parse/, 'every warning shows how to get the full hash');
    assert.match(p.suggest, /show <full-hash>:<path>/);
  }
});

test('pinned forms are accepted: git show <full-hash>:path, a diff between two full hashes, log <full-hash>', () => {
  assert.deepEqual(keys([git('S1', 'show', `${H1}:lib/db/migrations/170_listings.sql`)]), []);
  assert.deepEqual(keys([git('S2', 'diff', '--stat', H1, H2)]), []);
  assert.deepEqual(keys([git('S3', 'show', '--name-only', H2)]), []);
  assert.deepEqual(keys([git('S4', 'log', '-4', '--format=%h %s', '--date=iso', H2)]), []);
  assert.deepEqual(keys([git('S5', 'log', '-n', '4', `${H1}..${H2}`)]), []);
  assert.deepEqual(keys([git('S6', 'show', `${H2}^:a.txt`)]), []);
  assert.deepEqual(keys([git('S7', 'cat-file', '-p', `${H1}:a.txt`)]), []);
  assert.deepEqual(keys([git('S8', 'show', 'a'.repeat(64) + ':a.txt')]), [], 'a sha256 repository hash is pinned too');
});

test('moving forms are flagged: HEAD, relative names, tags, a log without a range, a diff without commits, the live state', () => {
  const k = (...a) => keys([git('S9', ...a)]);
  assert.match(k('show', 'HEAD:a.txt')[0], /"HEAD" is not a full commit hash/);
  assert.match(k('show', 'HEAD~1:a.txt')[0], /"HEAD" is not a full commit hash/);
  assert.match(k('show', 'v1.2.0:a.txt')[0], /"v1.2.0" is not a full commit hash/);
  assert.match(k('log', '-5')[0], /git log has no pinned range/);
  assert.match(k('show')[0], /git show has no pinned commit/);
  assert.match(k('diff')[0], /git diff without a commit reads the working tree/);
  assert.match(k('log', '--all', H1)[0], /--all reads every ref/);
  assert.match(k('log', `${H1}..HEAD`)[0], /"HEAD" is not a full commit hash/);
  assert.match(k('log', `${H1}..`)[0], /open end/);
  assert.match(k('status', '--short')[0], /git status reads the live state/);
  assert.match(k('branch', '-a')[0], /git branch reads the live state/);
  assert.match(k('ls-files')[0], /git ls-files reads the live state/);
  assert.deepEqual(k('--version'), []);
  assert.deepEqual(gitMovingProblems(['diff', '--no-index', 'a', 'b']), [], 'two plain files are not git state');
});

test('paths after a pinned revision are not revisions: the ls-tree shapes of window 2 (S20, S21), log and diff with a path', () => {
  // S20/S21: git -C r ls-tree --name-only <hash> lib/db/migrations/
  assert.deepEqual(keys([git('S20', 'ls-tree', '--name-only', H1, 'lib/db/migrations/')]), []);
  assert.deepEqual(keys([git('S21', 'ls-tree', '-r', H1, 'lib/db/migrations')]), [], 'only the first argument of ls-tree is a revision');
  assert.deepEqual(keys([git('S22', 'archive', H1, 'lib/db')]), []);
  assert.deepEqual(keys([git('S23', 'log', '-3', H1, 'reports/SPEND.md')]), [], 'a file extension marks a path');
  assert.deepEqual(keys([git('S24', 'log', '-3', H1, 'lib/db/')]), [], 'a trailing slash marks a path');
  assert.deepEqual(keys([git('S25', 'diff', H1, H2, 'lib/a.ts')]), []);
  assert.deepEqual(keys([git('S26', 'diff-tree', '-r', H1, H2)]), []);
  assert.deepEqual(keys([git('S27', 'diff-tree', '-r', H1, 'lib/a.ts')]), []);
  // a moving revision next to a path is still caught
  assert.match(keys([git('S28', 'log', H1, 'origin/main', 'reports/SPEND.md')])[0], /"origin\/main" is not a full commit hash/);
  assert.match(keys([git('S29', 'ls-tree', 'main', 'lib/db/')])[0], /"main" is not a full commit hash/);
  assert.match(keys([git('S30', 'ls-tree', '-r', 'lib/db/')])[0], /"lib\/db\/"|no pinned commit/, 'a path alone is the revision of ls-tree: git would refuse it, but the lint does not call it pinned');
});

test('a path that exists in the -C folder is a path; git diff with one commit compares with the working tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plpath-'));
  try {
    fs.mkdirSync(path.join(dir, 'docs'));
    const g = (...a) => ({ id: 'S1', kind: 'command', cmd: 'git', args: ['-C', dir.split(path.sep).join('/'), ...a] });
    assert.deepEqual(keys([g('log', '-2', H1, 'docs')]), []);
    assert.match(keys([g('log', '-2', H1, 'nope')])[0], /"nope" is not a full commit hash/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(keys([git('S1', 'diff', H1)])[0], /git diff with one revision compares it with the working tree/);
  assert.match(keys([git('S2', 'diff', '--stat', H1, '--', 'a.txt')])[0], /one revision/);
  assert.deepEqual(keys([git('S3', 'diff', `${H1}..${H2}`)]), []);
  assert.deepEqual(keys([git('S4', 'diff', H1, H2)]), []);
});

test('the program may be given as a full path, and git inside sh -c / powershell -Command is linted', () => {
  const one = (cmd, args) => keys([{ id: 'S1', kind: 'command', cmd, args }]);
  assert.match(one('C:/Program Files/Git/cmd/git.exe', ['-C', 'r', 'log', '-4', 'origin/x'])[0], /"origin\/x"/);
  assert.match(one('C:\\Program Files\\Git\\cmd\\git.exe', ['-C', 'r', 'log', '-4', 'origin/x'])[0], /"origin\/x"/);
  assert.match(one('sh', ['-c', 'git -C r log -4 origin/x'])[0], /"origin\/x"/);
  assert.match(one('/bin/bash', ['-lc', 'cd r && git log -4 main'])[0], /"main"/);
  assert.match(one('powershell', ['-NoProfile', '-Command', 'git', '-C', 'r', 'show', 'HEAD:a.txt'])[0], /"HEAD"/);
  assert.deepEqual(one('sh', ['-c', `git -C r show ${H1}:a.txt`]), []);
  assert.deepEqual(one('sh', ['-c', 'echo hello']), []);
});

test('an abbreviated hash of 7+ characters is a hint (does not need the owner), a shorter one is a problem', () => {
  const out = movingTargetProblems([git('S1', 'show', '10d8d4a:reports/SPEND.md'), git('S2', 'show', '10d8:a.txt')], none);
  assert.equal(out[0].hint, true);
  assert.equal(out[1].hint, undefined);
});

test('a value of an option is not mistaken for a revision (-n 4, --format x), and paths after -- are paths', () => {
  assert.deepEqual(keys([git('S1', 'log', '-n', '4', '--format', '%h %s', H1, '--', 'lib/a.ts')]), []);
  assert.deepEqual(keys([git('S2', 'show', H1, '--', 'HEAD')]), []);
});

test('a file source or a data file inside a git working tree is flagged; the script an interpreter runs is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plmt-'));
  try {
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repo', 'reports'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    const spend = path.join(root, 'repo', 'reports', 'SPEND.md');
    const script = path.join(root, 'repo', 'tools', 'check.mjs');
    const data = path.join(root, 'repo', 'reports', 'data.json');
    const outside = path.join(root, 'plain', 'prices.txt');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    for (const f of [spend, script, data, outside]) fs.writeFileSync(f, 'x');
    assert.equal(gitRootOf(spend), path.join(root, 'repo'));
    assert.equal(gitRootOf(outside), null);
    const out = movingTargetProblems([
      { id: 'S29', kind: 'file', path: spend, expect: 'nonempty' },
      { id: 'S30', kind: 'file', path: outside },
      { id: 'S31', kind: 'command', cmd: 'node', args: [script, data] },
      { id: 'S32', kind: 'command', cmd: 'node', args: [script, outside] },
    ]);
    assert.deepEqual(out.map((p) => p.id), ['S29', 'S31']);
    assert.match(out[0].key, /lies inside the git working tree/);
    assert.match(out[0].suggest, /show <full-commit-hash>:reports\/SPEND\.md/);
    assert.ok(out[1].key.includes('data.json') && !out[1].key.includes('check.mjs'), 'the data file is flagged, the script is not');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('summariseSourceAttempts: attempts, outcomes and the excerpt; an unavailable attempt without an excerpt does not count', () => {
  const s = summariseSourceAttempts([
    { sourceId: 'S3', command: 'a', outcome: 'unavailable', result: 'http 429' },
    { sourceId: 'S3', command: 'b', outcome: 'unavailable', result: '  ' },
    { sourceId: 'S3', command: 'c', result: 'http 200 {"x":1}' },
    { sourceId: 'S3', command: 'd', outcome: 'ok', result: 'range 10-20' },
    { sourceId: 'S4', command: 'e', outcome: 'unavailable', result: 'timed out' },
    { command: 'no source id', result: 'x' },
  ]);
  assert.deepEqual(s, [
    { sourceId: 'S3', attempts: 3, ok: 2, unavailable: 1, excerpt: 'http 429' },
    { sourceId: 'S4', attempts: 1, ok: 0, unavailable: 1, excerpt: 'timed out' },
  ]);
  assert.deepEqual(summariseSourceAttempts(undefined), []);
});

test('summariseSourceAttempts: an entry without outcome whose result is an error status counts as unavailable', () => {
  const s = summariseSourceAttempts([
    { sourceId: 'S3', command: 'a', result: 'HTTP 429 Too Many Requests' },
    { sourceId: 'S3', command: 'b', result: '503 Service Unavailable' },
    { sourceId: 'S3', command: 'c', result: 'throttled by Google' },
    { sourceId: 'S3', command: 'd', result: 'http 200 {"x":1}' },
    { sourceId: 'S3', command: 'e', outcome: 'ok', result: '404 page text the claim was about' },
  ]);
  assert.deepEqual(s, [{ sourceId: 'S3', attempts: 5, ok: 2, unavailable: 3, excerpt: 'HTTP 429 Too Many Requests' }]);
});

test('sourceMinimumRescue: enough attempts with one unavailable rescue a not-done source-check item; other kinds never', () => {
  const at = (attempts, unavailable) => new Map([['S3', { sourceId: 'S3', attempts, ok: attempts - unavailable, unavailable, excerpt: 'x' }]]);
  const m = { id: 'M5', kind: 'source-check', sourceId: 'S3', count: 6 };
  assert.ok(sourceMinimumRescue(m, at(6, 6)));
  assert.ok(sourceMinimumRescue(m, at(6, 1)));
  assert.equal(sourceMinimumRescue(m, at(5, 5)), null, 'fewer attempts than count');
  assert.equal(sourceMinimumRescue(m, at(6, 0)), null, 'no unavailable attempt: the reviewer simply did not do it');
  assert.equal(sourceMinimumRescue({ ...m, kind: 'action' }, at(6, 6)), null);
  assert.equal(sourceMinimumRescue(m, new Map()), null);
});

// ---------------------------------------------------------------- setup and amend

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plgit-'));
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'plhk-'));
  const run = (...a) => {
    const r = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', dir, ...a], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello from a pinned commit\n');
  run('add', '.');
  run('commit', '-q', '-m', 'one');
  return { dir: dir.replace(/\\/g, '/'), full: run('rev-parse', 'HEAD'), cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(hooks, { recursive: true, force: true }); } };
}

const gitProbe = spawnSync('git', ['--version'], { windowsHide: true });

test('setup: a recipe on a moving ref stops the first step with the pinned form; the owner\'s words keep it; the pinned form passes', { skip: gitProbe.status !== 0 }, async () => {
  const repo = tempRepo();
  try {
    await withEnv(async (env) => {
      const r = await freshRun(env);
      const sp = path.join(r.runDir, 'sources.json');
      const src = readJsonFile(sp);
      const make = (id, rev) => ({ id, what: `A file of the repository (${id})`, origin: 'A local clone of the booking repository.', kind: 'command', cmd: 'git', args: ['-C', repo.dir, 'show', `${rev}:hello.txt`], expect: 'contains:hello' });
      src.sources.push(make('S3', repo.full), make('S4', 'HEAD'));
      fs.writeFileSync(sp, JSON.stringify(src));

      const first = await drive(r.runDir, { script: loadScript() });
      assert.equal(first.last.exitCode, 20, first.last.text);
      assert.match(first.last.text, /can change during the run/);
      assert.match(first.last.text, /source S4: git revision "HEAD" is not a full commit hash/);
      assert.match(first.last.text, /rev-parse HEAD/);
      assert.doesNotMatch(first.last.text, /source S3:/, 'the pinned recipe is not flagged');
      assert.equal(ledgerOf(r.runDir).some((e) => e.type === 'sources-baseline'), false, 'nothing is baselined before the flagged recipe is settled');

      // the preview warns without failing
      const pv = await cli(['sources', 'check', r.runDir]);
      assert.equal(pv.exitCode, 0, pv.text);
      assert.match(pv.text, /WARN S4/);
      assert.doesNotMatch(pv.text, /WARN S3/);

      const kept = await drive(r.runDir, { script: loadScript(), stepArgs: ['--owner-quote', 'Оставь ссылку на HEAD, я знаю, что она может сдвинуться', '--question', 'Источник S4 читает HEAD, а он сдвигается во время работы. Оставить его так?'] });
      assert.equal(kept.last.exitCode, 20, kept.last.text);
      assert.equal(kept.last.state, 'READY', 'setup froze on the owner\'s words');
      const dec = readJsonFile(path.join(r.runDir, 'owner-decisions.json')).decisions.find((d) => d.kind === 'moving-sources');
      assert.ok(dec, 'the decision is recorded with the owner\'s words');
      assert.deepEqual(dec.narrowing, ['source S4: git revision "HEAD" is not a full commit hash']);
      assert.match(dec.quote, /Оставь ссылку на HEAD/);
      const pv2 = await cli(['sources', 'check', r.runDir]);
      assert.match(pv2.text, /WARN S4.*kept on the owner's words/);

      // amend: a new moving recipe needs the owner's words, the pinned one does not
      const next = readJsonFile(sp);
      next.sources.push(make('S5', 'main'));
      const nf = path.join(env.workspace, 'sources-moving.json');
      fs.writeFileSync(nf, JSON.stringify(next));
      const refused = await cli(['amend', r.runDir, '--what', 'sources', '--file', nf, '--reason', 'one more source']);
      assert.equal(refused.exitCode, 4);
      assert.match(refused.payload.error.message, /source S5: git revision "main" is not a full commit hash/);
      assert.match(refused.payload.error.message, /Fix: pin it/);
      const pinned = readJsonFile(sp);
      pinned.sources.push(make('S5', repo.full));
      fs.writeFileSync(nf, JSON.stringify(pinned));
      const ok = await cli(['amend', r.runDir, '--what', 'sources', '--file', nf, '--reason', 'one more source, pinned']);
      assert.equal(ok.exitCode, 0, ok.text);
      // an abbreviated hash of 8 characters is only a hint: it needs no owner words, and `sources check` shows a HINT line
      const abbr = readJsonFile(sp);
      abbr.sources.push(make('S7', repo.full.slice(0, 8)));
      fs.writeFileSync(nf, JSON.stringify(abbr));
      const hinted = await cli(['amend', r.runDir, '--what', 'sources', '--file', nf, '--reason', 'an abbreviated hash']);
      assert.equal(hinted.exitCode, 0, hinted.text);
      const pv3 = await cli(['sources', 'check', r.runDir]);
      assert.match(pv3.text, /HINT S7/);
      // S4 was kept on the owner's words and is not touched by this amendment: no second quote needed
      const again = readJsonFile(sp);
      again.sources.push(make('S6', 'main'));
      fs.writeFileSync(nf, JSON.stringify(again));
      const withWords = await cli(['amend', r.runDir, '--what', 'sources', '--file', nf, '--reason', 'keep main', '--owner-quote', 'Да, main тоже оставляем как есть, пусть двигается', '--question', 'Источник S6 читает ветку main, она сдвигается. Оставить?']);
      assert.equal(withWords.exitCode, 0, withWords.text);
      assert.ok(withWords.payload.narrowing.some((x) => /source S6: git revision "main"/.test(x)));
    });
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------- the answer checker


test('check-answer: outcome "unavailable" needs the status or error in result; "ok" and no outcome do not', () => {
  const bad = crossFieldRules({ sourceChecks: [{ sourceId: 'S3', command: 'x', outcome: 'unavailable', result: ' ' }] });
  assert.deepEqual(bad.map((e) => e.path), ['/sourceChecks/0/result']);
  assert.match(bad[0].message, /HTTP 429/);
  assert.deepEqual(crossFieldRules({ sourceChecks: [{ sourceId: 'S3', command: 'x', outcome: 'unavailable', result: 'HTTP 429' }] }), []);
  assert.deepEqual(crossFieldRules({ sourceChecks: [{ sourceId: 'S3', command: 'x', outcome: 'ok', result: '' }, { sourceId: 'S3', command: 'y', result: '' }] }), []);
});
