// Verifier items and every row of the class tables (SPEC 12.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, applyVerdicts, firstVerdict, combineTwo, itemView, selectForVerification, settleCosmetic, settleUnverified } from '../../lib/engine/verify.mjs';
import { makeRng } from '../../lib/core/rand.mjs';
import { bandFor, panelBand } from '../../lib/engine/band.mjs';

const C = (over = {}) => ({
  id: 'C-01-01',
  origin: 'finding',
  file: 'content/page.md',
  locator: 'line 3',
  quote: 'Пакет: 50 €',
  problem: 'The sum is wrong.',
  kind: 'number',
  fix: 'Use 45 €',
  members: [{ round: 1, lens: 'facts', job: 'aaaaaaaa', n: 1, severity: 'major' }],
  claimedSeverity: 'major',
  grounded: true,
  status: 'pending',
  severity: null,
  verifiedOn: null,
  evidence: [],
  history: [],
  ...over,
});
const V = (verdict, severity = null, extra = {}) => ({ verdict, severity, evidence: 'checked the file and the source', ...extra });

// ---- first verifier (working round)
const FIRST = [
  ['confirmed major, grounded -> open/major', C(), V('confirmed', 'major'), false, { status: 'open', severity: 'major' }],
  ['confirmed blocker -> open/blocker', C(), V('confirmed', 'blocker'), false, { status: 'open', severity: 'blocker' }],
  ['confirmed cosmetic -> cosmetic', C(), V('confirmed', 'cosmetic'), false, { status: 'cosmetic', severity: 'cosmetic' }],
  ['confirmed, item ungrounded, quoteNow not grounded -> unverified (claimed)', C({ grounded: false }), V('confirmed', 'major'), false, { status: 'unverified', severity: 'major' }],
  ['confirmed, item ungrounded, quoteNow grounded -> open', C({ grounded: false }), V('confirmed', 'major', { quoteNowGrounded: true }), false, { status: 'open', severity: 'major' }],
  ['refuted, ungrounded, new -> dropped', C({ grounded: false, claimedSeverity: 'blocker' }), V('refuted'), false, { status: 'dropped' }],
  ['refuted, claimed blocker -> second verifier', C({ claimedSeverity: 'blocker' }), V('refuted'), false, { needSecond: true }],
  ['refuted, carry-over -> second verifier', C({ status: 'open', severity: 'major' }), V('refuted'), true, { needSecond: true }],
  ['refuted, otherwise -> dropped', C(), V('refuted'), false, { status: 'dropped' }],
  ['unverifiable -> unverified at the claimed class', C({ claimedSeverity: 'blocker' }), V('unverifiable'), false, { status: 'unverified', severity: 'blocker' }],
  ['missing verdict -> unverified (fail-closed)', C(), null, false, { status: 'unverified', severity: 'major' }],
  ['confirmed without a class -> unverified', C(), V('confirmed', null), false, { status: 'unverified', severity: 'major' }],
];
for (const [name, c, v, carry, want] of FIRST) {
  test(`first verifier: ${name}`, () => {
    const r = firstVerdict(c, v, carry);
    for (const [k, x] of Object.entries(want)) assert.equal(r[k], x, `${k}: ${JSON.stringify(r)}`);
  });
}

// ---- two verdicts (second verifier, or both verifiers of a confirm round)
const TWO = [
  ['both confirmed -> open at the stricter class', C(), V('confirmed', 'blocker'), V('confirmed', 'major'), false, { status: 'open', severity: 'blocker' }],
  ['both confirmed, major + cosmetic -> open at major (never weakened)', C(), V('confirmed', 'major'), V('confirmed', 'cosmetic'), false, { status: 'open', severity: 'major' }],
  ['both confirmed, blocker + cosmetic -> open at blocker (never weakened)', C(), V('confirmed', 'blocker'), V('confirmed', 'cosmetic'), false, { status: 'open', severity: 'blocker' }],
  ['both confirmed cosmetic -> cosmetic', C(), V('confirmed', 'cosmetic'), V('confirmed', 'cosmetic'), false, { status: 'cosmetic', severity: 'cosmetic' }],
  ['both refuted -> dropped', C(), V('refuted'), V('refuted'), false, { status: 'dropped' }],
  ['both refuted, carry-over -> closed', C({ status: 'open' }), V('refuted'), V('refuted'), true, { status: 'closed' }],
  ['confirmed blocker + refuted -> contested at major', C(), V('confirmed', 'blocker'), V('refuted'), false, { status: 'contested', severity: 'major' }],
  ['refuted + confirmed major -> contested at major', C(), V('refuted'), V('confirmed', 'major'), false, { status: 'contested', severity: 'major' }],
  ['unverifiable + refuted -> unverified at the claimed class', C({ claimedSeverity: 'blocker' }), V('unverifiable'), V('refuted'), false, { status: 'unverified', severity: 'blocker' }],
  ['unverifiable + confirmed -> unverified at the confirmed class', C({ claimedSeverity: 'blocker' }), V('unverifiable'), V('confirmed', 'major'), false, { status: 'unverified', severity: 'major' }],
  ['one verdict missing -> unverified', C(), V('confirmed', 'major'), undefined, false, { status: 'unverified', severity: 'major' }],
];
for (const [name, c, a, b, carry, want] of TWO) {
  test(`two verifiers: ${name}`, () => {
    const r = combineTwo(c, a, b, carry);
    for (const [k, x] of Object.entries(want)) assert.equal(r[k], x, `${k}: ${JSON.stringify(r)}`);
  });
}

