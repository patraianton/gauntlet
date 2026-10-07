// P5: templates/MANIFEST.json and templates/update-manifest.mjs (SPEC 15.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TEMPLATES, readJson } from '../fixtures/templates/helpers.mjs';

const manifest = readJson(join(TEMPLATES, 'MANIFEST.json'));

test('MANIFEST.json has the SPEC shape', () => {
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version, /^[0-9]+$/);
  assert.equal(typeof manifest.files, 'object');
});

test('MANIFEST.json lists every template file and nothing else', () => {
  const onDisk = readdirSync(TEMPLATES).filter((f) => f !== 'MANIFEST.json' && f !== 'update-manifest.mjs').sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), onDisk);
});

test('every hash in MANIFEST.json matches the file (BOM-stripped, LF)', () => {
  for (const [name, sha] of Object.entries(manifest.files)) {
    let text = readFileSync(join(TEMPLATES, name), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const h = createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    assert.equal(h, sha, `${name} changed without running update-manifest.mjs`);
  }
});

test('template files are UTF-8 without BOM and with LF line endings', () => {
  for (const name of Object.keys(manifest.files)) {
    const buf = readFileSync(join(TEMPLATES, name));
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${name} has a BOM`);
    assert.ok(!buf.includes(Buffer.from('\r\n')), `${name} has CRLF`);
  }
});

test('update-manifest.mjs --check passes on the repo', () => {
  const r = spawnSync(process.execPath, [join(TEMPLATES, 'update-manifest.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('update-manifest.mjs: detects a change, bumps the version, and a CRLF copy hashes the same', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-p5-tpl-'));
  try {
    for (const f of readdirSync(TEMPLATES)) copyFileSync(join(TEMPLATES, f), join(dir, f));
    const script = join(dir, 'update-manifest.mjs');
    const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8', windowsHide: true });

    // CRLF + BOM must not count as a change.
    const sev = readFileSync(join(dir, 'severity.md'), 'utf8');
    writeFileSync(join(dir, 'severity.md'), '﻿' + sev.replace(/\n/g, '\r\n'), 'utf8');
    assert.equal(run('--check').status, 0, 'CRLF/BOM should hash like LF');

    writeFileSync(join(dir, 'severity.md'), sev + 'Extra line.\n', 'utf8');
    const c = run('--check');
    assert.equal(c.status, 1);
    assert.match(c.stdout, /changed: severity\.md/);

    const before = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
    const u = run();
    assert.equal(u.status, 0, u.stdout + u.stderr);
    const after = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
    assert.equal(after.version, String(Number(before.version) + 1));
    assert.notEqual(after.files['severity.md'], before.files['severity.md']);
    assert.equal(run('--check').status, 0);

    // Unchanged files: no rewrite, no bump.
    const again = run();
    assert.match(again.stdout, /up to date/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')).version, after.version);

    // A new file is listed as added.
    writeFileSync(join(dir, 'extra.md'), 'x\n');
    assert.match(run('--check').stdout, /added: extra\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
