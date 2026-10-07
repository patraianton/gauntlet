// True controls (SPEC 14.12): which matched findings become controls, the outcome of a verdict on one, how
// they are laid out among the verifier items beside decoys, the cross-run ledger rows and their statistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  controlsWanted,
  controlCountFor,
  chooseControls,
  controlOutcome,
  controlFailed,
  summariseControls,
  controlView,
} from '../../lib/measure/controls.mjs';
import { buildItems } from '../../lib/engine/verify.mjs';
import { makeRng } from '../../lib/core/rand.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { appendRunRows, readLedger } from '../../lib/measure/mledger.mjs';
import { computeStats, renderStatsMd, statsForRun } from '../../lib/measure/recall.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { applyDefaults, looserLimits, validateRun } from '../../lib/core/config.mjs';

const canary = (id, extra = {}) => ({ canary: id, type: 'NUMBER_CHANGED', file: 'content/page.md', before: 'a 40', after: 'a 45', ...extra });
const finding = (job, n, extra = {}) => ({ job, n, severity: 'blocker', kind: 'number', file: 'content/page.md', locator: 'line 3', quote: 'Пакет: 45 €', missingWhat: null, seen: null, problem: 'The sum is wrong.', grounded: true, ...extra });
const det = (canaryId, job, n, extra = {}) => ({ canary: canaryId, job, finding: n, outcome: 'caught', stage: 'code', matcherScore: null, severityGiven: 'blocker', ...extra });

test('controlsWanted: the run setting, 0 (off) when absent or not a whole number', () => {
  assert.equal(controlsWanted({ canaries: { controlsPerRound: 4 } }), 4);
  assert.equal(controlsWanted({ canaries: { controlsPerRound: 0 } }), 0);
  assert.equal(controlsWanted({ canaries: {} }), 0);
  assert.equal(controlsWanted({ canaries: { controlsPerRound: -1 } }), 0);
  assert.equal(controlsWanted({ canaries: { controlsPerRound: 2.5 } }), 0);
  assert.equal(controlsWanted(null), 0);
});

test('controlCountFor: at least one per batch when there are enough, never more than asked, never more than half the real items', () => {
  assert.equal(controlCountFor({ available: 4, perRound: 4, realItems: 20, batchMax: 8 }), 3);
  assert.equal(controlCountFor({ available: 4, perRound: 4, realItems: 6, batchMax: 8 }), 2);
  assert.equal(controlCountFor({ available: 4, perRound: 4, realItems: 2, batchMax: 8 }), 1);
  assert.equal(controlCountFor({ available: 1, perRound: 4, realItems: 20, batchMax: 8 }), 1);
  assert.equal(controlCountFor({ available: 4, perRound: 1, realItems: 20, batchMax: 8 }), 1);
  assert.equal(controlCountFor({ available: 0, perRound: 4, realItems: 20, batchMax: 8 }), 0);
  assert.equal(controlCountFor({ available: 4, perRound: 0, realItems: 20, batchMax: 8 }), 0);
  assert.equal(controlCountFor({ available: 4, perRound: 4, realItems: 0, batchMax: 8 }), 0);
});

test('chooseControls: one control per planted error, from a finding that left the real-problem pipeline and was reported at the planted class', () => {
  const canaries = [canary('C1'), canary('C2'), canary('C3'), canary('C4')];
  const findings = [finding('ja', 1), finding('jb', 1), finding('jc', 2, { severity: 'major' }), finding('jd', 1, { grounded: false }), finding('je', 1, { problem: '  ' })];
  const detections = [
    det('C1', 'ja', 1),
    det('C1', 'jb', 1), // a second reporter of the same planted error: only one control per error
    det('C2', 'jc', 2, { stage: 'matcher', matcherScore: 5, severityGiven: 'major' }),
    det('C3', 'jd', 1), // the quote is not in the copy: a verifier cannot be asked about it
    det('C4', 'je', 1), // no claim to show
  ];
  const removed = ['ja#1', 'jb#1', 'jc#2', 'jd#1', 'je#1'];
  const out = chooseControls({ detections, findings, removed, canaries });
  assert.deepEqual(out.map((k) => [k.control, k.canary, k.finding]), [['K1', 'C1', 'ja#1'], ['K2', 'C2', 'jc#2']]);
  assert.equal(out[0].plantedSeverity, 'major', 'the planted class is the floor of the error');
  assert.equal(out[0].claim, 'The sum is wrong.');
  assert.equal(out[0].shown, 'Пакет: 45 €');
});

