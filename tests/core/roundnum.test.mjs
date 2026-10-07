// The one definition of the round number the owner reads (bug 14): real rounds only, folder in brackets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realRoundNumbers, roundLabelRu, roundLabelEn, realOf, folderPart, isAttemptDecision } from '../../lib/core/roundnum.mjs';

test('real round numbers skip the folders of attempts that never reached the reviewers', () => {
  // folder 01 blocked, 02-04 real (a run with one early attempt); a second run with 12 folders: 7 real among 12
  const m = realRoundNumbers([{ n: 1, blocked: true }, { n: 2 }, { n: 3 }, { n: 4 }]);
  assert.deepEqual([...m], [[1, null], [2, 1], [3, 2], [4, 3]]);
  const flags = [false, false, false, true, false, true, true, false, true, false, true, false];
  const longRun = realRoundNumbers(flags.map((blocked, i) => ({ n: i + 1, blocked })));
  assert.equal(longRun.get(12), 7, 'the real round 7 lives in folder 12');
  assert.equal(longRun.get(4), null);
  assert.equal(longRun.get(5), 4);
});

test('order of the input does not matter; no attempts means folder = round', () => {
  const m = realRoundNumbers([{ n: 3 }, { n: 1 }, { n: 2 }]);
  assert.deepEqual([...m.entries()].sort(), [[1, 1], [2, 2], [3, 3]]);
});

test('labels: the folder in brackets only where it differs; an attempt is an attempt', () => {
  const m = realRoundNumbers([{ n: 1, blocked: true }, { n: 2 }, { n: 3 }]);
  assert.equal(roundLabelRu(3, m), '2 (папка 03)');
  assert.equal(roundLabelEn(3, m), '2 (folder 03)');
  assert.equal(roundLabelRu(1, m), 'попытка (папка 01)');
  assert.equal(roundLabelEn(1, m), 'attempt (folder 01)');
  const plain = realRoundNumbers([{ n: 1 }, { n: 2 }]);
  assert.equal(roundLabelRu(2, plain), '2');
  assert.equal(roundLabelEn(2, plain), '2');
  assert.equal(roundLabelRu(9, m), '9', 'an unknown folder is shown as it is');
  assert.equal(roundLabelRu(null, m), '?');
  assert.equal(realOf(3, m), 2);
  assert.equal(realOf(1, m), null);
  assert.equal(realOf(7, m), null);
  assert.equal(folderPart(4), '04');
  assert.equal(folderPart(12), '12');
  assert.ok(isAttemptDecision('BLOCKED_PRECHECK') && isAttemptDecision('BLOCKED_TRACE'));
  assert.ok(!isAttemptDecision('STOP_LIMIT') && !isAttemptDecision('INVALID_ROUND') && !isAttemptDecision(undefined));
});
