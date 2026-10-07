import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPaths, recordEvent, verifyRunIntegrity, readState, writeState, withLock, EVENT_TYPES, lastAnchor, roundName } from '../../lib/core/runstore.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { readChained, verifyChained, appendChained } from '../../lib/core/chain.mjs';
import { IntegrityError, UsageError } from '../../lib/core/errors.mjs';
import { writeJsonAtomic } from '../../lib/core/fsx.mjs';
import { tempDir, rmTemp } from './_helpers.mjs';

function setup(t, runId = '20260115-0930-a1b2c3') {
  const root = tempDir('runstore');
  t.after(() => rmTemp(root));
  const dp = dataPaths(path.join(root, 'data'));
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'run.json'), { schemaVersion: 1, runId });
  return { root, dp, runDir, runId };
}

test('runPaths gives the SPEC 8 layout with two-digit round folders', () => {
  const p = runPaths('C:\\x\\run');
  assert.equal(path.basename(p.ledger), 'ledger.jsonl');
  assert.equal(path.basename(p.ownerTask), 'OWNER-TASK.md');
  assert.equal(path.basename(p.frozen), 'FROZEN.json');
  assert.equal(path.basename(p.templatesDir), 'templates');
  const r = p.roundDir(3);
  assert.equal(path.basename(r.dir), '03');
  assert.equal(path.basename(path.dirname(r.dir)), 'rounds');
  for (const k of ['roundJson', 'precheck', 'snapshot', 'manifest', 'copy', 'slots', 'canaries', 'jobs', 'prompts', 'answers', 'ingest', 'detections', 'verifyItems', 'gate', 'todo']) {
    assert.ok(r[k].startsWith(r.dir), k);
  }
  assert.equal(path.basename(r.verifyItems), 'verify-items.json');
  assert.equal(roundName(12), '12');
  assert.equal(roundName(123), '123');
  assert.throws(() => roundName(0), UsageError);
});

test('recordEvent appends to the ledger and to the data-home anchors', (t) => {
  const { dp, runDir, runId } = setup(t);
  const a = recordEvent(runDir, 'init', { project: 'x' }, null, { dataPaths: dp });
  const b = recordEvent(runDir, 'round-open', { kind: 'working' }, 1, { dataPaths: dp });
  assert.equal(a.type, 'init');
  assert.equal(a.runId, runId);
  assert.equal(b.round, 1);
  const anchors = readChained(dp.anchors);
  assert.equal(anchors.length, 2);
  assert.deepEqual({ runId: anchors[1].runId, runSeq: anchors[1].runSeq, head: anchors[1].head }, { runId, runSeq: 1, head: b.hash });
  assert.equal(verifyChained(dp.anchors).ok, true);
  assert.deepEqual(verifyRunIntegrity(runDir, { dataPaths: dp }), { ok: true, count: 2, head: b.hash });
  assert.equal(lastAnchor(runId, { dataPaths: dp }).runSeq, 1);
});

test('unknown event types and bad rounds are refused', (t) => {
  const { dp, runDir } = setup(t);
  assert.throws(() => recordEvent(runDir, 'made-up', {}, null, { dataPaths: dp }), UsageError);
  assert.throws(() => recordEvent(runDir, 'gate', {}, 'x', { dataPaths: dp }), UsageError);
  assert.equal(EVENT_TYPES.length, 50);
});

test('an edited ledger line -> TAMPER', (t) => {
  const { dp, runDir } = setup(t);
  for (let i = 0; i < 4; i++) recordEvent(runDir, 'usage', { i }, 1, { dataPaths: dp });
  const p = runPaths(runDir);
  const lines = fs.readFileSync(p.ledger, 'utf8').split('\n');
  lines[1] = lines[1].replace('"i":1', '"i":5');
  fs.writeFileSync(p.ledger, lines.join('\n'));
  assert.throws(() => verifyRunIntegrity(runDir, { dataPaths: dp }), (e) => e instanceof IntegrityError && e.code === 'TAMPER' && e.details.firstBrokenSeq === 1);
});

