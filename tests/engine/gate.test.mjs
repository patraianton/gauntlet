// gate.decide is pure; every branch of SPEC 13.3 is table-tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decide, stagnantCount, bestOf, lensValidity, countOpen, isOpenCluster } from '../../lib/engine/gate.mjs';

const LIMITS = { maxRounds: 8, maxConfirms: 2, maxPanelTokens: 15000000, plateauRounds: 2, maxLensReruns: 1 };
const OK = { answerValid: true, attempts: 1, guarded: true, caught: true };

function base(over = {}) {
  return {
    round: 3,
    kind: 'working',
    versionHash: 'v3',
    candidate: null,
    ownerStop: false,
    lenses: ['a', 'b'],
    lensFacts: { a: { ...OK }, b: { ...OK } },
    clusters: [],
    pendingDisputes: 0,
    history: [],
    lastContinueRound: null,
    confirmsDone: 0,
    roundsDone: 1,
    tokensSpent: 0,
    nextEstimate: 1000,
    limits: LIMITS,
    panelCatch: { pairsCaught: 2, pairsTotal: 4 },
    ...over,
  };
}

const openMajor = (id, lenses = ['a']) => ({ id, origin: 'finding', status: 'open', severity: 'major', lenses });

const TABLE = [
  ['owner stop wins over everything', base({ ownerStop: true, kind: 'confirm', candidate: { round: 2, versionHash: 'v3' } }), 'STOP_OWNER'],
  ['confirm, clean, same version -> DONE', base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' } }), 'DONE'],
  ['confirm, version differs -> not DONE', base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v2' } }), 'FIX'],
  ['confirm, an open major -> FIX', base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' }, clusters: [openMajor('C-03-01')] }), 'FIX'],
  [
    'confirm, unreliable lens and nothing open -> STOP_INCONCLUSIVE',
    base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' }, lensFacts: { a: { ...OK }, b: { answerValid: true, attempts: 2, guarded: true, caught: false } } }),
    'STOP_INCONCLUSIVE',
  ],
  [
    'confirm failure reaching maxConfirms -> STOP_LIMIT',
    base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' }, confirmsDone: 1, clusters: [openMajor('C-03-01')] }),
    'STOP_LIMIT',
  ],
  ['working, clean -> CONFIRM', base(), 'CONFIRM'],
  [
    'working, unreliable lens and nothing open -> STOP_INCONCLUSIVE',
    base({ lensFacts: { a: { ...OK }, b: { answerValid: true, attempts: 2, guarded: true, caught: false } } }),
    'STOP_INCONCLUSIVE',
  ],
  ['working, unguarded lens and nothing open -> STOP_INCONCLUSIVE', base({ lensFacts: { a: { ...OK }, b: { answerValid: true, attempts: 1, guarded: false, caught: false } } }), 'STOP_INCONCLUSIVE'],
  ['working, open and rounds limit -> STOP_LIMIT', base({ roundsDone: 8, clusters: [openMajor('C-03-01')] }), 'STOP_LIMIT'],
  ['working, open and token budget -> STOP_LIMIT', base({ tokensSpent: 14999500, nextEstimate: 1000, clusters: [openMajor('C-03-01')] }), 'STOP_LIMIT'],
  [
    'working, two stagnant rounds -> STOP_PLATEAU',
    base({
      clusters: [openMajor('C-01-01'), openMajor('C-01-02')],
      history: [
        { round: 1, kind: 'working', valid: true, versionHash: 'v1', openBlockers: 0, openMajors: 2, distinctOpen: 2 },
        { round: 2, kind: 'working', valid: true, versionHash: 'v2', openBlockers: 0, openMajors: 2, distinctOpen: 2 },
      ],
    }),
    'STOP_PLATEAU',
  ],
  [
    'plateau counting restarts after the owner\'s continue',
    base({
      clusters: [openMajor('C-01-01'), openMajor('C-01-02')],
      lastContinueRound: 2,
      history: [
        { round: 1, kind: 'working', valid: true, versionHash: 'v1', openBlockers: 0, openMajors: 2, distinctOpen: 2 },
        { round: 2, kind: 'working', valid: true, versionHash: 'v2', openBlockers: 0, openMajors: 2, distinctOpen: 2 },
      ],
    }),
    'FIX',
  ],
  ['working, open problem -> FIX', base({ clusters: [openMajor('C-03-01')] }), 'FIX'],
  ['a pending dispute blocks clean', base({ pendingDisputes: 1 }), 'FIX'],
  ['unverified serious cluster blocks', base({ clusters: [{ id: 'C-03-01', origin: 'finding', status: 'unverified', severity: 'blocker', lenses: ['a'] }] }), 'FIX'],
  ['contested serious cluster blocks', base({ clusters: [{ id: 'C-03-01', origin: 'finding', status: 'contested', severity: 'major', lenses: ['b'] }] }), 'FIX'],
  ['a waived cluster does not block', base({ clusters: [{ id: 'C-03-01', origin: 'finding', status: 'waived', severity: 'major', waived: true, lenses: ['a'] }] }), 'CONFIRM'],
  ['a cosmetic cluster does not block', base({ clusters: [{ id: 'C-03-01', origin: 'finding', status: 'cosmetic', severity: 'cosmetic', lenses: ['a'] }] }), 'CONFIRM'],
  ['an invalid answer blocks clean', base({ clusters: [openMajor('C-03-01')], lensFacts: { a: { ...OK }, b: { answerValid: false, attempts: 1, guarded: true, caught: true } } }), 'FIX'],
];

for (const [name, input, want] of TABLE) {
  test(`gate: ${name}`, () => {
    const g = decide(input);
    assert.equal(g.decision, want, JSON.stringify(g.reasons));
  });
}

test('gate: confirm failure increments confirmsDone; CONFIRM keeps it', () => {
  const g = decide(base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' }, clusters: [openMajor('C-03-01')] }));
  assert.equal(g.limits.confirmsDone, 1);
  assert.equal(decide(base()).limits.confirmsDone, 0);
});

test('gate: worst lens, per-lens counts, no average anywhere', () => {
  const g = decide(base({ clusters: [openMajor('C-03-01', ['a', 'b']), openMajor('C-03-02', ['b'])] }));
  assert.deepEqual(g.perLens.a.open, { blocker: 0, major: 1 });
  assert.deepEqual(g.perLens.b.open, { blocker: 0, major: 2 });
  assert.equal(g.open.major, 2, 'distinct clusters, counted once');
  const src = fs.readFileSync(fileURLToPath(new URL('../../lib/engine/gate.mjs', import.meta.url)), 'utf8');
  assert.ok(!/\/\s*(lensIds|lenses|perLens|values?)\.length/.test(src), 'no division by a count (no mean) in gate.mjs');
  assert.ok(!/reduce\([^)]*\+/.test(src), 'no summing reduce in gate.mjs');
});

test('gate: band only in confirm rounds, worst lens', () => {
  assert.equal(decide(base()).band, null);
  const g = decide(base({ kind: 'confirm', candidate: { round: 2, versionHash: 'v3' }, clusters: [{ id: 'C-03-01', origin: 'finding', status: 'cosmetic', severity: 'cosmetic', lenses: ['a'] }] }));
  assert.deepEqual(g.band.perLens.a, [9.0, 9.7]);
  assert.deepEqual(g.band.perLens.b, [9.8, 10]);
  assert.deepEqual(g.band.worst, [9.0, 9.7]);
});

test('gate: best keeps the earlier round on a tie', () => {
  const b = bestOf([
    { round: 1, valid: true, versionHash: 'v1', openBlockers: 0, openMajors: 2 },
    { round: 2, valid: true, versionHash: 'v2', openBlockers: 0, openMajors: 2 },
    { round: 3, valid: false, versionHash: 'v3', openBlockers: 0, openMajors: 0 },
  ]);
  assert.equal(b.round, 1);
  const c = bestOf([
    { round: 1, valid: true, versionHash: 'v1', openBlockers: 1, openMajors: 0 },
    { round: 2, valid: true, versionHash: 'v2', openBlockers: 0, openMajors: 5 },
  ]);
  assert.equal(c.round, 2, 'blockers first');
});

test('stagnantCount: counts consecutive non-improving valid working rounds', () => {
  const r = (round, distinctOpen, kind = 'working', valid = true) => ({ round, distinctOpen, kind, valid });
  assert.equal(stagnantCount([r(1, 3)]), 0);
  assert.equal(stagnantCount([r(1, 3), r(2, 2)]), 0);
  assert.equal(stagnantCount([r(1, 3), r(2, 3)]), 1);
  assert.equal(stagnantCount([r(1, 3), r(2, 3), r(3, 4)]), 2);
  assert.equal(stagnantCount([r(1, 3), r(2, 1), r(3, 2)]), 1);
  assert.equal(stagnantCount([r(1, 3), r(2, 3, 'working', false), r(3, 3)]), 1, 'invalid rounds are skipped');
  assert.equal(stagnantCount([r(1, 3), r(2, 3), r(3, 3)], 2), 1, 'rounds up to the continue are not counted');
});

test('lensValidity: valid needs a valid answer and a caught attention check', () => {
  assert.equal(lensValidity({ answerValid: true, attempts: 1, guarded: true, caught: true }, 1).valid, true);
  const missed = lensValidity({ answerValid: true, attempts: 1, guarded: true, caught: false }, 1);
  assert.equal(missed.valid, false);
  assert.equal(missed.unreliable, false, 'a rerun is still possible');
  assert.equal(lensValidity({ answerValid: true, attempts: 2, guarded: true, caught: false }, 1).unreliable, true);
  assert.equal(lensValidity({ answerValid: true, attempts: 1, guarded: false, caught: false }, 1).unreliable, true);
});

test('countOpen / isOpenCluster: open set is open|unverified|contested with blocker|major, not waived', () => {
  assert.equal(isOpenCluster({ status: 'open', severity: 'cosmetic' }), false);
  assert.equal(isOpenCluster({ status: 'dropped', severity: 'major' }), false);
  assert.equal(isOpenCluster({ status: 'unverified', severity: 'major' }), true);
  const c = countOpen([{ id: 'x', origin: 'requirement', status: 'open', severity: 'blocker', lenses: ['a'] }], ['a']);
  assert.equal(c.open.requirements, 1);
  assert.equal(c.distinct, 1);
});

test('r3-f13: a candidate disproved by its confirm round does not make later progress look like a plateau', () => {
  const h = [
    { round: 1, kind: 'working', valid: true, versionHash: 'a', openBlockers: 0, openMajors: 5, distinctOpen: 5 },
    { round: 2, kind: 'working', valid: true, versionHash: 'b', openBlockers: 0, openMajors: 0, distinctOpen: 0 },
    { round: 3, kind: 'confirm', valid: true, versionHash: 'b', openBlockers: 0, openMajors: 5, distinctOpen: 5 },
    { round: 4, kind: 'working', valid: true, versionHash: 'c', openBlockers: 0, openMajors: 3, distinctOpen: 3 },
  ];
  assert.equal(stagnantCount(h), 0);
  const g = decide(base({ round: 5, versionHash: 'd', clusters: [openMajor('C-05-01')], history: h, confirmsDone: 1, roundsDone: 5 }));
  assert.equal(g.decision, 'FIX', JSON.stringify(g.reasons));
  assert.notEqual(g.best.versionHash, 'b', 'the disproved candidate is not the best version');
});

test('r3-f14: the best version is scored by the worst round on it', () => {
  const h = [
    { round: 1, kind: 'working', valid: true, versionHash: 'H1', openBlockers: 1, openMajors: 3, distinctOpen: 4 },
    { round: 2, kind: 'working', valid: true, versionHash: 'H2', openBlockers: 0, openMajors: 1, distinctOpen: 1 },
    { round: 3, kind: 'working', valid: true, versionHash: 'H3', openBlockers: 0, openMajors: 0, distinctOpen: 0 },
    { round: 4, kind: 'confirm', valid: true, versionHash: 'H3', openBlockers: 1, openMajors: 1, distinctOpen: 2 },
  ];
  assert.deepEqual(bestOf(h), { round: 2, versionHash: 'H2', blockers: 0, majors: 1 });
});

// ---------------------------------------------------------------- best version over every reviewed round

const rv = (round, over = {}) => ({ round, kind: 'working', valid: false, reviewed: true, versionHash: `H${round}`, openBlockers: 0, openMajors: 5, distinctOpen: 5, ...over });

test('best (reviewed rule): a round whose lens was invalid still names a version; "clean" stays separate', () => {
  const h = [rv(1, { openBlockers: 2, openMajors: 55 }), rv(2, { openBlockers: 4, openMajors: 31 }), rv(3, { openBlockers: 1, openMajors: 40 }), rv(5, { openBlockers: 1, openMajors: 36 })];
  assert.equal(bestOf(h), null, 'old rule: no round had every lens valid, so nothing is kept');
  assert.deepEqual(bestOf(h, { reviewedRounds: true }), { round: 5, versionHash: 'H5', blockers: 1, majors: 36, lensesValid: false });
  const mixed = [...h, rv(6, { valid: true, openBlockers: 1, openMajors: 36 })];
  assert.equal(bestOf(mixed, { reviewedRounds: true }).round, 5, 'a tie keeps the earlier round');
  assert.equal(bestOf([rv(1, { valid: true, openMajors: 2 }), rv(2, { openMajors: 3 })], { reviewedRounds: true }).lensesValid, true);
});

test('best (reviewed rule): a round that never reached the reviewers (zero counts) is never the best version', () => {
  const h = [rv(1, { openMajors: 7 }), rv(2, { reviewed: false, openMajors: 0, distinctOpen: 0 })];
  assert.equal(bestOf(h, { reviewedRounds: true }).round, 1);
  assert.equal(bestOf([rv(1, { reviewed: false, openMajors: 0, distinctOpen: 0 })], { reviewedRounds: true }), null);
  // entries without the flag (stored by an older gate) are not eligible under the new rule unless the engine sets it
  assert.equal(bestOf([{ round: 1, valid: false, versionHash: 'x', openBlockers: 0, openMajors: 0, distinctOpen: 0 }], { reviewedRounds: true }), null);
});

test('decide: bestRule "reviewed" records the best of an invalid-lens round; an input without it replays as before', () => {
  const invalidLens = { a: { ...OK }, b: { answerValid: false, attempts: 2, guarded: true, caught: true, invalidReasons: ['answer: talks about the check itself'] } };
  const withRule = decide(base({ round: 1, versionHash: 'v1', lensFacts: invalidLens, clusters: [openMajor('C-01-01')], bestRule: 'reviewed' }));
  assert.deepEqual(withRule.best, { round: 1, versionHash: 'v1', blockers: 0, majors: 1, lensesValid: false });
  assert.equal(withRule.history[0].reviewed, true);
  const old = decide(base({ round: 1, versionHash: 'v1', lensFacts: invalidLens, clusters: [openMajor('C-01-01')] }));
  assert.equal(old.best, null, 'inputs stored before the rule have no best from an invalid round');
  assert.equal('reviewed' in old.history[0], false, 'and no new field, so the stored gate.json still equals the replay');
  // a clean round can not come out of an invalid lens, whatever the best says
  assert.notEqual(withRule.decision, 'CONFIRM');
  assert.notEqual(withRule.decision, 'DONE');
});

// ---------------------------------------------------------------- plateau over every reviewed round

test('stagnantCount (reviewed rule): rounds with an invalid lens count; blocked and invalid rounds do not; confirm rounds are skipped', () => {
  const h = [rv(1, { distinctOpen: 5 }), rv(2, { distinctOpen: 5 }), rv(3, { distinctOpen: 6 })];
  assert.equal(stagnantCount(h), 0, 'old rule: no round had every lens valid');
  assert.equal(stagnantCount(h, null, { reviewedRounds: true }), 2);
  const withGap = [rv(1, { distinctOpen: 5 }), rv(2, { reviewed: false, distinctOpen: 0 }), rv(3, { distinctOpen: 6 })];
  assert.equal(stagnantCount(withGap, null, { reviewedRounds: true }), 1, 'a round that never reached the reviewers is neither counted nor a minimum');
  const withConfirm = [rv(1, { distinctOpen: 5 }), rv(2, { kind: 'confirm', distinctOpen: 7 }), rv(3, { distinctOpen: 6 })];
  assert.equal(stagnantCount(withConfirm, null, { reviewedRounds: true }), 1, 'a confirm round is skipped');
  assert.equal(stagnantCount(h, 2, { reviewedRounds: true }), 1, 'rounds up to the owner continue are not counted');
  // entries without the flag (stored by an older gate) are never counted under the new rule
  assert.equal(stagnantCount([{ round: 1, kind: 'working', valid: true, versionHash: 'x', distinctOpen: 3 }, { round: 2, kind: 'working', valid: true, versionHash: 'y', distinctOpen: 3 }], null, { reviewedRounds: true }), 0);
});

test('stagnantCount (reviewed rule): an invalid-lens round never lowers the minimum while a fully valid round exists (mixed sequence)', () => {
  const ok = (round, distinctOpen) => rv(round, { valid: true, distinctOpen });
  // 57 valid, 20 with a blind lens, then 30 and 25 valid: the valid counts fell, the run is not stagnant
  const mixed = [ok(1, 57), rv(2, { distinctOpen: 20 }), ok(3, 30), ok(4, 25)];
  assert.equal(stagnantCount(mixed, null, { reviewedRounds: true }), 0, 'the artificially low 20 is not a minimum');
  assert.equal(stagnantCount(mixed.slice(0, 3), null, { reviewedRounds: true }), 0);
  // a blind round that looks better than every valid one before it is not a plateau either: it breaks the streak
  assert.equal(stagnantCount([ok(1, 57), ok(2, 60), rv(3, { distinctOpen: 20 })], null, { reviewedRounds: true }), 0);
  // a blind round that is not better counts, and so do the valid rounds after it
  assert.equal(stagnantCount([ok(1, 30), rv(2, { distinctOpen: 31 }), ok(3, 32)], null, { reviewedRounds: true }), 2);
  // with no fully valid round before it the reviewed rounds are the reference (window 2: a lens blind in every round)
  assert.equal(stagnantCount([rv(1, { distinctOpen: 5 }), rv(2, { distinctOpen: 6 }), rv(3, { distinctOpen: 7 })], null, { reviewedRounds: true }), 2);
  // the stored old-rule inputs replay as before: only fully valid rounds count
  assert.equal(stagnantCount(mixed), 0);
  assert.equal(stagnantCount([ok(1, 5), rv(2, { distinctOpen: 1 }), ok(3, 5)]), 1, 'old rule: the invalid round is skipped');
});

// The second night (06-07.10.2026): a lens was invalid in every round of window 2; serious problems 57 -> 35 -> 41 -> 37 -> 55.
function replayWindow2(extra) {
  const counts = [57, 35, 41, 37, 55];
  const invalidLens = { a: { ...OK }, b: { answerValid: false, attempts: 2, guarded: true, caught: true, invalidReasons: ['answer: talks about the check itself'] } };
  const history = [];
  const decisions = [];
  counts.forEach((n, i) => {
    const round = i + 1;
    const g = decide(base({
      round, versionHash: `v${round}`, lensFacts: invalidLens, history: [...history], roundsDone: round,
      clusters: Array.from({ length: n }, (_, k) => openMajor(`C-${round}-${k}`)),
      ...extra,
    }));
    decisions.push(g.decision);
    history.push(g.history[g.history.length - 1]);
  });
  return decisions;
}

test('decide: window-2 sequence 57 -> 35 -> 41 -> 37 -> 55 stops on a plateau at round 4 when a lens is invalid every round', () => {
  assert.deepEqual(replayWindow2({ plateauRule: 'reviewed', bestRule: 'reviewed' }), ['FIX', 'FIX', 'FIX', 'STOP_PLATEAU', 'STOP_PLATEAU']);
});

test('decide: an input stored by the old rule (no plateauRule) replays as before, and a bestRule-only input too', () => {
  assert.deepEqual(replayWindow2({}), ['FIX', 'FIX', 'FIX', 'FIX', 'FIX']);
  assert.deepEqual(replayWindow2({ bestRule: 'reviewed' }), ['FIX', 'FIX', 'FIX', 'FIX', 'FIX']);
});

test('decide: with plateauRule an invalid lens never makes a plateau round clean, and the plateau patience is the limit', () => {
  const g = decide(base({ round: 2, versionHash: 'v2', plateauRule: 'reviewed', history: [rv(1, { distinctOpen: 0 })], clusters: [], lensFacts: { a: { ...OK }, b: { answerValid: false, attempts: 2, guarded: true, caught: true } } }));
  assert.notEqual(g.decision, 'CONFIRM');
  assert.notEqual(g.decision, 'DONE');
  assert.equal(g.plateau.stagnant, 1);
});
