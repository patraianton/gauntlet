import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { checkSources, checkExpect, touchesNotes, recipeShapeProblem, SOURCE_MAX_BYTES, SOURCE_TIMEOUT_S } from '../../lib/material/sources.mjs';
import { runMechanical } from '../../lib/material/mechanical.mjs';
import { tmpDir, put, makeMaterial } from '../fixtures/material/helpers.mjs';

const ALLOW = ['node'];

/** A script file outside every author folder (inline `node -e` code is refused as a source). */
function script(t, code) {
  const p = path.join(tmpDir(t), `s${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(p, code);
  return p;
}

test('sources: an allowlisted node script recipe runs and is recorded', (t) => {
  const [r] = checkSources(
    { sources: [{ id: 'S1', what: 'price list', kind: 'command', cmd: 'node', args: [script(t, 'console.log(JSON.stringify({prices:[1,2,3]}))')], expect: 'json:prices>=3' }] },
    { allow: ALLOW, notesAbs: [] },
  );
  assert.equal(r.id, 'S1');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.exitCode, 0);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.bytes > 0);
  assert.ok(r.sample.startsWith('{"prices"'));
  assert.equal(r.error, null);
});

test('sources: expect rules, non-zero exit and empty output fail', (t) => {
  const run = (src) => checkSources([{ id: 'S1', what: 'x', kind: 'command', cmd: 'node', ...src }], { allow: ALLOW })[0];
  assert.equal(run({ args: [script(t, 'console.log("hello world")')], expect: 'contains:world' }).ok, true);
  assert.equal(run({ args: [script(t, 'console.log("hello")')], expect: 'contains:world' }).ok, false);
  assert.equal(run({ args: [script(t, 'process.exit(0)')] }).ok, false, 'default expect is nonempty');
  const failed = run({ args: [script(t, 'console.error("boom"); process.exit(3)')] });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.match(failed.error, /exit code 3/);
  assert.equal(checkExpect('json:a.b=2', '{"a":{"b":2}}'), null);
  assert.equal(checkExpect('json:items.length>1', '{"items":[1,2]}'), null);
  assert.equal(checkExpect('json:items<2', '{"items":[1,2]}') === null, false);
  assert.match(checkExpect('json:x>1', 'not json'), /not JSON/);
  assert.match(checkExpect('weird', 'x'), /unknown/);
});

test('sources: a non-allowlisted executable or a path is refused without running', () => {
  let called = false;
  const runner = () => {
    called = true;
    return { exitCode: 0, stdout: 'x' };
  };
  const res = checkSources(
    [
      { id: 'S1', kind: 'command', cmd: 'powershell', args: ['-c', 'echo hi'] },
      { id: 'S2', kind: 'command', cmd: 'C:\\Windows\\node.exe', args: [] },
    ],
    { allow: ALLOW, runner },
  );
  assert.equal(called, false);
  for (const r of res) {
    assert.equal(r.ok, false);
    assert.match(r.error, /refused/);
  }
});

test('sources: recipes that touch author notes are refused', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  const notes = path.join(root, 'AUTHOR-NOTES.md');
  const runner = () => ({ exitCode: 0, stdout: 'x' });
  const res = checkSources(
    [
      { id: 'S1', kind: 'file', path: notes },
      { id: 'S2', kind: 'command', cmd: 'node', args: ['-e', `require('fs').readFileSync(${JSON.stringify(notes.replace(/\\/g, '/'))})`] },
      { id: 'S3', kind: 'command', cmd: 'node', args: ['-e', "require('fs').readFileSync('AUTHOR-NOTES.md')"] },
      { id: 'S4', kind: 'command', cmd: 'node', args: ['scan.js', root] },
      { id: 'S5', kind: 'command', cmd: 'node', args: [`--file=${notes}`] },
      { id: 'S6', kind: 'command', cmd: 'node', args: [script(t, 'console.log(1)'), 'https://example.com/a/b'] },
    ],
    { allow: ALLOW, notesAbs: [notes], runner },
  );
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    assert.equal(byId[id].ok, false, id);
    assert.match(byId[id].error, /refused/, id);
  }
  assert.equal(byId.S6.ok, true, 'a URL argument is not a path');
  assert.equal(touchesNotes({ args: ['-e', 'x'] }, [notes]), null);
});

test('r2-f3: inline code, file: URLs, loopback hosts and a forbidden folder inside an argument are refused', () => {
  let called = false;
  const runner = () => {
    called = true;
    return { exitCode: 0, stdout: 'revenue: 12345' };
  };
  const proj = path.resolve('C:/tmp/proj-r2f3');
  const own = [{ path: proj, what: 'the project working folder' }];
  const facts = path.join(proj, 'FACTS-FOR-PANEL.md').replace(/\\/g, '/');
  const res = checkSources(
    [
      { id: 'S1', kind: 'command', cmd: 'curl', args: ['-s', `file:///${facts}`] },
      { id: 'S2', kind: 'command', cmd: 'node', args: ['-e', `process.stdout.write(require('fs').readFileSync('${facts}','utf8'))`] },
      { id: 'S3', kind: 'command', cmd: 'node', args: ['-p', '12345'] },
      { id: 'S4', kind: 'command', cmd: 'python', args: ['-c', 'print(12345)'] },
      { id: 'S5', kind: 'command', cmd: 'curl', args: ['-s', 'http://127.0.0.1:8080/facts'] },
      { id: 'S6', kind: 'command', cmd: 'curl', args: ['-s', 'http://localhost/facts'] },
      { id: 'S7', kind: 'command', cmd: 'curl', args: ['-s', '-d', `@${facts}`, 'https://example.com/echo'] },
    ],
    { allow: ['curl', 'node', 'python'], forbiddenRoots: own, runner },
  );
  assert.equal(called, false, 'nothing ran');
  for (const r of res) assert.match(r.error, /^refused: /, r.id);
  assert.equal(recipeShapeProblem({ cmd: 'curl', args: ['-s', 'https://demo-project/api/search?category=widgets&name=blue'] }, own), null);
  assert.equal(recipeShapeProblem({ cmd: 'node', args: ['C:/elsewhere/price.mjs'] }, own), null);
});

