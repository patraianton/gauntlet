import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendChained, readChained, verifyChained, lineHash, ZERO_HASH } from '../../lib/core/chain.mjs';
import { sha256Hex } from '../../lib/core/hash.mjs';
import { canonical } from '../../lib/core/canon.mjs';
import { IntegrityError, UsageError } from '../../lib/core/errors.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { tempDir, rmTemp } from './_helpers.mjs';

function fresh(t) {
  const d = tempDir('chain');
  t.after(() => rmTemp(d));
  return path.join(d, 'x.jsonl');
}

test('append builds {seq, prev, hash, ts, ...payload} with the SPEC 9.15 hash', (t) => {
  const f = fresh(t);
  const a = appendChained(f, { type: 'init', n: 1 });
  const b = appendChained(f, { type: 'gate', n: 2, nested: { z: 1, a: [1, 2] } });
  assert.equal(a.seq, 0);
  assert.equal(a.prev, ZERO_HASH);
  assert.equal(b.seq, 1);
  assert.equal(b.prev, a.hash);
  const { hash, ...rest } = b;
  assert.equal(hash, sha256Hex(b.prev + canonical(rest)));
  assert.equal(lineHash(b), b.hash);
  assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  const lines = readChained(f);
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 4), ['seq', 'prev', 'hash', 'ts']);
  assert.deepEqual(verifyChained(f), { ok: true, count: 2, head: b.hash, firstBrokenSeq: null });
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(raw.endsWith('\n') && !raw.includes('\r'));
});

test('empty or missing chain verifies with head null', (t) => {
  const f = fresh(t);
  assert.deepEqual(verifyChained(f), { ok: true, count: 0, head: null, firstBrokenSeq: null });
  assert.deepEqual(readChained(f), []);
});

test('reserved keys and non-objects are refused', (t) => {
  const f = fresh(t);
  for (const k of ['seq', 'prev', 'hash', 'ts']) assert.throws(() => appendChained(f, { [k]: 1 }), UsageError);
  assert.throws(() => appendChained(f, [1]), UsageError);
});

test('an edited line is detected at its seq', (t) => {
  const f = fresh(t);
  for (let i = 0; i < 5; i++) appendChained(f, { type: 'x', i });
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines[2] = lines[2].replace('"i":2', '"i":7');
  fs.writeFileSync(f, lines.join('\n'));
  const v = verifyChained(f);
  assert.equal(v.ok, false);
  assert.equal(v.firstBrokenSeq, 2);
  // appending to a chain whose tail is fine still works only if the tail verifies;
  // editing the LAST line makes the next append refuse with TAMPER.
  const f2 = fresh(t);
  for (let i = 0; i < 3; i++) appendChained(f2, { type: 'x', i });
  const l2 = fs.readFileSync(f2, 'utf8').split('\n');
  l2[2] = l2[2].replace('"i":2', '"i":9');
  fs.writeFileSync(f2, l2.join('\n'));
  assert.throws(() => appendChained(f2, { type: 'x', i: 3 }), (e) => e instanceof IntegrityError && e.code === 'TAMPER');
});

test('a removed line is detected', (t) => {
  const f = fresh(t);
  for (let i = 0; i < 5; i++) appendChained(f, { type: 'x', i });
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(f, lines.join('\n'));
  const v = verifyChained(f);
  assert.equal(v.ok, false);
  assert.equal(v.firstBrokenSeq, 1);
});

test('a consistent rewrite verifies on its own (anchors catch it, see runstore tests)', (t) => {
  const f = fresh(t);
  appendChained(f, { type: 'x', i: 0 });
  appendChained(f, { type: 'gate', decision: 'FIX' });
  const lines = readChained(f);
  fs.writeFileSync(f, '');
  appendChained(f, { type: 'x', i: 0 });
  appendChained(f, { type: 'gate', decision: 'DONE' });
  const v = verifyChained(f);
  assert.equal(v.ok, true);
  assert.notEqual(v.head, lines[1].hash);
});

test('garbage and incomplete lines are broken', (t) => {
  const f = fresh(t);
  appendChained(f, { type: 'x' });
  fs.appendFileSync(f, '{"seq":1,"prev"');
  assert.equal(verifyChained(f).ok, false);
  assert.equal(verifyChained(f).firstBrokenSeq, 1);
  assert.throws(() => appendChained(f, { type: 'y' }), IntegrityError);
  const g = fresh(t);
  fs.writeFileSync(g, 'not json\n');
  assert.throws(() => readChained(g), (e) => e instanceof IntegrityError && e.code === 'TAMPER');
});

test('payloads that do not survive JSON are refused', (t) => {
  const f = fresh(t);
  assert.throws(() => appendChained(f, { type: 'x', bad: NaN }), UsageError);
});

test('every ledger line validates against ledger-event.schema.json', (t) => {
  const f = fresh(t);
  const line = appendChained(f, { type: 'init', runId: '20260115-0930-a1b2c3', round: null, data: {} });
  const r = validate(loadSchema('ledger-event'), line);
  assert.deepEqual(r.errors, []);
});
