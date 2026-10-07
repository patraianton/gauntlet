import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAllowed, resolveExecutable, isAllowed } from '../../lib/core/proc.mjs';
import { UsageError } from '../../lib/core/errors.mjs';
import { tempDir, rmTemp, REPO } from './_helpers.mjs';

const ALLOW = ['node', 'git'];

test('runs an allowlisted executable and captures output', () => {
  const r = runAllowed({ cmd: 'node', args: ['-e', 'process.stdout.write("привет"); process.stderr.write("e"); process.exit(3)'], allow: ALLOW });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, 'привет');
  assert.equal(r.stderr, 'e');
  assert.equal(r.timedOut, false);
  assert.ok(path.isAbsolute(r.resolved));
});

test('refuses executables that are not on the allowlist, paths, and an empty allowlist', () => {
  assert.throws(() => runAllowed({ cmd: 'powershell', args: [], allow: ALLOW }), UsageError);
  assert.throws(() => runAllowed({ cmd: 'cmd', args: ['/c', 'echo hi'], allow: ALLOW }), UsageError);
  assert.throws(() => runAllowed({ cmd: 'node', args: [], allow: [] }), UsageError);
  assert.throws(() => runAllowed({ cmd: 'node', args: [] }), UsageError);
  assert.throws(() => runAllowed({ cmd: process.execPath, args: [], allow: [process.execPath] }), UsageError);
  assert.throws(() => runAllowed({ cmd: './node', args: [], allow: ['./node'] }), UsageError);
  assert.throws(() => runAllowed({ cmd: 'node', args: [1], allow: ALLOW }), UsageError);
});

test('never uses a shell: metacharacters reach the program as literal arguments', (t) => {
  const d = tempDir('proc');
  t.after(() => rmTemp(d));
  const marker = path.join(d, 'pwned.txt');
  const tricky = ['a & echo x > ' + marker, '| type nul', '$(whoami)', '`id`', '%PATH%', 'q"uote', 'space d'];
  const r = runAllowed({ cmd: 'node', args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky], allow: ALLOW });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout), tricky);
  assert.ok(!fs.existsSync(marker));
  const src = fs.readFileSync(path.join(REPO, 'lib', 'core', 'proc.mjs'), 'utf8');
  assert.match(src, /shell:\s*false/);
  assert.match(src, /windowsHide:\s*true/);
  assert.ok(!/shell:\s*true/.test(src));
  assert.ok(!/\bexecSync\b|\bexec\(/.test(src));
});

test('timeout, output cap, env and cwd', (t) => {
  const d = tempDir('proc2');
  t.after(() => rmTemp(d));
  const slow = runAllowed({ cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 10000)'], allow: ALLOW, timeoutS: 0.5 });
  assert.equal(slow.timedOut, true);
  const big = runAllowed({ cmd: 'node', args: ['-e', 'process.stdout.write("x".repeat(50000))'], allow: ALLOW, maxBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.ok(big.stdout.length <= 1000);
  const env = runAllowed({ cmd: 'node', args: ['-e', 'process.stdout.write(process.env.BLIND + "|" + process.cwd())'], allow: ALLOW, env: { BLIND: '1' }, cwd: d });
  const [blind, cwd] = env.stdout.split('|');
  assert.equal(blind, '1');
  assert.equal(fs.realpathSync(cwd).toLowerCase(), fs.realpathSync(d).toLowerCase());
});

test('isAllowed: case-insensitive with .exe on win32 only', () => {
  assert.ok(isAllowed('NODE.exe', ['node'], { platform: 'win32' }));
  assert.ok(!isAllowed('NODE', ['node'], { platform: 'darwin' }));
  assert.ok(!isAllowed('nodejs', ['node'], { platform: 'win32' }));
});

test('PATHEXT resolution on win32 and batch-only refusal', { skip: process.platform !== 'win32' }, (t) => {
  const d = tempDir('pathext');
  t.after(() => rmTemp(d));
  fs.writeFileSync(path.join(d, 'tool.cmd'), '@echo hi');
  fs.copyFileSync(process.execPath, path.join(d, 'mynode.exe'));
  const env = { PATH: d, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveExecutable('mynode', { env }).toLowerCase(), path.join(d, 'mynode.exe').toLowerCase());
  assert.equal(resolveExecutable('MyNode.EXE', { env }).toLowerCase(), path.join(d, 'mynode.exe').toLowerCase());
  assert.throws(() => resolveExecutable('tool', { env }), /batch file/);
  assert.throws(() => resolveExecutable('absent', { env }), /not found/);
  const r = runAllowed({ cmd: 'mynode', args: ['-e', 'process.stdout.write("ok")'], allow: ['mynode'], env: { PATH: d } });
  assert.equal(r.stdout, 'ok');
});