test('chooseControls: a finding that stayed a real cluster (alsoReal), a missed pair and an under-classified pair are no controls', () => {
  const canaries = [canary('C1'), canary('C2'), canary('C3')];
  const findings = [finding('ja', 1), finding('jb', 1), finding('jc', 1)];
  const detections = [det('C1', 'ja', 1), det('C2', 'jb', 1, { outcome: 'seen_underclassified', severityGiven: 'cosmetic' }), det('C3', 'jc', null, { outcome: 'missed', finding: null })];
  // ja#1 was matched but kept as a real problem: it is not in `removed`
  assert.deepEqual(chooseControls({ detections, findings, removed: ['jb#1'], canaries }), []);
});

test('chooseControls: prefers the match settled by code over the matcher\'s, then the higher score; the planted class of a blocker-floor error is blocker', () => {
  const canaries = [canary('C1', { severityFloor: 'blocker' })];
  const findings = [finding('ja', 1, { problem: 'Matcher says so.' }), finding('jb', 1, { problem: 'Code says so.' }), finding('jc', 1, { problem: 'Matcher, higher score.' })];
  const detections = [det('C1', 'ja', 1, { stage: 'matcher', matcherScore: 4 }), det('C1', 'jb', 1, { stage: 'code' }), det('C1', 'jc', 1, { stage: 'matcher', matcherScore: 5 })];
  const out = chooseControls({ detections, findings, removed: ['ja#1', 'jb#1', 'jc#1'], canaries });
  assert.equal(out.length, 1);
  assert.equal(out[0].claim, 'Code says so.');
  assert.equal(out[0].plantedSeverity, 'blocker');
  const noCode = chooseControls({ detections: [detections[0], detections[2]], findings, removed: ['ja#1', 'jc#1'], canaries });
  assert.equal(noCode[0].claim, 'Matcher, higher score.');
});

test('chooseControls: a missing-part finding (no quote) is shown as «missing: …» like any real item', () => {
  const findings = [finding('ja', 1, { kind: 'omission', quote: null, missingWhat: 'The cancellation terms are not stated.', problem: 'No cancellation terms.', grounded: false })];
  const out = chooseControls({ detections: [det('C1', 'ja', 1)], findings, removed: ['ja#1'], canaries: [canary('C1')] });
  assert.equal(out.length, 1);
  assert.equal(out[0].shown, 'missing: The cancellation terms are not stated.');
  assert.deepEqual(Object.keys(controlView(out[0])).sort(), ['claim', 'file', 'locator', 'shown']);
});

test('controlOutcome: kept only when confirmed at the planted class or above; refuted = dismissed; below = downgraded', () => {
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'major' }, 'major'), 'kept');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'blocker' }, 'major'), 'kept');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'major' }, 'blocker'), 'downgraded');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: 'cosmetic' }, 'major'), 'downgraded');
  assert.equal(controlOutcome({ verdict: 'refuted', severity: null }, 'major'), 'dismissed');
  assert.equal(controlOutcome({ verdict: 'unverifiable', severity: null }, 'major'), 'undecided');
  assert.equal(controlOutcome({ verdict: null, noAnswer: true }, 'major'), 'no-answer');
  assert.equal(controlOutcome(null, 'major'), 'no-answer');
  assert.equal(controlOutcome({ verdict: 'confirmed', severity: null }, 'major'), 'undecided', 'a confirmation without a class is undecided, as for a real item (it must not taint the verifier)');
  for (const o of ['dismissed', 'downgraded']) assert.equal(controlFailed(o), true);
  for (const o of ['kept', 'undecided', 'no-answer']) assert.equal(controlFailed(o), false);
});

