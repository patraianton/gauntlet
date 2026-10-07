// Decoys (SPEC 14.11): the checks on the decoy writer's proposals, the arithmetic around them, the
// cross-run ledger rows and their statistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateDecoy,
  chooseDecoys,
  decoyView,
  decoyCountFor,
  opaqueIds,
  decoyOutcome,
  summariseResults,
  decoysWanted,
  candidatesAsked,
  DECOY_SPARES,
} from '../../lib/measure/decoys.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { appendRunRows, readLedger } from '../../lib/measure/mledger.mjs';
import { computeStats, renderStatsMd, statsForRun } from '../../lib/measure/recall.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { applyDefaults, looserLimits, validateRun } from '../../lib/core/config.mjs';

function copyWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-decoy-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

const FILES = {
  'content/leaflet.md': '# Leaflet\n\nRye bread — 3.20 EUR\nCroissant — 1.40 EUR\n\nOrder by phone: +371 2000 0000\n',
  'content/menu.json': JSON.stringify({ items: [{ name: 'Rye bread', price: 3.2 }, { name: 'Croissant', price: 1.4 }] }, null, 2),
};

const good = () => ({
  kind: 'quote',
  file: 'content/leaflet.md',
  locator: 'line 3',
  quote: 'Rye bread — 3.20 EUR',
  missingWhat: '',
  claim: 'The price of rye bread is 3.20 here, but the menu file lists a different price for it.',
  claimedSeverity: 'major',
  whyFalse: 'The menu file lists rye bread at 3.2, the same price.',
  proofFile: 'content/menu.json',
  proofQuote: '"name": "Rye bread",\n      "price": 3.2',
});

test('decoysWanted and candidatesAsked: the default asks for a few spares, 0 or absence switches off', () => {
  assert.equal(decoysWanted(applyDefaults({}) ), 8);
  assert.equal(decoysWanted({ canaries: { decoysPerRound: 0 } }), 0);
  assert.equal(decoysWanted({}), 0, 'a run without the setting runs no decoys');
  assert.equal(candidatesAsked(5), 5 + DECOY_SPARES);
});

