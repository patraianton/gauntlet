import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRng, NEUTRAL_ALPHABET, seededFromEnv, deriveSeed } from '../../lib/core/rand.mjs';
import { now, setClockForTests, runStamp, isoLocal, localDate } from '../../lib/core/clock.mjs';
import { dataHome, dataPaths, chainedFiles } from '../../lib/core/datahome.mjs';
import { UsageError, IntegrityError, StateError, exitCodeFor, INTEGRITY_CODES } from '../../lib/core/errors.mjs';
import { tempDir, rmTemp, REPO } from './_helpers.mjs';

test('errors carry exit codes 4 / 3 / 4 and integrity codes', () => {
  const u = new UsageError('bad', { x: 1 });
  const i = new IntegrityError('TAMPER', 'chain', { seq: 2 });
  const s = new StateError('illegal');
  assert.equal(exitCodeFor(u), 4);
  assert.equal(exitCodeFor(i), 3);
  assert.equal(exitCodeFor(s), 4);
  assert.equal(exitCodeFor(new Error('x')), 1);
  assert.equal(i.code, 'TAMPER');
  assert.deepEqual(u.details, { x: 1 });
  assert.deepEqual(INTEGRITY_CODES, ['TAMPER', 'FROZEN_MISMATCH', 'TEMPLATE_MISMATCH', 'PROMPT_LINT', 'COMMITMENT_MISMATCH', 'AUDIT_FAILED']);
  assert.ok(i instanceof Error && u instanceof Error && s instanceof Error);
});

test('rand: crypto by default, different every call, NEUTRAL_ALPHABET ids', () => {
  const env = {};
  const a = makeRng({ env });
  const b = makeRng({ env });
  assert.equal(a.seeded, false);
  assert.notEqual(a.seedHex, b.seedHex);
  assert.match(a.seedHex, /^[0-9a-f]{64}$/);
  assert.equal(NEUTRAL_ALPHABET, 'abcdefghjkmnpqrstuvwxyz23456789');
  const id = a.id(8);
  assert.match(id, /^[a-z2-9]{8}$/);
  for (const ch of id) assert.ok(NEUTRAL_ALPHABET.includes(ch));
  assert.match(a.id(4, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'), /^[A-Z2-9]{4}$/);
});

test('rand: seeded mode only with GAUNTLET_TEST=1 AND GAUNTLET_SEED', () => {
  assert.equal(seededFromEnv({ GAUNTLET_SEED: 'abc' }), false);
  assert.equal(seededFromEnv({ GAUNTLET_TEST: '1' }), false);
  assert.equal(seededFromEnv({ GAUNTLET_TEST: '1', GAUNTLET_SEED: 'abc' }), true);
  const notSeeded = makeRng({ env: { GAUNTLET_SEED: 'abc' } });
  assert.equal(notSeeded.seeded, false);
  const s1 = makeRng({ env: { GAUNTLET_TEST: '1', GAUNTLET_SEED: 'feed' } });
  const s2 = makeRng({ env: { GAUNTLET_TEST: '1', GAUNTLET_SEED: 'feed' } });
  assert.equal(s1.seeded, true);
  assert.notEqual(s1.seedHex, s2.seedHex, 'two generators in one process never repeat each other');
});

test('rand: an explicit seed replays the same stream', () => {
  const seed = 'ab'.repeat(32);
  const a = makeRng({ seedHex: seed });
  const b = makeRng({ seedHex: seed });
  const seqA = [a.int(0, 1000), a.pick(['x', 'y', 'z']), a.shuffle([1, 2, 3, 4, 5]).join(), a.id(8), a.bytes(5).toString('hex')];
  const seqB = [b.int(0, 1000), b.pick(['x', 'y', 'z']), b.shuffle([1, 2, 3, 4, 5]).join(), b.id(8), b.bytes(5).toString('hex')];
  assert.deepEqual(seqA, seqB);
  assert.equal(a.seeded, true);
  assert.notEqual(deriveSeed(seed, 'round-1'), deriveSeed(seed, 'round-2'));
  assert.throws(() => makeRng({ seedHex: 'xyz' }), UsageError);
  assert.throws(() => makeRng({ seedHex: 'abc' }), UsageError);
});

test('rand: int range [lo, hi), roughly uniform; shuffle keeps the input and its elements', () => {
  const r = makeRng({ seedHex: '01'.repeat(16) });
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) {
    const v = r.int(10, 14);
    assert.ok(v >= 10 && v < 14);
    counts[v - 10]++;
  }
  for (const c of counts) assert.ok(c > 850 && c < 1150, `count ${c}`);
  assert.equal(r.int(5, 6), 5);
  assert.throws(() => r.int(3, 3), UsageError);
  assert.throws(() => r.pick([]), UsageError);
  const input = [1, 2, 3, 4, 5, 6];
  const out = r.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...out].sort(), input);
});

