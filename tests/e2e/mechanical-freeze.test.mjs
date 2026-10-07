// Bug 13 end to end: a malformed mechanical check stops setup BEFORE the lens writer is briefed and
// before anything is frozen (no owner words needed), and the same shape check guards `amend --what mechanical`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, readyRun, freshRun, cli, drive, loadScript, readJsonFile, stateOf, ledgerOf } from '../fixtures/engine/helpers.mjs';

const K1K2 = {
  schemaVersion: 1,
  checks: [
    { id: 'K1', what: 'the plan exists', severity: 'blocker', kind: 'file-exists', glob: 'content/plan.json' },
    { id: 'K2', what: 'the page exists', severity: 'blocker', kind: 'file-exists', glob: 'content/page.md' },
  ],
};
const GOOD = {
  schemaVersion: 1,
  checks: [
    { id: 'K1', what: 'plan.json is valid JSON', severity: 'blocker', kind: 'json-valid', glob: 'content/plan.json' },
    { id: 'K2', what: 'the plan has exactly 12 posts', severity: 'blocker', kind: 'count', glob: 'content/plan.json', pointer: '/posts', op: '=', value: 12 },
  ],
};
const write = (runDir, obj) => fs.writeFileSync(path.join(runDir, 'mechanical.json'), JSON.stringify(obj, null, 2));

test('setup: file-exists checks with "glob" (a real night run) are refused at the first step, not at round 1', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    write(r.runDir, K1K2);
    const a = await cli(['step', r.runDir]);
    assert.equal(a.exitCode, 20, a.text);
    assert.equal(stateOf(r.runDir).state, 'NEW', 'nothing was issued or frozen');
    assert.match(a.text, /K1: kind "file-exists" has the field "glob"/);
    assert.match(a.text, /use "path": "content\/plan\.json"/);
    assert.match(a.text, /K2: .*use "path": "content\/page\.md"/);
    assert.match(a.text, /no owner words are needed before freeze/);
    assert.equal(fs.existsSync(path.join(r.runDir, 'FROZEN.json')), false);
    assert.equal(ledgerOf(r.runDir).some((l) => l.type === 'lens-writer-issued'), false, 'the lens writer was not briefed');

    // the window fixes its own file, steps again, and setup goes through to the freeze
    write(r.runDir, { schemaVersion: 1, checks: K1K2.checks.map(({ glob, ...c }) => ({ ...c, path: glob })) });
    const d = await drive(r.runDir, { script: loadScript() });
    assert.equal(d.last.exitCode, 20, d.last.text);
    assert.equal(d.last.state, 'READY');
    assert.ok(fs.existsSync(path.join(r.runDir, 'FROZEN.json')));
  });
});

test('setup: a path that is not in the material, a glob that matches nothing and a command outside the allowlist are refused with the fix', async () => {
  await withEnv(async (env) => {
    const r = await freshRun(env);
    write(r.runDir, {
      schemaVersion: 1,
      checks: [
        { id: 'K1', what: 'x', severity: 'blocker', kind: 'file-exists', path: 'content/missing.md' },
        { id: 'K2', what: 'x', severity: 'major', kind: 'no-forbidden-text', glob: 'docs/**/*.md', patterns: ['TODO', '(open'] },
        { id: 'K3', what: 'x', severity: 'major', kind: 'command', cmd: 'powershell', args: ['-c', 'echo hi'] },
        { id: 'K4', what: 'x', severity: 'major', kind: 'frobnicate' },
      ],
    });
    const a = await cli(['step', r.runDir]);
    assert.equal(a.exitCode, 20, a.text);
    assert.match(a.text, /K1: file-exists path "content\/missing\.md" is not a file in the material/);
    assert.match(a.text, /K2: patterns\[1\] "\(open" is not a valid regular expression/);
    assert.match(a.text, /K3: command "powershell" is refused/);
    assert.match(a.text, /K4: "kind" "frobnicate" is not a known kind/);
    assert.equal(stateOf(r.runDir).state, 'NEW');
  });
});

test('setup: the untouched fixture mechanical.json still freezes', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    assert.equal(stateOf(r.runDir).state, 'READY');
  });
});

test('amend --what mechanical: the same shape check applies after freeze (exit 4, nothing written)', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    const before = fs.readFileSync(path.join(r.runDir, 'mechanical.json'), 'utf8');
    const bad = path.join(env.workspace, 'mech-bad.json');
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, checks: [...GOOD.checks, { id: 'K3', what: 'the page exists', severity: 'blocker', kind: 'file-exists', glob: 'content/page.md' }] }));
    const a = await cli(['amend', r.runDir, '--what', 'mechanical', '--file', bad, '--reason', 'one more check']);
    assert.equal(a.exitCode, 4, a.text);
    assert.match(a.payload.error.message, /K3: kind "file-exists" has the field "glob".*use "path": "content\/page\.md"/);
    assert.equal(fs.readFileSync(path.join(r.runDir, 'mechanical.json'), 'utf8'), before, 'the frozen file is untouched');

    // a sound extra check is a widening: no owner words
    const good = path.join(env.workspace, 'mech-good.json');
    fs.writeFileSync(good, JSON.stringify({ schemaVersion: 1, checks: [...GOOD.checks, { id: 'K3', what: 'the page exists', severity: 'blocker', kind: 'file-exists', path: 'content/page.md' }] }));
    const b = await cli(['amend', r.runDir, '--what', 'mechanical', '--file', good, '--reason', 'one more check']);
    assert.equal(b.exitCode, 0, b.text);
    assert.equal(readJsonFile(path.join(r.runDir, 'mechanical.json')).checks.length, 3);
  });
});

test('amend --what mechanical: a kept check is not refused because the material changed; removing one still needs the owner', async () => {
  await withEnv(async (env) => {
    const r = await readyRun(env);
    // the page is deleted from the live material after freeze; K1/K2 (plan.json) stay as frozen
    const good = path.join(env.workspace, 'mech-keep.json');
    fs.writeFileSync(good, JSON.stringify({ schemaVersion: 1, checks: [...GOOD.checks, { id: 'K3', what: 'the page exists', severity: 'cosmetic', kind: 'file-exists', path: 'content/page.md' }] }));
    assert.equal((await cli(['amend', r.runDir, '--what', 'mechanical', '--file', good, '--reason', 'add K3'])).exitCode, 0);
    fs.rmSync(path.join(r.project.material, 'page.md'), { force: true });
    const more = path.join(env.workspace, 'mech-keep2.json');
    fs.writeFileSync(more, JSON.stringify({ schemaVersion: 1, checks: [...GOOD.checks, { id: 'K3', what: 'the page exists', severity: 'cosmetic', kind: 'file-exists', path: 'content/page.md' }, { id: 'K4', what: 'plan is valid', severity: 'cosmetic', kind: 'json-valid' }] }));
    const ok = await cli(['amend', r.runDir, '--what', 'mechanical', '--file', more, '--reason', 'add K4']);
    assert.equal(ok.exitCode, 0, ok.text);
    // dropping K3 is narrowing: owner words
    const less = path.join(env.workspace, 'mech-less.json');
    fs.writeFileSync(less, JSON.stringify(GOOD));
    const no = await cli(['amend', r.runDir, '--what', 'mechanical', '--file', less, '--reason', 'drop']);
    assert.notEqual(no.exitCode, 0);
    assert.match(no.text + JSON.stringify(no.payload), /mechanical check K[34] removed or changed/);
  });
});
