// State machine transitions, task-line deletion rule and CLI argument parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, STATES, taskIsSubsequence, parseArgv, textLines } from '../../lib/engine/state.mjs';
import { parseCut, buildTask } from '../../lib/engine/cmd-task.mjs';
import { parseUsage } from '../../lib/engine/step.mjs';
import { stripScoreKeys } from '../../lib/engine/ingest.mjs';

test('transitions: legal moves', () => {
  assert.equal(transition('NEW', 'issue-lens-writer'), 'AWAIT_LENS_WRITER');
  assert.equal(transition('AWAIT_LENS_WRITER', 'freeze'), 'READY');
  assert.equal(transition('READY', 'start-round'), 'AWAIT_PLANTER');
  assert.equal(transition('AWAIT_PLANTER', 'planter-ingested'), 'AWAIT_VALIDATOR');
  assert.equal(transition('AWAIT_VALIDATOR', 'validator-ingested'), 'AWAIT_REVIEWERS');
  assert.equal(transition('AWAIT_REVIEWERS', 'need-matcher'), 'AWAIT_MATCHER');
  assert.equal(transition('AWAIT_MATCHER', 'verify'), 'AWAIT_VERIFY');
  assert.equal(transition('AWAIT_VERIFY', 'verify2'), 'AWAIT_VERIFY2');
  assert.equal(transition('AWAIT_VERIFY2', 'round-continue'), 'READY');
  assert.equal(transition('AWAIT_VERIFY', 'stop'), 'STOPPED');
  assert.equal(transition('STOPPED', 'done'), 'DONE');
  assert.equal(transition('READY', 'abort'), 'ABORTED');
});

test('transitions: illegal moves throw StateError', () => {
  assert.throws(() => transition('NEW', 'start-round'), /cannot start-round in state NEW/);
  assert.throws(() => transition('DONE', 'abort'), /cannot abort/);
  assert.throws(() => transition('READY', 'verify2'), /cannot verify2/);
  assert.throws(() => transition('READY', 'nonsense'), /unknown state event/);
  assert.equal(STATES.length, 12);
});

test('TASK.md must be OWNER-TASK.md with whole lines deleted', () => {
  const owner = 'one\ntwo\nthree\nSource: owner, 2026-10-06, chat\n';
  assert.equal(taskIsSubsequence(owner, 'one\nthree\n'), true);
  assert.equal(taskIsSubsequence(owner, 'one\ntwo\nthree\n'), true);
  assert.equal(taskIsSubsequence(owner, 'one\ntwo changed\n'), false);
  assert.equal(taskIsSubsequence(owner, 'three\none\n'), false, 'order matters');
  assert.equal(taskIsSubsequence(owner, 'Source: owner, 2026-10-06, chat\n'), false, 'the Source line is not part of the task');
  assert.deepEqual(textLines('a\r\nb\r\n'), ['a', 'b']);
});

test('task set: cut lines, lint of TASK.md, cut lines kept verbatim', () => {
  assert.deepEqual([...parseCut('1,3-4', 5)], [1, 3, 4]);
  assert.throws(() => parseCut('7', 5), /outside/);
  const text = 'Make 12 posts.\nEvery post has a call to action.\nKeep going until the panel gives 9.5.\n';
  const bad = buildTask(text, { cut: null, source: 'owner' });
  assert.ok(bad.hits.length > 0 && bad.hits.every((h) => h.ownerLine === 3));
  const good = buildTask(text, { cut: '3', source: 'owner, 2026-10-06, chat' });
  assert.equal(good.hits.length, 0);
  assert.equal(good.taskText, 'Make 12 posts.\nEvery post has a call to action.\n');
  assert.match(good.ownerText, /9\.5/);
  assert.match(good.ownerText, /\nSource: owner, 2026-10-06, chat\n$/);
  assert.deepEqual(good.cut, [{ line: 3, text: 'Keep going until the panel gives 9.5.', control: true }]);
  // r2-f8: a cut line that is not loop control is an owner requirement
  const req = buildTask(text, { cut: '2,3', source: 'owner' });
  assert.deepEqual(req.cut.map((c) => c.control), [false, true]);
});

test('parseArgv: flags, options, multi, --x=y, unknown options refused', () => {
  const r = parseArgv(['run', '--usage', 'a=1', '--give-up=x', '--give-up', 'y', '--same-material'], { flags: ['same-material'], options: ['usage'], multi: ['give-up'] });
  assert.deepEqual(r.positional, ['run']);
  assert.equal(r.opts.usage, 'a=1');
  assert.deepEqual(r.opts.giveUp, ['x', 'y']);
  assert.equal(r.opts.sameMaterial, true);
  assert.throws(() => parseArgv(['--bogus'], {}), /unknown option/);
  assert.throws(() => parseArgv(['--usage'], { options: ['usage'] }), /needs a value/);
});

test('parseUsage: <job>=<tokens> pairs', () => {
  assert.deepEqual(parseUsage('abcdefgh=100, hjkmnpqr=5'), { abcdefgh: 100, hjkmnpqr: 5 });
  assert.throws(() => parseUsage('x=1'), /bad --usage/);
});

test('stripScoreKeys: score/rating/grade/overall removed anywhere; the matcher pair score kept', () => {
  const { cleaned, removed } = stripScoreKeys({ score: 9.5, findings: [{ n: 1, rating: 3, problem: 'x' }], nested: { Overall: 'good' } }, 'reviewer');
  assert.deepEqual(cleaned, { findings: [{ n: 1, problem: 'x' }], nested: {} });
  assert.deepEqual(removed.sort(), ['/findings/0/rating', '/nested/Overall', '/score'].sort());
  const m = stripScoreKeys({ score: 1, pairs: [{ canary: 'C1', score: 5 }] }, 'matcher');
  assert.deepEqual(m.cleaned, { pairs: [{ canary: 'C1', score: 5 }] });
});