test('sources: file sources by existence and size; timeouts and the 1 MiB cap', (t) => {
  const dir = tmpDir(t);
  const f = put(dir, 'prices.csv', 'a,b\n1,2\n');
  const empty = put(dir, 'empty.txt', '');
  const res = checkSources(
    [
      { id: 'S1', kind: 'file', path: f },
      { id: 'S2', kind: 'file', path: path.join(dir, 'missing.csv') },
      { id: 'S3', kind: 'file', path: empty },
      { id: 'S4', kind: 'file', path: 'relative.csv' },
    ],
    { allow: ALLOW },
  );
  assert.equal(res[0].ok, true);
  assert.equal(res[0].bytes, 8);
  assert.equal(res[1].ok, false);
  assert.equal(res[2].ok, false);
  assert.equal(res[3].ok, false);

  let seen = null;
  const big = 'x'.repeat(SOURCE_MAX_BYTES + 5000);
  const [capped] = checkSources([{ id: 'S1', kind: 'command', cmd: 'node', args: [] }], {
    allow: ALLOW,
    runner: (o) => {
      seen = o;
      return { exitCode: 0, stdout: big, stderr: '', timedOut: false };
    },
  });
  assert.equal(seen.timeoutS, SOURCE_TIMEOUT_S);
  assert.equal(seen.maxBytes, SOURCE_MAX_BYTES);
  assert.deepEqual(seen.allow, ALLOW);
  assert.equal(capped.bytes, SOURCE_MAX_BYTES);
  assert.equal(capped.sample.length, 300);

  const [slow] = checkSources([{ id: 'S1', kind: 'command', cmd: 'node', args: [] }], {
    allow: ALLOW,
    runner: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
  });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out/);
});