test('summariseControls: counts per outcome; the jobs that failed (dismissed or downgraded) are listed once', () => {
  const s = summariseControls([
    { control: 'K1', job: 'a', outcome: 'kept' },
    { control: 'K2', job: 'a', outcome: 'dismissed' },
    { control: 'K3', job: 'a', outcome: 'downgraded' },
    { control: 'K1', job: 'b', outcome: 'kept' },
    { control: 'K2', job: 'b', outcome: 'undecided' },
    { control: 'K3', job: 'c', outcome: 'no-answer' },
  ]);
  assert.deepEqual(s, { presented: 6, answered: 5, kept: 2, dismissed: 1, downgraded: 1, undecided: 1, noAnswer: 1, failedJobs: ['a'] });
});

// ---- the layout among the verifier items

const many = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'C-01-' + String(i + 1).padStart(2, '0'), origin: 'finding', file: 'content/page.md', locator: 'line 3', quote: 'quote number ' + (i + 1), problem: 'The sum is wrong.', kind: 'number',
  members: [], claimedSeverity: 'major', grounded: true, status: 'pending', severity: null, verifiedOn: null, evidence: [], history: [],
}));
const extra = (prefix, key, k, from) => Array.from({ length: k }, (_, i) => ({ id: 'C-01-' + String(from + i), [key]: prefix + (i + 1), file: 'content/page.md', locator: 'line ' + i, shown: prefix + ' quote ' + (i + 1), claim: 'A claim.' }));

test('buildItems with controls and decoys: every verifier batch gets a control when there are as many controls as batches; shapes are alike', () => {
  const cs = many(20);
  const extras = [...extra('K', 'control', 3, 80), ...extra('D', 'decoy', 3, 90)];
  for (const seed of ['11', '12', '13', '14', '15']) {
    const b = buildItems(cs, { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: seed.repeat(16) }), batchMax: 8, decoys: extras });
    assert.equal(b.items.length, 26);
    assert.ok(b.batches.every((x) => x.items.length <= 8), JSON.stringify(b.batches));
    assert.equal(b.batches.length, 4);
    assert.equal(b.controlItems.length, 3);
    assert.equal(b.decoyItems.length, 3);
    const controlNames = new Set(b.controlItems.map((x) => x.item));
    const withControl = b.batches.filter((x) => x.items.some((i) => controlNames.has(i))).length;
    assert.equal(withControl, 3, 'the three controls sit in three different batches: ' + JSON.stringify(b.batches));
    assert.equal(new Set(b.items.map((i) => Object.keys(i).sort().join(','))).size, 1);
    for (const x of b.controlItems) assert.equal(b.hiddenMap['1:' + x.item], x.cluster);
    assert.ok(b.controlItems.every((x) => x.control && !x.decoy));
    assert.ok(b.decoyItems.every((x) => x.decoy && !x.control));
  }
});

test('buildItems with controls only, and without any extra: plain layout is unchanged', () => {
  const cs = many(20);
  const plain = buildItems(cs, { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '21'.repeat(16) }), batchMax: 8 });
  assert.deepEqual(plain.controlItems, []);
  assert.deepEqual(plain.batches.map((x) => x.items.length), [8, 8, 4]);
  const b = buildItems(cs, { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '21'.repeat(16) }), batchMax: 8, decoys: extra('K', 'control', 2, 80) });
  assert.equal(b.controlItems.length, 2);
  assert.deepEqual(b.decoyItems, []);
});

test('buildItems in a confirm round: the controls are in both passes', () => {
  const b = buildItems(many(12), { roundKind: 'confirm', versionHash: 'x', rng: makeRng({ seedHex: '22'.repeat(16) }), batchMax: 8, decoys: extra('K', 'control', 2, 80) });
  for (const p of [1, 2]) assert.equal(b.controlItems.filter((x) => x.pass === p).length, 2);
});

