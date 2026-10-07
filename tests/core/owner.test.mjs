import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerWords, ownerWordsErrors, quoteFlags, decisionSubject } from '../../lib/core/owner.mjs';

const Q = 'Я включил тебе ультракод режима, давай просто быстро всё делай, не жалей токенов.';

test('ownerWords: the question is required for every recorded decision, long quote or short', () => {
  assert.throws(() => ownerWords(Q), /--question/);
  assert.throws(() => ownerWords('да'), /--question/);
  assert.deepEqual(ownerWords(Q, 'Можно поднять лимит кругов до двенадцати?'), { quote: Q, question: 'Можно поднять лимит кругов до двенадцати?' });
  // no quote and not required: nothing to record
  assert.equal(ownerWords(null, null, { required: false }), null);
  assert.equal(ownerWords('', 'Вы согласны на это?', { required: false }), null);
});

test('ownerWords: a question is validated like the quote (letters, length, not the answer repeated)', () => {
  assert.throws(() => ownerWords(Q, '...'), /exact question/);
  assert.throws(() => ownerWords(Q, 'ага'), /at least 10/);
  assert.throws(() => ownerWords(Q, ` ${Q.toUpperCase()}! `), /not the answer repeated/);
  // a given question is checked even when it is optional
  assert.throws(() => ownerWords(Q, 'ага', { questionRequired: false }), /at least 10/);
  assert.deepEqual(ownerWords(Q, null, { questionRequired: false }), { quote: Q, question: null });
});

test('ownerWordsErrors: a quote written into run.json needs its question, long or short', () => {
  const e = ownerWordsErrors({ quote: Q }, '/limitsOptIn');
  assert.equal(e.length, 1);
  assert.equal(e[0].path, '/limitsOptIn/question');
  assert.match(e[0].message, /question/);
  assert.equal(ownerWordsErrors({ quote: 'да' }, '/driver/workflowOptIn').length, 1);
  assert.deepEqual(ownerWordsErrors({ quote: 'да', question: 'Запускать проверки через Workflow?' }, '/driver/workflowOptIn'), []);
  assert.deepEqual(ownerWordsErrors({ quote: Q, question: 'Можно поднять лимит кругов до двенадцати?' }, '/limitsOptIn'), []);
  // the question is checked like on the command line
  assert.equal(ownerWordsErrors({ quote: 'да', question: 'ага' }, '/limitsOptIn').length, 1);
  // a frozen run from before the rule still loads
  assert.deepEqual(ownerWordsErrors({ quote: Q }, '/limitsOptIn', { legacyQuestions: true }), []);
});

test('quoteFlags: one quote behind decisions of different kinds is flagged; the same kind is not', () => {
  const ds = [
    { id: 'O1', ts: '2026-10-07T09:52:58+03:00', kind: 'raise-limit', quote: Q, question: 'Поднять лимит?' },
    { id: 'O2', ts: '2026-10-07T09:54:48+03:00', kind: 'amend', set: { what: 'sources' }, quote: Q, question: 'Что-то про источники?' },
  ];
  const f = quoteFlags(ds);
  assert.equal(f.reuse.length, 1);
  assert.deepEqual(f.reuse[0].decisions.map((d) => d.id), ['O1', 'O2']);
  assert.deepEqual(f.reuse[0].decisions.map((d) => d.subject), ['raise-limit', 'amend:sources']);
  // two waivers on one quote are one kind of decision
  const w = [
    { id: 'O1', ts: '2026-10-07T10:00:00+03:00', kind: 'waive', clusters: ['C-01-01'], quote: 'оставь как есть, это другая акция', question: 'Снять находку?' },
    { id: 'O2', ts: '2026-10-07T10:01:00+03:00', kind: 'waive', clusters: ['C-01-02'], quote: 'Оставь как есть, это другая акция!', question: 'Снять и вторую?' },
  ];
  assert.equal(quoteFlags(w).reuse.length, 0);
  // two amends of different parts are different subjects
  assert.equal(decisionSubject({ kind: 'amend', set: { what: 'task' } }), 'amend:task');
  const a = [
    { id: 'O1', ts: '2026-10-07T10:00:00+03:00', kind: 'amend', set: { what: 'task' }, quote: Q, question: 'Задание?' },
    { id: 'O2', ts: '2026-10-07T10:01:00+03:00', kind: 'amend', set: { what: 'sources' }, quote: Q, question: 'Источники?' },
  ];
  assert.equal(quoteFlags(a).reuse.length, 1);
});

test('quoteFlags: words recorded before the problem existed are flagged', () => {
  const ds = [
    { id: 'O1', ts: '2026-10-07T09:00:00+03:00', kind: 'continue', quote: Q, question: 'Продолжать?' },
    { id: 'O2', ts: '2026-10-07T12:00:00+03:00', kind: 'waive', clusters: ['C-03-01', 'C-01-01'], quote: Q, question: 'Снять?' },
  ];
  const born = { 'C-03-01': '2026-10-07T11:00:00+03:00', 'C-01-01': '2026-10-06T22:00:00+03:00' };
  const f = quoteFlags(ds, { clusterBorn: (id) => born[id] });
  // C-03-01 appeared after the quote was first recorded; C-01-01 existed before it
  assert.deepEqual(f.predates.map((p) => [p.id, p.cluster]), [['O2', 'C-03-01']]);
  assert.equal(f.predates[0].quoteSince, '2026-10-07T09:00:00+03:00');
  assert.equal(f.predates[0].problemSince, '2026-10-07T11:00:00+03:00');
  // a quote dated in run.json an earlier day also predates a later problem
  const g = quoteFlags([{ id: 'O1', ts: '2026-10-07T12:00:00+03:00', kind: 'waive', clusters: ['C-03-01'], quote: Q, question: 'Снять?' }], {
    clusterBorn: (id) => born[id],
    datedQuotes: [{ quote: Q, date: '2026-10-05' }],
  });
  assert.equal(g.predates.length, 1);
  assert.equal(g.predates[0].quoteSince, '2026-10-05');
  // the same day is not "clearly earlier"
  const h = quoteFlags([{ id: 'O1', ts: '2026-10-07T12:00:00+03:00', kind: 'waive', clusters: ['C-03-01'], quote: Q, question: 'Снять?' }], {
    clusterBorn: (id) => born[id],
    datedQuotes: [{ quote: Q, date: '2026-10-07' }],
  });
  assert.equal(h.predates.length, 0);
});