function snapshotWith(t) {
  const snap = tmpDir(t);
  makeMaterial(path.join(snap, 'content'));
  put(snap, 'content/broken.json', '{"a": ');
  return snap;
}

test('mechanical: json-valid, count (glob and pointer), file-exists, no-forbidden-text', (t) => {
  const snap = snapshotWith(t);
  const res = runMechanical(
    {
      checks: [
        { id: 'K1', what: 'plan parses', severity: 'blocker', kind: 'json-valid', glob: 'content/plan.json' },
        { id: 'K2', what: 'all json parses', severity: 'major', kind: 'json-valid' },
        { id: 'K3', what: '12 posts', severity: 'blocker', kind: 'count', glob: 'content/plan.json', pointer: '/posts', op: '=', value: 12 },
        { id: 'K4', what: 'at least 13 posts', severity: 'major', kind: 'count', glob: 'content/plan.json', pointer: '/posts', op: '>=', value: 13 },
        { id: 'K5', what: 'md files', severity: 'cosmetic', kind: 'count', glob: 'content/*.md', op: '<=', value: 2 },
        { id: 'K6', what: 'page exists', severity: 'blocker', kind: 'file-exists', path: 'content/page.md' },
        { id: 'K7', what: 'faq exists', severity: 'major', kind: 'file-exists', path: 'content/faq.md' },
        { id: 'K8', what: 'no lorem', severity: 'major', kind: 'no-forbidden-text', glob: 'content/**', patterns: ['lorem ipsum', 'TODO'] },
        { id: 'K9', what: 'no 49', severity: 'cosmetic', kind: 'no-forbidden-text', glob: 'content/*.md', patterns: ['49 EUR'] },
        { id: 'K10', what: 'bad', severity: 'cosmetic', kind: 'teleport' },
        { id: 'K11', what: 'nothing matches', severity: 'major', kind: 'json-valid', glob: 'nowhere/*.json' },
      ],
    },
    snap,
    { allow: ALLOW },
  );
  const ok = Object.fromEntries(res.map((r) => [r.id, r.ok]));
  assert.deepEqual(ok, { K1: true, K2: false, K3: true, K4: false, K5: true, K6: true, K7: false, K8: true, K9: false, K10: false, K11: false });
  const k2 = res.find((r) => r.id === 'K2');
  assert.ok(k2.details.some((d) => d.startsWith('content/broken.json')));
  assert.equal(k2.severity, 'major');
  assert.equal(k2.what, 'all json parses');
  assert.ok(res.find((r) => r.id === 'K9').details[0].startsWith('content/page.md:2:'));
  assert.match(res.find((r) => r.id === 'K4').details[0], /12 \(expected >= 13\)/);
});

test('mechanical: command checks run allowlisted with {snapshot}; stdout lines are details', (t) => {
  const snap = snapshotWith(t);
  const res = runMechanical(
    [
      { id: 'K1', what: 'pass', severity: 'major', kind: 'command', cmd: 'node', args: ['-e', "const fs=require('fs');process.exit(fs.existsSync(process.argv[1]+'/content/plan.json')?0:1)", '{snapshot}'] },
      { id: 'K2', what: 'fail', severity: 'blocker', kind: 'command', cmd: 'node', args: ['-e', 'console.log("post 3: no CTA");console.log("post 7: no CTA");process.exit(2)'] },
      { id: 'K3', what: 'refused', severity: 'blocker', kind: 'command', cmd: 'bash', args: ['-c', 'true'] },
    ],
    snap,
    { allow: ALLOW },
  );
  assert.equal(res[0].ok, true, res[0].details.join('; '));
  assert.equal(res[1].ok, false);
  assert.deepEqual(res[1].details, ['exit code 2', 'post 3: no CTA', 'post 7: no CTA']);
  assert.equal(res[2].ok, false);
  assert.match(res[2].details[0], /refused/);
});