// ---- the setting, the ledger and the statistics

test('the setting: fewer controls than the default needs the owner\'s words; more is stricter', () => {
  const run = applyDefaults({ canaries: { controlsPerRound: 0 } });
  assert.deepEqual(looserLimits(run).map((l) => l.key), ['canaries.controlsPerRound']);
  assert.ok(validateRun({ ...run }).some((e) => /limitsOptIn/.test(e.message)));
  assert.deepEqual(looserLimits(applyDefaults({ canaries: { controlsPerRound: 9 } })), []);
  assert.equal(applyDefaults({}).canaries.controlsPerRound, 4);
});

const RUN = { runId: '20261007-1000-bbbbbb', project: 'demo', artifactType: 'marketing-plan', models: { optIn: [] } };

function controlRows(round, outcomes, job = 'jobbbbbb') {
  return outcomes.map((outcome, i) => ({
    control: `K${(i % 3) + 1}`,
    canary: `C${(i % 3) + 1}`,
    plantedSeverity: 'major',
    wave: 1,
    pass: 1,
    job: `${job}${i % 2}`,
    outcome,
    verdict: outcome === 'dismissed' ? 'refuted' : outcome === 'kept' || outcome === 'downgraded' ? 'confirmed' : null,
    severityGiven: outcome === 'kept' ? 'major' : outcome === 'downgraded' ? 'cosmetic' : null,
    batchTainted: outcome === 'dismissed' || outcome === 'downgraded',
    verifierModel: 'default',
  }));
}

test('control rows: chained file of their own, idempotent per round, fit the m-control schema', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-control-ledger-'));
  try {
    const dp = dataPaths(home);
    const rows = controlRows(1, ['kept', 'dismissed', 'kept', 'downgraded', 'undecided', 'no-answer']);
    const first = appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', controls: rows });
    assert.equal(first.controls, 6);
    assert.equal(appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', controls: rows }).controls, 0);
    const L = readLedger(dp);
    assert.equal(L.controls.length, 6);
    for (const r of L.controls) assert.ok(validate(loadSchema('m-control'), r).ok, JSON.stringify(validate(loadSchema('m-control'), r).errors));
    assert.equal(path.basename(dp.measurements.controls), 'controls.jsonl');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('control rows of a bench run are marked contaminated and stay out of the statistics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-control-bench-'));
  try {
    const dp = dataPaths(home);
    appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', fixedKey: true, controls: controlRows(1, ['dismissed', 'dismissed']) });
    assert.ok(readLedger(dp).controls.every((r) => r.contaminated === true));
    const b = computeStats(dp, {}).instruments['inst-A'];
    assert.equal(b?.controlDismissed?.n ?? 0, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stats: planted real defects dismissed / shown with Clopper-Pearson bounds from 10 on; a missing answer is left out; the report block reads it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-control-stats-'));
  try {
    const dp = dataPaths(home);
    // 14 shown: 10 kept, 2 dismissed, 1 downgraded, 1 undecided, plus 2 without an answer (not counted)
    const outcomes = [...Array(10).fill('kept'), 'dismissed', 'dismissed', 'downgraded', 'undecided', 'no-answer', 'no-answer'];
    appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', controls: controlRows(1, outcomes) });
    const s = computeStats(dp, {});
    const b = s.instruments['inst-A'];
    assert.equal(b.controlDismissed.k, 2);
    assert.equal(b.controlDismissed.n, 14);
    assert.equal(b.controlDismissed.sufficient, true);
    assert.ok(b.controlDismissed.ci[0] > 0.01 && b.controlDismissed.ci[1] < 0.5, JSON.stringify(b.controlDismissed.ci));
    assert.equal(b.controlDowngraded.k, 1);
    assert.match(renderStatsMd(s), /True controls dismissed .* 2\/14 \(95% CI/);
    const forRun = statsForRun(dp, 'inst-A');
    assert.equal(forRun.controlDismissed.k, 2);
    assert.equal(forRun.controlDowngraded.k, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
