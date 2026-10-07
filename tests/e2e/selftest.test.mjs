// The offline selftest scenario (SPEC 21.3) end to end, plus the CLI entry in a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScenario, cutProgramPath } from '../../lib/selftest/scenarios.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('selftest scenario: every assertion passes and the temp workspace is removed', async () => {
  const res = await runScenario({});
  const failed = res.results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.ok(res.results.length >= 25);
  assert.equal(fs.existsSync(res.env.root), false);
});

test('CLI child process: --json prints exactly one envelope; exit codes map', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'plcli-'));
  try {
    const env = { ...process.env, GAUNTLET_DATA: data };
    const doc = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gauntlet.mjs'), 'doctor', '--json'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(doc.status, 0, doc.stdout + doc.stderr);
    const envl = JSON.parse(doc.stdout);
    assert.deepEqual(Object.keys(envl).sort(), ['command', 'exitCode', 'ok', 'payload', 'sig', 'state']);
    assert.equal(envl.command, 'doctor');
    const bad = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gauntlet.mjs'), 'status', path.join(data, 'nope'), '--json'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(bad.status, 4);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    const unknown = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gauntlet.mjs'), 'frobnicate'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(unknown.status, 4);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('cutProgramPath cuts the path of the program in every spelling (D6)', () => {
  const dir = 'C:\\Users\\jdoe\\x-canary\\integration';
  assert.equal(cutProgramPath('node C:\\Users\\jdoe\\x-canary\\integration\\bin\\p.mjs fix', dir), 'node <program>\\bin\\p.mjs fix');
  assert.equal(cutProgramPath('node c:/users/JDOE/x-canary/integration/bin/p.mjs', dir), 'node <program>/bin/p.mjs');
  assert.equal(cutProgramPath('"C:\\\\Users\\\\jdoe\\\\x-canary\\\\integration\\\\bin"', dir), '"<program>\\\\bin"');
  assert.equal(cutProgramPath('x-canary stays when it is not the program path', dir), 'x-canary stays when it is not the program path');
  assert.equal(cutProgramPath('/home/a/b/c/x', '/home/a/b'), '<program>/c/x');
});