test('validateDecoy: a decoy with a quote in its file and a proof in the copy passes', () => {
  const dir = copyWith(FILES);
  try {
    const v = validateDecoy(good(), { copyDir: dir });
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
    // a missing-kind decoy proves its claim wrong with text that is present
    const m = validateDecoy(
      { kind: 'missing', file: 'content/leaflet.md', locator: 'whole leaflet', quote: '', missingWhat: 'The leaflet gives no phone number for orders.', claim: 'Customers are told to order but the leaflet never says by which phone number.', claimedSeverity: 'major', whyFalse: 'The last line gives the phone number.', proofFile: 'content/leaflet.md', proofQuote: 'Order by phone: +371 2000 0000' },
      { copyDir: dir },
    );
    assert.deepEqual(m.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateDecoy: every way a decoy can be useless or give itself away is refused', () => {
  const dir = copyWith(FILES);
  try {
    const bad = (patch, re, opts = {}) => {
      const v = validateDecoy({ ...good(), ...patch }, { copyDir: dir, ...opts });
      assert.equal(v.ok, false, JSON.stringify(patch));
      assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(patch)} -> ${v.errors.join(' | ')}`);
    };
    bad({ quote: 'Rye bread — 9.99 EUR' }, /quote-not-found-in-file/);
    bad({ quote: 'EUR' }, /quote-too-short/);
    // a quote that exists in the copy, but not in the file the decoy names, is not a quote of that file
    bad({ quote: 'Order by phone: +371 2000 0000', file: 'content/menu.json' }, /quote-not-found-in-file/);
    bad({ proofQuote: 'a price nobody wrote anywhere in the work' }, /proof-not-found-in-file/);
    bad({ proofQuote: 'short' }, /proof-too-short/);
    bad({ proofFile: 'content/nothing.md' }, /proof-file-unusable/);
    bad({ file: '../outside.md' }, /file-unusable/);
    bad({ proofFile: 'content/leaflet.md', proofQuote: 'Rye bread — 3.20 EUR' }, /proof-is-the-quote/);
    bad({ kind: 'other' }, /bad-kind/);
    bad({ kind: 'missing', missingWhat: 'short' }, /missing-what-too-short/);
    // the words a verifier sees may not betray the check
    bad({ claim: 'This is a decoy: the price is fine but I was asked to write a false report about it.' }, /giveaway-in-claim/);
    bad({ claim: 'The price of rye bread was TODO checked in review round 3 and found wrong against the menu.' }, /giveaway-in-claim/);
    // never on a planted edit: the text there is wrong on purpose, a claim about it may be true
    bad({}, /touches-a-planted-edit/, { canaries: [{ file: 'content/leaflet.md', after: 'Rye bread — 3.20 EUR' }] });
    bad({}, /proof-touches-a-planted-edit/, { canaries: [{ file: 'content/menu.json', after: '"name": "Rye bread",\n      "price": 3.2' }] });
    // two decoys on the same passage are one decoy
    bad({}, /duplicate-quote/, { taken: [{ kind: 'quote', file: 'content/leaflet.md', quote: 'Rye bread — 3.20 EUR' }] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseDecoys: numbers the valid ones D1..Dn in answer order, keeps the reasons for the rest, stops at the limit', () => {
  const dir = copyWith(FILES);
  try {
    const cands = [good(), { ...good(), quote: 'nothing like this in the file' }, { ...good(), quote: 'Croissant — 1.40 EUR', locator: 'line 4', proofQuote: '"name": "Croissant",\n      "price": 1.4' }];
    const r = chooseDecoys(cands, { copyDir: dir, perRound: 1 });
    assert.deepEqual(r.chosen.map((d) => d.decoy), ['D1', 'D2']);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].index, 1);
    const capped = chooseDecoys(cands, { copyDir: dir, perRound: 0 }); // asks for 0 + 2 spares
    assert.equal(capped.chosen.length, 2);
    for (const d of r.chosen) assert.ok(d.claim && d.proofQuote && d.whyFalse, 'the key keeps the proof');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decoyView: a decoy is shown with the same four fields as a real item; a missing-kind one in the same "missing:" form', () => {
  const q = decoyView({ kind: 'quote', file: 'content/a.md', locator: 'line 2', quote: 'Some exact text here', claim: 'Wrong.'.repeat(80) });
  assert.deepEqual(Object.keys(q).sort(), ['claim', 'file', 'locator', 'shown']);
  assert.equal(q.shown, 'Some exact text here');
  assert.ok(q.claim.length <= 300, 'the claim is cut like a real problem text');
  const m = decoyView({ kind: 'missing', file: 'content/a.md', locator: 'whole', missingWhat: 'A phone number is missing.', claim: 'No phone.' });
  assert.equal(m.shown, 'missing: A phone number is missing.');
});

test('decoyCountFor: at least one per batch when there are enough, never more than the run asked or half the real items', () => {
  const f = (o) => decoyCountFor({ available: 10, perRound: 8, realItems: 66, batchMax: 8, ...o });
  assert.equal(f({}), 8, '9 batches, but the run asked for 8');
  assert.equal(f({ perRound: 4 }), 4);
  assert.equal(f({ realItems: 20 }), 3, '3 batches');
  assert.equal(f({ realItems: 4 }), 2, 'half of 4 real items');
  assert.equal(f({ realItems: 1 }), 1);
  assert.equal(f({ realItems: 0 }), 0, 'nothing to verify, nothing to test');
  assert.equal(f({ available: 0 }), 0);
  assert.equal(f({ perRound: 0 }), 0);
  assert.equal(f({ available: 2 }), 2);
});

test('opaqueIds: the format of real cluster ids, numbered after the real ones of the round', () => {
  assert.deepEqual(opaqueIds(1, ['C-01-01', 'C-01-04', 'C-02-09'], 2), ['C-01-05', 'C-01-06']);
  assert.deepEqual(opaqueIds(3, [], 1), ['C-03-01']);
  for (const id of opaqueIds(2, ['C-02-11'], 3)) assert.match(id, /^C-\d{2}-\d{2,}$/);
});

test('decoyOutcome and summariseResults: refuted is rejected, confirmed is accepted, a missing answer is not counted', () => {
  assert.equal(decoyOutcome({ verdict: 'refuted' }), 'rejected');
  assert.equal(decoyOutcome({ verdict: 'confirmed' }), 'confirmed');
  assert.equal(decoyOutcome({ verdict: 'unverifiable' }), 'undecided');
  assert.equal(decoyOutcome({ verdict: 'refuted', noAnswer: true }), 'no-answer');
  assert.equal(decoyOutcome(null), 'no-answer');
  const s = summariseResults([
    { decoy: 'D1', job: 'a', outcome: 'rejected' },
    { decoy: 'D2', job: 'a', outcome: 'confirmed' },
    { decoy: 'D3', job: 'b', outcome: 'rejected' },
    { decoy: 'D4', job: 'b', outcome: 'undecided' },
    { decoy: 'D5', job: 'c', outcome: 'no-answer' },
  ]);
  assert.deepEqual(s, { presented: 5, answered: 4, rejected: 2, confirmed: 1, undecided: 1, noAnswer: 1, taintedJobs: ['a'] });
});

test('the setting: fewer decoys than the default needs the owner\'s words, like every protection that could be switched off', () => {
  const run = applyDefaults({ canaries: { decoysPerRound: 0 } });
  assert.deepEqual(looserLimits(run).map((l) => l.key), ['canaries.decoysPerRound']);
  assert.ok(validateRun({ ...run }).some((e) => /limitsOptIn/.test(e.message)));
  assert.deepEqual(looserLimits(applyDefaults({ canaries: { decoysPerRound: 12 } })), [], 'more decoys is stricter, no words needed');
});

// ---------------------------------------------------------------- ledger and statistics

const RUN = { runId: '20260116-1000-aaaaaa', project: 'demo', artifactType: 'marketing-plan', models: { optIn: [] } };

function decoyRows(round, outcomes, job = 'jobaaaaa') {
  return outcomes.map((outcome, i) => ({
    decoy: `D${i + 1}`,
    kind: i % 2 ? 'missing' : 'quote',
    claimedSeverity: 'major',
    wave: 1,
    pass: 1,
    job: `${job}${i % 2}`,
    outcome,
    verdict: outcome === 'rejected' ? 'refuted' : outcome === 'confirmed' ? 'confirmed' : null,
    severityGiven: outcome === 'confirmed' ? 'major' : null,
    batchTainted: outcome === 'confirmed',
    verifierModel: 'default',
  }));
}

test('decoy rows: chained file of their own, idempotent per round, fit the m-decoy schema', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-decoy-ledger-'));
  try {
    const dp = dataPaths(home);
    const rows = decoyRows(1, ['rejected', 'rejected', 'confirmed', 'rejected']);
    const first = appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', decoys: rows });
    assert.equal(first.decoys, 4);
    assert.equal(appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', decoys: rows }).decoys, 0);
    const L = readLedger(dp);
    assert.equal(L.decoys.length, 4);
    for (const r of L.decoys) assert.ok(validate(loadSchema('m-decoy'), r).ok, JSON.stringify(validate(loadSchema('m-decoy'), r).errors));
    assert.equal(path.basename(dp.measurements.decoys), 'decoys.jsonl');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stats: decoys rejected / shown with Clopper-Pearson bounds from 10 on; a missing answer is left out; the report block reads it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-decoy-stats-'));
  try {
    const dp = dataPaths(home);
    // 14 shown: 11 rejected, 2 accepted, 1 undecided, plus 2 without an answer (not counted)
    const outcomes = [...Array(11).fill('rejected'), 'confirmed', 'confirmed', 'undecided', 'no-answer', 'no-answer'];
    appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', decoys: decoyRows(1, outcomes) });
    const s = computeStats(dp, {});
    const b = s.instruments['inst-A'];
    assert.equal(b.decoyRejection.k, 11);
    assert.equal(b.decoyRejection.n, 14);
    assert.equal(b.decoyRejection.sufficient, true);
    assert.ok(b.decoyRejection.ci[0] > 0.45 && b.decoyRejection.ci[1] < 0.97, JSON.stringify(b.decoyRejection.ci));
    assert.ok(b.decoyRejection.lower > 0.5 && b.decoyRejection.lower < 0.79);
    assert.equal(b.decoyConfirmed.k, 2);
    assert.match(renderStatsMd(s), /Decoys rejected .* 11\/14 \(95% CI/);
    const forRun = statsForRun(dp, 'inst-A');
    assert.equal(forRun.decoyRejection.k, 11);
    // below 10 shown: marked insufficient, no interval
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-decoy-stats2-'));
    try {
      const dp2 = dataPaths(home2);
      appendRunRows(dp2, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', decoys: decoyRows(1, ['rejected', 'confirmed']) });
      const b2 = computeStats(dp2, {}).instruments['inst-A'];
      assert.equal(b2.decoyRejection.sufficient, false);
      assert.equal(b2.decoyRejection.ci, null);
    } finally {
      fs.rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stats: decoy rows of a bench run (contaminated) are kept out of every number', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-decoy-stats3-'));
  try {
    const dp = dataPaths(home);
    const bench = { ...RUN, canaries: { fixedKey: { path: 'x' } } };
    appendRunRows(dp, { run: bench, round: 1, roundKind: 'working', instrumentId: 'inst-A', decoys: decoyRows(1, Array(12).fill('rejected')) });
    assert.equal(readLedger(dp).decoys.every((r) => r.contaminated), true);
    assert.deepEqual(computeStats(dp, {}).instruments, {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
