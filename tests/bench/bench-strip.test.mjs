// The shipped bench settings (bench/strip.json) on the shipped synthetic bench material (SPEC 21.4, runbook 7):
// the strip preview must give a clean copy with no narrowing, and every planted error of the fixed
// key must still occur exactly once. The material is the synthetic bakery example in bench/material/bakery;
// the test is skipped only if GAUNTLET_BENCH_MATERIAL points at a folder that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { copyFiles, listFiles } from '../../lib/core/fsx.mjs';
import { applyStrip } from '../../lib/material/strip.mjs';
import { loadPatterns, scanTrace } from '../../lib/material/lint.mjs';
import { stripNarrowing, allowNarrowingLine } from '../../lib/engine/strip-preview.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATERIAL = process.env.GAUNTLET_BENCH_MATERIAL ?? fileURLToPath(new URL('../../bench/material/bakery', import.meta.url)); // the shipped synthetic bench material; GAUNTLET_BENCH_MATERIAL points at another copy
const strip = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'strip.json'), 'utf8'));
const key = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'bakery.key.json'), 'utf8'));

test('bench/strip.json and bench/sources.json are valid settings files', () => {
  assert.ok(validate(loadSchema('strip'), strip).ok);
  const src = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'sources.json'), 'utf8'));
  const v = validate(loadSchema('sources'), src);
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('bench strip on the bakery material: no trace left, nothing narrowed, every planted error intact', { skip: !fs.existsSync(MATERIAL) && 'the bench material is not on this machine' }, () => {
  const patterns = loadPatterns('trace');
  // the only narrowing is the allow list itself, which always needs the owner's words (r3-f1)
  const nar = stripNarrowing(MATERIAL, strip, { patterns });
  assert.deepEqual(nar.narrowing, strip.traceAllow.map(allowNarrowingLine));
  assert.ok(nar.allow.every((a) => a.matches > 0), 'every allow phrase occurs in the material');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-bench-'));
  try {
    copyFiles(MATERIAL, listFiles(MATERIAL), tmp);
    const res = applyStrip(tmp, strip);
    assert.deepEqual(res.violations, []);
    const hits = scanTrace(tmp, patterns, strip.traceAllow);
    assert.deepEqual(hits.map((h) => `${h.file}:${h.line} ${h.text}`), []);
    for (const c of key.canaries) {
      if (String(c.after).startsWith('sha256:')) continue;
      const text = fs.readFileSync(path.join(tmp, ...c.file.split('/')), 'utf8');
      assert.equal(text.split(c.after).length - 1, 1, `${c.canary} must occur exactly once`);
    }
    JSON.parse(fs.readFileSync(path.join(tmp, 'content-plan', 'page_text.json'), 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