test('applyVerdicts: statuses, verifiedOn, history, needSecond; no mutation of the input', () => {
  const clusters = [C({ id: 'C-01-01' }), C({ id: 'C-01-02', claimedSeverity: 'blocker' }), C({ id: 'C-01-03' })];
  const frozen = JSON.stringify(clusters);
  const res = applyVerdicts(
    clusters,
    { 'C-01-01': [{ ...V('confirmed', 'major'), job: 'j1', pass: 1 }], 'C-01-02': [{ ...V('refuted'), job: 'j1', pass: 1 }] },
    { roundKind: 'working', pass: 1, round: 1, versionHash: 'vh1' },
  );
  assert.equal(JSON.stringify(clusters), frozen);
  assert.equal(res.clusters[0].status, 'open');
  assert.equal(res.clusters[0].verifiedOn, 'vh1');
  assert.equal(res.clusters[0].history.at(-1).to, 'open');
  assert.deepEqual(res.needSecond, ['C-01-02']);
  assert.equal(res.clusters[2].status, 'pending', 'clusters without verdict entries are untouched');
  const second = applyVerdicts(
    res.clusters,
    { 'C-01-02': [{ ...V('refuted'), job: 'j1', pass: 1 }, { ...V('refuted'), job: 'j2', pass: 2 }] },
    { roundKind: 'working', pass: 2, round: 1, versionHash: 'vh1' },
  );
  assert.equal(second.clusters[1].status, 'dropped');
});

test('buildItems: confirm round puts every item in two batches; verifiers never see class, lens, fix or origin', () => {
  const clusters = [C({ id: 'C-01-01' }), C({ id: 'C-01-02', origin: 'requirement', file: null, quote: null, missingWhat: 'a call to action in every post' })];
  const rng = { shuffle: (a) => [...a].reverse() };
  const built = buildItems(clusters, { roundKind: 'confirm', versionHash: 'v', rng, batchMax: 1 });
  assert.equal(built.items.length, 4);
  assert.equal(built.batches.length, 4);
  for (const id of ['C-01-01', 'C-01-02']) assert.equal(built.items.filter((i) => i.cluster === id).length, 2);
  for (const it of built.items) {
    for (const k of ['severity', 'claimedSeverity', 'lens', 'members', 'fix', 'origin']) assert.ok(!(k in it), `item exposes ${k}`);
  }
  assert.match(built.items.find((i) => i.cluster === 'C-01-02').shown, /^missing: /);
  const w = buildItems(clusters, { roundKind: 'working', versionHash: 'v', rng, batchMax: 8 });
  assert.equal(w.items.length, 2);
  assert.equal(w.batches.length, 1);
});

test('selectForVerification: new serious, carry-over on a changed version; union rule keeps same-version carry-overs', () => {
  const clusters = [
    C({ id: 'a', status: 'pending', claimedSeverity: 'major' }),
    C({ id: 'b', status: 'pending', claimedSeverity: 'cosmetic' }),
    C({ id: 'c', status: 'open', severity: 'major', verifiedOn: 'old' }),
    C({ id: 'd', status: 'open', severity: 'major', verifiedOn: 'now' }),
    C({ id: 'e', status: 'closed', severity: 'major', verifiedOn: 'old' }),
  ];
  const s = selectForVerification(clusters, { versionHash: 'now' });
  assert.deepEqual(s.verify, ['a', 'c']);
  assert.deepEqual(s.cosmeticOnly, ['b']);
  const settled = settleCosmetic(clusters, s.cosmeticOnly, { round: 2, versionHash: 'now' });
  assert.equal(settled[1].status, 'cosmetic');
});

test('itemView: claim cut at 300 characters', () => {
  const v = itemView(C({ problem: 'x'.repeat(500) }));
  assert.ok(v.claim.length <= 300);
});

test('band: table of SPEC 13.5 and the worst lens', () => {
  assert.deepEqual(bandFor({ blockers: 1 }), [5.5, 6.0]);
  assert.deepEqual(bandFor({ blockers: 3 }), [3.5, 4.0]);
  assert.deepEqual(bandFor({ blockers: 9 }), [0.5, 1.0]);
  assert.deepEqual(bandFor({ majors: 3 }), [6.5, 7.5]);
  assert.deepEqual(bandFor({ majors: 2 }), [7.6, 8.9]);
  assert.deepEqual(bandFor({ cosmetics: 4 }), [9.0, 9.7]);
  assert.deepEqual(bandFor({}), [9.8, 10]);
  assert.deepEqual(panelBand({ a: [9.8, 10], b: [7.6, 8.9], c: [9.0, 9.7] }), [7.6, 8.9]);
});