test('rand.mjs uses node:crypto and never Math.random', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'core', 'rand.mjs'), 'utf8');
  assert.ok(src.includes("from 'node:crypto'"));
  assert.ok(!src.includes('Math.random'));
});

test('clock: ISO with offset; test clock can be set and reset', () => {
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  const fixed = new Date(2026, 0, 15, 9, 30, 5, 7); // local time
  setClockForTests(() => fixed);
  try {
    assert.ok(now().startsWith('2026-01-15T09:30:05.007'));
    assert.equal(runStamp(), '20260115-0930');
    assert.equal(localDate(), '2026-01-15');
    assert.equal(new Date(now()).getTime(), fixed.getTime(), 'the offset is correct');
  } finally {
    setClockForTests(null);
  }
  assert.ok(Math.abs(new Date(now()).getTime() - Date.now()) < 5000);
  assert.equal(new Date(isoLocal(new Date(0))).getTime(), 0);
  assert.throws(() => setClockForTests(5), TypeError);
});

test('datahome resolution order (SPEC 7)', (t) => {
  const home = tempDir('home');
  t.after(() => rmTemp(home));
  const explicit = path.join(home, 'my data');
  assert.equal(dataHome({ env: { GAUNTLET_DATA: explicit }, home }), explicit);
  assert.ok(fs.existsSync(explicit), 'created on first use');
  // no env var -> <home>/gauntlet-data (an empty variable counts as unset)
  assert.equal(dataHome({ env: {}, home, create: false }), path.join(home, 'gauntlet-data'));
  assert.equal(dataHome({ env: { GAUNTLET_DATA: '' }, home }), path.join(home, 'gauntlet-data'));
  assert.ok(fs.existsSync(path.join(home, 'gauntlet-data')));
});

test('dataPaths layout and safe ids', () => {
  const dp = dataPaths(path.join('C:', 'x', 'data'));
  assert.equal(path.basename(dp.anchors), 'anchors.jsonl');
  assert.equal(path.basename(dp.runsIndex), 'runs-index.jsonl');
  assert.equal(path.basename(path.dirname(dp.sealedDir('20260115-0930-a1b2c3'))), 'sealed');
  assert.equal(path.basename(dp.sealedKey('20260115-0930-a1b2c3', 2)), '2.key.json');
  assert.deepEqual(Object.keys(dp.measurements).sort(), ['canaries', 'controls', 'decoys', 'detections', 'escapes', 'runs', 'verdicts']);
  assert.equal(path.basename(dp.measurements.detections), 'detections.jsonl');
  assert.equal(path.basename(dp.statsMd), 'STATS.md');
  assert.equal(path.basename(dp.statsJson), 'STATS.json');
  assert.equal(path.basename(dp.selftestDir), 'selftest');
  assert.throws(() => dp.sealedDir('../evil'), UsageError);
  assert.throws(() => dp.sealedDir('a/b'), UsageError);
  assert.equal(chainedFiles(dp).length, 9);
});
