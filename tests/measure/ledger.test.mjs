import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { appendRunRows, appendRunEnd, appendEscape, ledgerCounts, readLedger, verdictRowFromCluster } from '../../lib/measure/mledger.mjs';
import { computeStats, renderStatsMd, statsForRun } from '../../lib/measure/recall.mjs';
import { importLegacy, DEFAULT_LEGACY_FILE } from '../../lib/measure/legacy.mjs';
import { clopperPearson } from '../../lib/measure/stats.mjs';
import { run as ledgerCmd } from '../../lib/measure/cmd-ledger.mjs';

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ledger-'));
}

const LENSES = [
  { id: 'facts', title: 'Facts and numbers' },
  { id: 'language', title: 'Language' },
  { id: 'conversion', title: 'Path to the request' },
];
const RUN = { runId: '20260115-0930-a1b2c3', project: 'demo', artifactType: 'marketing-plan', models: { optIn: [] } };

/** A round with 3 attention canaries (one per lens) + 1 omission measurement canary. */
function roundData(round, ownCaught) {
  const canaries = [
    { canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', band: 'start', positionFraction: 0.1, intendedSeverity: 'blocker', validatorSeverity: 'major', prePlanted: false, description: 'sum' },
    { canary: 'C2', slot: 'S2', purpose: 'attention', targetLens: 'language', type: 'LANG', band: 'middle', positionFraction: 0.5, intendedSeverity: 'major', validatorSeverity: 'major', prePlanted: false, description: 'case' },
    { canary: 'C3', slot: 'S3', purpose: 'attention', targetLens: 'conversion', type: 'PATH', band: 'end', positionFraction: 0.9, intendedSeverity: 'major', validatorSeverity: 'major', prePlanted: false, description: 'cta' },
    { canary: 'C4', slot: 'S4', purpose: 'measurement', targetLens: 'conversion', type: 'OMIT-REQ', band: 'start', positionFraction: 0.2, intendedSeverity: 'major', validatorSeverity: 'major', prePlanted: false, description: 'removed item' },
  ];
  const detections = [];
  for (const c of canaries) {
    for (const l of LENSES) {
      let outcome = 'missed';
      if (c.targetLens === l.id && c.purpose === 'attention') outcome = ownCaught.includes(c.canary) ? 'caught' : 'missed';
      if (c.canary === 'C1' && l.id === 'language') outcome = 'seen_underclassified';
      detections.push({ canary: c.canary, purpose: c.purpose, targetLens: c.targetLens, lens: l.id, job: `j${l.id.slice(0, 4)}${round}`, attempt: 1, outcome, finding: outcome === 'missed' ? null : 1, stage: outcome === 'missed' ? null : 'code', matcherScore: null, severityGiven: outcome === 'caught' ? 'major' : outcome === 'missed' ? null : 'cosmetic' });
    }
  }
  const clusters = [
    { id: `C-0${round}-01`, origin: 'finding', claimedSeverity: 'blocker', status: 'open', severity: 'major', grounded: true, members: [{ round, lens: 'facts', job: 'a', n: 1 }], evidence: [{ round, verdict: 'confirmed', severity: 'major' }] },
    { id: `C-0${round}-02`, origin: 'finding', claimedSeverity: 'major', status: 'dropped', severity: null, grounded: false, members: [{ round, lens: 'language', job: 'b', n: 2 }], evidence: [{ round, verdict: 'refuted', severity: null }] },
  ];
  return { key: { schemaVersion: 1, runId: RUN.runId, round, seedHex: 'ab', canaries }, detections, verdicts: clusters.map((c) => verdictRowFromCluster(c, { round, roundKind: 'working', kind: 'fact' })) };
}

test('measurement rows are chained, idempotent per round, and fit the m-* schemas', () => {
  const h = home();
  try {
    const dp = dataPaths(h);
    const d = roundData(1, ['C1', 'C2']);
    const first = appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', lenses: LENSES, ...d, materialChars: 5000 });
    assert.deepEqual(first, { canaries: 4, detections: 12, verdicts: 2, decoys: 0, controls: 0 });
    const again = appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', lenses: LENSES, ...d });
    assert.deepEqual(again, { canaries: 0, detections: 0, verdicts: 0, decoys: 0, controls: 0 });
    appendRunEnd(dp, { runId: RUN.runId, project: 'demo', artifactType: 'marketing-plan', instrumentId: 'inst-A', decision: 'FIX', rounds: 1, tokens: 1800000, tokensEstimated: true });
    appendEscape(dp, { runId: RUN.runId, description: 'A wrong price found by a customer', severity: 'blocker', lens: 'none', foundBy: 'production', ownerQuote: 'клиент нашёл неверную цену', question: 'Что нашёл клиент и стоит ли это записать как пропущенную ошибку?' });
    assert.throws(() => appendEscape(dp, { runId: RUN.runId, description: 'A wrong price', severity: 'major', lens: 'none' }), /owner/);
    assert.throws(() => appendEscape(dp, { runId: RUN.runId, description: 'cosmetic thing', severity: 'cosmetic', lens: 'none' }), /severity/);
    assert.throws(() => appendEscape(dp, { runId: RUN.runId, description: 'x', severity: 'major', lens: 'none' }), /description/);
    const L = readLedger(dp);
    const check = (schema, rows) => rows.forEach((r) => assert.ok(validate(loadSchema(schema), r).ok, `${schema}: ${JSON.stringify(validate(loadSchema(schema), r).errors)}`));
    check('m-canary', L.canaries);
    check('m-detection', L.detections);
    check('m-verdict', L.verdicts);
    check('m-run', L.runs);
    check('m-escape', L.escapes);
    assert.equal(L.canaries[0].targetLens.title, 'Facts and numbers');
    assert.equal(L.canaries[0].planterIndependent, true);
    assert.equal(L.detections[0].reviewerModel, 'default');
    const res = ledgerCounts(dp, { artifactType: 'marketing-plan', instrumentId: 'inst-A' });
    assert.deepEqual(res.byType, { 'FACT-NUM': 1, LANG: 1, PATH: 1, 'OMIT-REQ': 1 });
    assert.deepEqual(res.byBand, { start: 2, middle: 1, end: 1 });
    assert.equal(res.omission, 1);
    assert.deepEqual(ledgerCounts(dp, { artifactType: 'code' }), { byType: {}, byBand: {}, omission: 0 });
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('stats on a synthetic ledger: units, insufficient labels, exact intervals', () => {
  const h = home();
  try {
    const dp = dataPaths(h);
    appendRunRows(dp, { run: RUN, round: 1, roundKind: 'working', instrumentId: 'inst-A', lenses: LENSES, ...roundData(1, ['C1', 'C2']) });
    let s = computeStats(dp, {});
    let b = s.instruments['inst-A'];
    assert.deepEqual([b.ownLens.k, b.ownLens.n, b.ownLens.sufficient, b.ownLens.ci], [2, 3, false, null]);
    assert.equal(b.ownLensHeadline, 'insufficient data (3 of 25)');
    assert.match(renderStatsMd(s), /insufficient/);
    assert.match(renderStatsMd(s), /pairs are not independent; no interval/);
    // three more rounds -> 12 attention canaries
    appendRunRows(dp, { run: RUN, round: 2, roundKind: 'working', instrumentId: 'inst-A', lenses: LENSES, ...roundData(2, ['C1', 'C2', 'C3']) });
    appendRunRows(dp, { run: RUN, round: 3, roundKind: 'working', instrumentId: 'inst-A', lenses: LENSES, ...roundData(3, ['C1', 'C3']) });
    appendRunRows(dp, { run: RUN, round: 4, roundKind: 'confirm', instrumentId: 'inst-A', lenses: LENSES, ...roundData(4, ['C1', 'C2', 'C3']) });
    s = computeStats(dp, {});
    b = s.instruments['inst-A'];
    assert.deepEqual([b.ownLens.k, b.ownLens.n], [10, 12]);
    assert.deepEqual(b.ownLens.ci, clopperPearson(10, 12));
    assert.ok(b.ownLens.lower > 0.5 && b.ownLens.lower < b.ownLens.ci[0] + 0.05);
    assert.equal(b.ownLensHeadline, 'insufficient data (12 of 25)');
    assert.deepEqual([b.panel.all.k, b.panel.all.n], [10, 16], 'panel recall counts canaries, not pairs');
    assert.deepEqual([b.panel.measurement.k, b.panel.measurement.n], [0, 4]);
    assert.deepEqual([b.omission.k, b.omission.n], [0, 4]);
    assert.deepEqual([b.pairs.k, b.pairs.n, b.pairs.ci], [10, 48, null]);
    assert.deepEqual([b.knowsButPasses.k, b.knowsButPasses.n], [4, 14]);
    assert.deepEqual([b.unanimousMiss.k, b.unanimousMiss.n], [6, 16]);
    assert.deepEqual([b.verifierRejection.k, b.verifierRejection.n], [4, 8]);
    assert.deepEqual([b.verifierDowngrade.k, b.verifierDowngrade.n], [4, 4]);
    assert.deepEqual(Object.keys(b.ownLensBy.lens), ['Facts and numbers', 'Language', 'Path to the request']);
    assert.deepEqual([b.ownLensBy.lens['Facts and numbers'].k, b.ownLensBy.lens['Facts and numbers'].n], [4, 4]);
    const md = renderStatsMd(s);
    assert.match(md, /10\/12 \(95% CI/);
    assert.match(md, /planted errors are easier to find than real ones/);
    const r = statsForRun(dp, 'inst-A');
    assert.deepEqual([r.ownLens.k, r.ownLens.n, r.enough, r.headlineN], [10, 12, false, 25]);
    // a second instrument triggers the pooled view; filters work
    appendRunRows(dp, { run: { ...RUN, runId: 'other-run' }, round: 1, roundKind: 'working', instrumentId: 'inst-B', lenses: LENSES, ...roundData(1, ['C1']) });
    s = computeStats(dp, {});
    assert.ok(s.pooled);
    assert.match(renderStatsMd(s), /Pooled view/);
    assert.deepEqual(Object.keys(computeStats(dp, { instrumentId: 'inst-B' }).instruments), ['inst-B']);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('legacy import: contaminated, idempotent, separate table with the transcribed numbers', () => {
  const h = home();
  try {
    const dp = dataPaths(h);
    const first = importLegacy(dp, DEFAULT_LEGACY_FILE);
    assert.equal(first.skipped, 0);
    assert.ok(first.added >= 115);
    const second = importLegacy(dp, DEFAULT_LEGACY_FILE);
    assert.deepEqual(second, { added: 0, skipped: first.added });
    const L = readLedger(dp);
    assert.ok([...L.runs, ...L.canaries, ...L.detections].every((r) => r.contaminated === true));
    assert.ok(L.canaries.every((c) => c.planterIndependent === false));
    assert.equal(L.canaries.filter((c) => c.type.startsWith('OMIT')).length, 0, 'no omission canaries in the legacy data');
    for (const r of L.detections) assert.ok(validate(loadSchema('m-detection'), r).ok);
    const s = computeStats(dp, {});
    assert.deepEqual(Object.keys(s.instruments), [], 'contaminated rows stay out of every figure');
    const legacy = JSON.parse(fs.readFileSync(DEFAULT_LEGACY_FILE, 'utf8'));
    const table = Object.fromEntries(s.legacy.map((l) => [l.runId, `${l.pairs.k}/${l.pairs.n} ${l.ownLens.k}/${l.ownLens.n}`]));
    for (const [runId, exp] of Object.entries(legacy.expected)) assert.equal(table[runId], `${exp.pairsFound} ${exp.ownLens}`, runId);
    const md = renderStatsMd(s);
    assert.match(md, /Legacy data \(contaminated\)/);
    assert.match(md, /Omission recall: no data/);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('legacy transcription matches the recorded matrix (own lens 2/5 old, 4/5 new; K5 found by nobody)', () => {
  const legacy = JSON.parse(fs.readFileSync(DEFAULT_LEGACY_FILE, 'utf8'));
  for (const arm of ['old', 'new']) {
    const rows = legacy.detections.filter((d) => d.runId === `legacy-2026-10-05-${arm}`);
    assert.equal(rows.length, 25);
    assert.equal(rows.filter((d) => d.canary === 'K5' && d.outcome !== 'missed').length, 0);
  }
  const oldRisk = legacy.detections.find((d) => d.runId === 'legacy-2026-10-05-old' && d.lens === 'risk' && d.canary === 'K4');
  assert.equal(oldRisk.outcome, 'seen_underclassified', 'a minor mark is below the major floor');
});

test('cmd-ledger: stats writes STATS.md/json, import-legacy, add-escape, verify-chain detects tampering', async () => {
  const h = home();
  try {
    const ctx = { dataHome: h, json: false, env: {} };
    const imp = await ledgerCmd(['import-legacy'], ctx);
    assert.equal(imp.exitCode, 0);
    assert.ok(imp.payload.added > 0);
    const st = await ledgerCmd(['ledger', 'stats', '--md'], ctx);
    assert.equal(st.exitCode, 0);
    const dp = dataPaths(h);
    assert.ok(fs.existsSync(dp.statsMd) && fs.existsSync(dp.statsJson));
    assert.match(st.text, /Legacy data/);
    await assert.rejects(ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong on the live site', '--severity', 'major', '--lens', 'facts', '--found-by', 'owner'], ctx), /owner-quote/);
    // the owner's words without the question they answer are refused, like every owner decision
    await assert.rejects(ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong on the live site', '--severity', 'major', '--lens', 'facts', '--found-by', 'owner', '--owner-quote', 'на сайте неверная цена, запиши'], ctx), /needs --question/);
    // ... a question that is just the owner's answer again is refused too
    await assert.rejects(ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong on the live site', '--severity', 'major', '--lens', 'facts', '--owner-quote', 'на сайте неверная цена, запиши', '--question', 'на сайте неверная цена, запиши'], ctx), /not the answer repeated/);
    const esc = await ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong on the live site', '--severity', 'major', '--lens', 'facts', '--found-by', 'owner', '--owner-quote', 'на сайте неверная цена, запиши', '--question', 'Цена на сайте не совпадает с ценой в плане: записать это как пропущенную ошибку?'], ctx);
    assert.equal(esc.exitCode, 0);
    // a one-word answer is recorded as said, with its question
    const short = await ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong on the live site', '--severity', 'major', '--lens', 'facts', '--owner-quote', 'да', '--question', 'Записать цену на сайте как пропущенную ошибку?'], ctx);
    assert.equal(short.exitCode, 0);
    const rows = readLedger(dataPaths(h)).escapes;
    assert.equal(rows.at(-1).ownerQuote, 'да');
    assert.match(rows.at(-1).question, /Записать цену/);
    await assert.rejects(ledgerCmd(['add-escape', '--run', 'r1', '--description', 'Price wrong', '--severity', 'major'], ctx), /--lens/);
    await assert.rejects(ledgerCmd(['nope'], ctx), /usage/);
    await assert.rejects(ledgerCmd(['stats', '--bogus'], ctx), /unknown option/);
    let v = await ledgerCmd(['verify-chain'], ctx);
    assert.equal(v.exitCode, 0);
    const file = dp.measurements.detections;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.match(lines[1], /"missed"/);
    lines[1] = lines[1].replace('"missed"', '"caught"');
    fs.writeFileSync(file, lines.join('\n'));
    v = await ledgerCmd(['verify-chain'], ctx);
    assert.equal(v.exitCode, 3);
    assert.match(v.text, /BROKEN/);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
