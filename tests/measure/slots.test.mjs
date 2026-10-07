import test from 'node:test';
import assert from 'node:assert/strict';
import { planSlots, bandOf, slotsFile, BANDS } from '../../lib/measure/slots.mjs';
import { loadTaxonomy } from '../../lib/measure/taxonomy.mjs';
import { makeRng } from '../../lib/core/rand.mjs';
import { sha256Hex } from '../../lib/core/hash.mjs';

const tax = loadTaxonomy();
const LENSES = [
  { id: 'facts', canaryTypes: ['FACT-NUM', 'FACT-CLAIM', 'CONTRA'] },
  { id: 'language', canaryTypes: ['LANG'] },
  { id: 'conversion', canaryTypes: ['PATH', 'OMIT-REQ'] },
  { id: 'policy', canaryTypes: ['POLICY', 'OMIT-CAVEAT'] },
  { id: 'generalist', canaryTypes: ['BRIEF', 'CONTRA', 'FACT-NUM'] },
];
const RUN = { canaries: {} };
const rng = (s = '00112233445566778899aabbccddeeff') => makeRng({ seedHex: s });

test('one attention slot per lens; unguarded lens reported; measurement slots follow', () => {
  const p = planSlots({ lenses: LENSES, taxonomy: tax, ledgerCounts: null, run: RUN, roundKind: 'working', usedThisRun: [], rng: rng() });
  const att = p.slots.filter((s) => s.purpose === 'attention');
  assert.deepEqual(att.map((s) => s.targetLens), ['facts', 'language', 'conversion', 'generalist']);
  assert.deepEqual(p.unguarded, ['policy'], 'POLICY and OMIT-CAVEAT are not attention-eligible');
  for (const s of att) assert.ok(LENSES.find((l) => l.id === s.targetLens).canaryTypes.includes(s.type));
  assert.equal(p.slots.filter((s) => s.purpose === 'measurement').length, 1);
  assert.deepEqual(p.slots.map((s) => s.slot), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(p.seedCommitment, sha256Hex(p.seedHex));
  for (const s of p.slots) {
    assert.equal(s.severityFloor, tax.byId(s.type).defaultFloor);
    assert.deepEqual(s.range, BANDS[s.band]);
  }
  assert.deepEqual(Object.keys(slotsFile(p)), ['schemaVersion', 'seedCommitment', 'slots']);
});

test('confirm rounds get 2 measurement slots; every round has at least one omission slot', () => {
  for (const kind of ['working', 'confirm']) {
    for (const seed of ['aa'.repeat(16), 'bb'.repeat(16), 'cc'.repeat(16)]) {
      const p = planSlots({ lenses: LENSES, taxonomy: tax, ledgerCounts: { byType: {}, byBand: {}, omission: 50 }, run: RUN, roundKind: kind, usedThisRun: [], rng: rng(seed) });
      assert.equal(p.slots.filter((s) => s.purpose === 'measurement').length, kind === 'confirm' ? 2 : 1);
      assert.ok(p.slots.some((s) => tax.byId(s.type).omission), `omission slot present (${kind}, ${seed})`);
    }
  }
});

test('omission slot is added even when no measurement slot is configured', () => {
  const lenses = [{ id: 'a', canaryTypes: ['FACT-NUM'] }, { id: 'b', canaryTypes: ['LANG'] }, { id: 'c', canaryTypes: ['PATH'] }];
  const p = planSlots({ lenses, taxonomy: tax, run: { canaries: { measurementWorking: 0 } }, roundKind: 'working', usedThisRun: [], rng: rng() });
  assert.equal(p.slots.length, 4);
  assert.ok(tax.byId(p.slots[3].type).omission);
});

test('measurement slots prefer omission types until the ledger has 10 omission canaries', () => {
  const few = planSlots({ lenses: LENSES, taxonomy: tax, ledgerCounts: { byType: {}, byBand: {}, omission: 3 }, run: RUN, roundKind: 'confirm', usedThisRun: [], rng: rng() });
  for (const s of few.slots.filter((x) => x.purpose === 'measurement')) assert.ok(tax.byId(s.type).omission);
  const omitOwner = few.slots.find((s) => s.purpose === 'measurement' && s.type === 'OMIT-REQ');
  if (omitOwner) assert.equal(omitOwner.targetLens, 'conversion', 'targetLens = a lens owning the type');
});

test('type choice balances ledger counts (fewest first) and ties are broken by the seed', () => {
  const lenses = [{ id: 'facts', canaryTypes: ['FACT-NUM', 'FACT-CLAIM', 'CONTRA'] }, { id: 'b', canaryTypes: ['LANG'] }, { id: 'c', canaryTypes: ['PATH'] }];
  const p = planSlots({ lenses, taxonomy: tax, ledgerCounts: { byType: { 'FACT-NUM': 9, CONTRA: 4, 'FACT-CLAIM': 1 }, byBand: {}, omission: 0 }, run: RUN, roundKind: 'working', usedThisRun: [], rng: rng() });
  assert.equal(p.slots[0].type, 'FACT-CLAIM');
  // determinism: same seed -> same plan; replay from seedHex
  const again = planSlots({ lenses, taxonomy: tax, ledgerCounts: { byType: { 'FACT-NUM': 9, CONTRA: 4, 'FACT-CLAIM': 1 }, byBand: {}, omission: 0 }, run: RUN, roundKind: 'working', usedThisRun: [], seedHex: p.seedHex });
  assert.deepEqual(again.slots, p.slots);
});

test('bands: no two slots share a band with 3 or fewer slots; ledger band counts are balanced', () => {
  const lenses = [{ id: 'a', canaryTypes: ['FACT-NUM'] }, { id: 'b', canaryTypes: ['LANG'] }];
  const p = planSlots({ lenses, taxonomy: tax, ledgerCounts: { byType: {}, byBand: { start: 10, middle: 0, end: 5 }, omission: 20 }, run: RUN, roundKind: 'working', usedThisRun: [], rng: rng() });
  assert.equal(p.slots.length, 3);
  assert.deepEqual(new Set(p.slots.map((s) => s.band)).size, 3);
  assert.deepEqual(p.slots.map((s) => s.band), ['middle', 'end', 'start'], 'least-used band first');
  // more than 3 slots: spread evenly
  const q = planSlots({ lenses: LENSES, taxonomy: tax, run: RUN, roundKind: 'confirm', usedThisRun: [], rng: rng() });
  const counts = {};
  for (const s of q.slots) counts[s.band] = (counts[s.band] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1);
});

test('a confirm round avoids the candidate round types', () => {
  const lenses = [
    { id: 'facts', canaryTypes: ['FACT-NUM', 'FACT-CLAIM', 'CONTRA'] },
    { id: 'conv', canaryTypes: ['PATH', 'OMIT-REQ', 'BRIEF'] },
    { id: 'gen', canaryTypes: ['BRIEF', 'CONTRA', 'FACT-NUM'] },
  ];
  const cand = planSlots({ lenses, taxonomy: tax, run: RUN, roundKind: 'working', usedThisRun: [], rng: rng('01'.repeat(16)) });
  const used = cand.slots.map((s) => ({ ...s, round: 2 }));
  const conf = planSlots({ lenses, taxonomy: tax, run: RUN, roundKind: 'confirm', usedThisRun: used, candidateRound: 2, rng: rng('02'.repeat(16)) });
  const candAtt = new Map(cand.slots.filter((s) => s.purpose === 'attention').map((s) => [s.targetLens, s.type]));
  for (const s of conf.slots.filter((x) => x.purpose === 'attention')) {
    assert.notEqual(s.type, candAtt.get(s.targetLens), `lens ${s.targetLens} got a fresh type`);
  }
  const candTypes = new Set(cand.slots.map((s) => s.type));
  const fresh = conf.slots.filter((s) => !candTypes.has(s.type));
  assert.ok(fresh.length >= conf.slots.length - 1, 'types of the candidate round go last');
});

test('VISUAL only when visualAllowed and a rebuild exist; bandOf boundaries', () => {
  const lenses = [{ id: 'design', canaryTypes: ['VISUAL'] }, { id: 'b', canaryTypes: ['LANG'] }, { id: 'c', canaryTypes: ['PATH'] }];
  const off = planSlots({ lenses, taxonomy: tax, run: RUN, roundKind: 'working', usedThisRun: [], rng: rng() });
  assert.deepEqual(off.unguarded, ['design']);
  const on = planSlots({ lenses, taxonomy: tax, run: { canaries: { visualAllowed: true }, rebuild: { cmd: 'node' } }, roundKind: 'working', usedThisRun: [], rng: rng() });
  assert.equal(on.slots[0].type, 'VISUAL');
  assert.equal(bandOf(0), 'start');
  assert.equal(bandOf(0.34), 'middle');
  assert.equal(bandOf(0.9), 'end');
  assert.equal(bandOf(1), 'end');
  assert.throws(() => planSlots({ lenses: [], taxonomy: tax, run: RUN, rng: rng() }), /lenses/);
});