test('a removed last ledger line -> TAMPER (anchor mismatch)', (t) => {
  const { dp, runDir } = setup(t);
  for (let i = 0; i < 3; i++) recordEvent(runDir, 'usage', { i }, 1, { dataPaths: dp });
  const p = runPaths(runDir);
  const lines = fs.readFileSync(p.ledger, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(p.ledger, lines.slice(0, 2).join('\n') + '\n');
  assert.equal(verifyChained(p.ledger).ok, true, 'the shortened chain itself verifies');
  assert.throws(() => verifyRunIntegrity(runDir, { dataPaths: dp }), (e) => e instanceof IntegrityError && e.code === 'TAMPER');
});

test('a consistently rewritten ledger -> TAMPER (anchor mismatch)', (t) => {
  const { dp, runDir } = setup(t);
  recordEvent(runDir, 'init', {}, null, { dataPaths: dp });
  recordEvent(runDir, 'gate', { decision: 'FIX' }, 1, { dataPaths: dp });
  const p = runPaths(runDir);
  fs.writeFileSync(p.ledger, '');
  appendChained(p.ledger, { type: 'init', runId: '20260115-0930-a1b2c3', round: null, data: {} });
  appendChained(p.ledger, { type: 'gate', runId: '20260115-0930-a1b2c3', round: 1, data: { decision: 'DONE' } });
  assert.equal(verifyChained(p.ledger).ok, true);
  assert.throws(() => verifyRunIntegrity(runDir, { dataPaths: dp }), (e) => e instanceof IntegrityError && e.code === 'TAMPER');
});

test('a deleted ledger with anchors, or a ledger with no anchors -> TAMPER', (t) => {
  const { dp, runDir } = setup(t);
  recordEvent(runDir, 'init', {}, null, { dataPaths: dp });
  const p = runPaths(runDir);
  fs.unlinkSync(p.ledger);
  assert.throws(() => verifyRunIntegrity(runDir, { dataPaths: dp }), IntegrityError);
  const other = setup(t, '20260115-0931-bbbbbb');
  appendChained(runPaths(other.runDir).ledger, { type: 'init', runId: other.runId, round: null, data: {} });
  assert.throws(() => verifyRunIntegrity(other.runDir, { dataPaths: other.dp }), IntegrityError);
  // a brand-new run (no ledger, no anchors) is fine
  const blank = setup(t, '20260115-0932-cccccc');
  assert.deepEqual(verifyRunIntegrity(blank.runDir, { dataPaths: blank.dp }), { ok: true, count: 0, head: null });
});

test('a tampered anchors file -> TAMPER', (t) => {
  const { dp, runDir } = setup(t);
  recordEvent(runDir, 'init', {}, null, { dataPaths: dp });
  recordEvent(runDir, 'usage', {}, 1, { dataPaths: dp });
  const lines = fs.readFileSync(dp.anchors, 'utf8').split('\n');
  lines[0] = lines[0].replace('"seq":0', '"seq":5');
  fs.writeFileSync(dp.anchors, lines.join('\n'));
  assert.throws(() => verifyRunIntegrity(runDir, { dataPaths: dp }), IntegrityError);
});

test('state round-trips with schemaVersion 1', (t) => {
  const { runDir } = setup(t);
  assert.equal(readState(runDir), null);
  writeState(runDir, { state: 'NEW', round: null, frozen: false });
  assert.deepEqual(readState(runDir), { schemaVersion: 1, state: 'NEW', round: null, frozen: false });
});

test('withLock: exclusive, released, refuses a live holder, takes over stale locks', async (t) => {
  const { runDir } = setup(t);
  const p = runPaths(runDir);
  const r = await withLock(runDir, async (info) => {
    assert.equal(info.takenOver, null);
    assert.ok(fs.existsSync(p.lock));
    // nested call in the same process shares the lock
    return withLock(runDir, async (inner) => (inner.nested ? 'nested-ok' : 'bad'));
  });
  assert.equal(r, 'nested-ok');
  assert.ok(!fs.existsSync(p.lock), 'released');

  // live holder (this test runner's parent pid is alive) and fresh -> refused
  const os = await import('node:os');
  fs.writeFileSync(p.lock, JSON.stringify({ pid: process.ppid, at: Date.now(), host: os.hostname(), token: 'x' }));
  await assert.rejects(() => withLock(runDir, async () => 1), UsageError);

  // live holder but older than 2 hours -> taken over
  fs.writeFileSync(p.lock, JSON.stringify({ pid: process.ppid, at: Date.now() - 3 * 3600 * 1000, host: os.hostname(), token: 'x' }));
  const info1 = await withLock(runDir, async (info) => info);
  assert.equal(info1.takenOver.pid, process.ppid);

  // dead pid -> taken over
  fs.writeFileSync(p.lock, JSON.stringify({ pid: 2147483000, at: Date.now(), host: os.hostname(), token: 'x' }));
  const info2 = await withLock(runDir, async (info) => info);
  assert.equal(info2.takenOver.pid, 2147483000);
  assert.ok(!fs.existsSync(p.lock));

  // fn errors still release the lock
  await assert.rejects(() => withLock(runDir, async () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(p.lock));
});