// ---- decoys mixed into the batches (SPEC 14.11)
const many = (n) => Array.from({ length: n }, (_, i) => C({ id: 'C-01-' + String(i + 1).padStart(2, '0'), claimedSeverity: 'major', quote: 'quote number ' + (i + 1) }));
const decoyList = (k) => Array.from({ length: k }, (_, i) => ({ id: 'C-01-' + String(90 + i), decoy: 'D' + (i + 1), file: 'content/page.md', locator: 'line ' + i, shown: 'decoy quote ' + (i + 1), claim: 'A claim that is not true.' }));

test('buildItems without decoys keeps the plain layout (chunks of the shuffled ids)', () => {
  const cs = many(20);
  const b = buildItems(cs, { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '01'.repeat(16) }), batchMax: 8 });
  assert.deepEqual(b.batches.map((x) => x.items.length), [8, 8, 4]);
  assert.deepEqual(b.decoyItems, []);
  assert.deepEqual(b.items.map((i) => i.item), Array.from({ length: 20 }, (_, i) => 'V' + (i + 1)));
});

test('buildItems with decoys: every batch within batchMax, decoys spread over different batches, items look alike', () => {
  const cs = many(20);
  const d = decoyList(3);
  const b = buildItems(cs, { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '02'.repeat(16) }), batchMax: 8, decoys: d });
  assert.equal(b.items.length, 23);
  assert.ok(b.batches.every((x) => x.items.length <= 8), JSON.stringify(b.batches));
  assert.equal(b.batches.length, 3);
  const decoyIds = new Set(b.decoyItems.map((x) => x.item));
  assert.equal(decoyIds.size, 3);
  // one decoy in each of the three batches: each verifier is tested
  for (const batch of b.batches) assert.equal(batch.items.filter((i) => decoyIds.has(i)).length, 1, JSON.stringify(batch));
  // same shape: the same fields, and the cluster of a decoy has the format of a cluster id
  const shapes = new Set(b.items.map((i) => Object.keys(i).sort().join(',')));
  assert.equal(shapes.size, 1);
  for (const x of b.decoyItems) assert.equal(b.hiddenMap['1:' + x.item], x.cluster);
  // every real cluster appears exactly once
  assert.deepEqual(b.items.map((i) => i.cluster).filter((c) => !c.startsWith('C-01-9')).sort(), cs.map((c) => c.id).sort());
});

test('buildItems with more decoys than batches puts several into a batch; with none to verify, no decoys are placed', () => {
  const b = buildItems(many(6), { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '03'.repeat(16) }), batchMax: 8, decoys: decoyList(3) });
  assert.equal(b.batches.length, 2);
  assert.equal(b.decoyItems.length, 3);
  const none = buildItems([], { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '03'.repeat(16) }), batchMax: 8, decoys: decoyList(3) });
  assert.deepEqual(none.items, []);
});

test('buildItems in a confirm round: the decoys are in both passes, in different batches and positions', () => {
  const cs = many(12);
  const b = buildItems(cs, { roundKind: 'confirm', versionHash: 'x', rng: makeRng({ seedHex: '04'.repeat(16) }), batchMax: 8, decoys: decoyList(2) });
  assert.equal(b.items.filter((i) => i.pass === 1).length, 14);
  assert.equal(b.items.filter((i) => i.pass === 2).length, 14);
  for (const p of [1, 2]) assert.equal(b.decoyItems.filter((x) => x.pass === p).length, 2);
});

test('buildItems for a later pass (second or fresh verifiers) numbers its own items and marks its own decoys', () => {
  const b = buildItems(many(5), { roundKind: 'working', versionHash: 'x', rng: makeRng({ seedHex: '05'.repeat(16) }), batchMax: 8, only: ['C-01-02', 'C-01-04'], pass: 3, decoys: decoyList(1) });
  assert.deepEqual(b.items.map((i) => i.pass), [3, 3, 3]);
  assert.equal(b.decoyItems[0].pass, 3);
});

test('settleUnverified: the clusters stay open as unverified at their claimed class, with the reason in the history', () => {
  const cs = [C({ id: 'C-01-01', claimedSeverity: 'blocker' }), C({ id: 'C-01-02' })];
  const out = settleUnverified(cs, ['C-01-01'], { round: 1, versionHash: 'v1', why: 'not trusted' });
  assert.equal(out[0].status, 'unverified');
  assert.equal(out[0].severity, 'blocker');
  assert.equal(out[0].history.at(-1).why, 'not trusted');
  assert.equal(out[1].status, 'pending');
});
