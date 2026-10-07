import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy, attentionEligible, checkTaxonomy, V1_TYPE_IDS, isOmissionType } from '../../lib/measure/taxonomy.mjs';

test('taxonomy holds exactly the v1 types of SPEC 14.1', () => {
  const t = loadTaxonomy();
  assert.deepEqual(t.types.map((x) => x.id), [...V1_TYPE_IDS]);
  const flags = Object.fromEntries(t.types.map((x) => [x.id, [x.attentionEligible, x.omission, x.needsRebuild]]));
  assert.deepEqual(flags, {
    'FACT-NUM': [true, false, false],
    'FACT-CLAIM': [true, false, false],
    CONTRA: [true, false, false],
    LANG: [true, false, false],
    PATH: [true, false, false],
    BRIEF: [true, false, false],
    POLICY: [false, false, false],
    'OMIT-REQ': [true, true, false],
    'OMIT-CAVEAT': [false, true, false],
    VISUAL: [true, false, true],
  });
  for (const x of t.types) {
    assert.ok(['major', 'blocker'].includes(x.defaultFloor));
    assert.ok(x.title && x.definition && x.example);
  }
  assert.equal(t.byId('INJECT'), null, 'INJECT is v2');
  assert.equal(isOmissionType(t, 'OMIT-CAVEAT'), true);
});

test('attention eligibility: catalog flag, lens lists the type, VISUAL only when allowed', () => {
  const t = loadTaxonomy();
  const lens = { id: 'facts', canaryTypes: ['FACT-NUM', 'POLICY', 'OMIT-REQ', 'VISUAL'] };
  assert.equal(attentionEligible(t.byId('FACT-NUM'), lens), true);
  assert.equal(attentionEligible(t.byId('POLICY'), lens), false);
  assert.equal(attentionEligible(t.byId('OMIT-REQ'), lens), true);
  assert.equal(attentionEligible(t.byId('OMIT-REQ'), { id: 'x', canaryTypes: ['FACT-NUM'] }), false, 'only for a lens that lists it');
  assert.equal(attentionEligible(t.byId('VISUAL'), lens), false);
  assert.equal(attentionEligible(t.byId('VISUAL'), lens, { visualAllowed: true }), true);
  assert.equal(attentionEligible(t.byId('VISUAL'), lens, { visualAllowed: true, hasRebuild: false }), false);
});

test('checkTaxonomy reports structural problems', () => {
  assert.ok(checkTaxonomy({ schemaVersion: 1, types: [] }).length > 0);
  const errs = checkTaxonomy({ schemaVersion: 1, types: [{ id: 'X', title: 'a', definition: 'abc', example: 'abc', attentionEligible: 1, omission: false, needsRebuild: false, defaultFloor: 'minor' }] });
  assert.ok(errs.some((e) => /attentionEligible/.test(e)));
  assert.ok(errs.some((e) => /defaultFloor/.test(e)));
});
