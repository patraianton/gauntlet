import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate, loadSchema, listSchemas, assertValid, schemaPath } from '../../lib/core/schema.mjs';
import { UsageError } from '../../lib/core/errors.mjs';
import { applyDefaults } from '../../lib/core/config.mjs';
import { fixtureJson, REPO } from './_helpers.mjs';

const ok = (s, v) => assert.deepEqual(validate(s, v), { ok: true, errors: [] });
const bad = (s, v, pathExpected) => {
  const r = validate(s, v);
  assert.equal(r.ok, false, JSON.stringify(v));
  if (pathExpected !== undefined) assert.ok(r.errors.some((e) => e.path === pathExpected), JSON.stringify(r.errors));
  return r.errors;
};

test('type: single, array, integer vs number, null', () => {
  ok({ type: 'string' }, 'x');
  bad({ type: 'string' }, 1, '');
  ok({ type: 'integer' }, 3);
  bad({ type: 'integer' }, 3.5, '');
  ok({ type: 'number' }, 3);
  ok({ type: 'number' }, 3.5);
  bad({ type: 'number' }, '3');
  ok({ type: ['string', 'null'] }, null);
  bad({ type: ['string', 'null'] }, 0);
  ok({ type: 'object' }, {});
  bad({ type: 'object' }, []);
  bad({ type: 'array' }, {});
  ok({ type: 'boolean' }, false);
  bad({ type: 'null' }, undefined);
  assert.throws(() => validate({ type: 'thing' }, 1), UsageError);
});

test('required, properties, additionalProperties with JSON-pointer paths', () => {
  const s = {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: { type: 'array', items: { type: 'object', required: ['severity'], properties: { severity: { enum: ['blocker', 'major'] } } } },
      'a/b~c': { type: 'string' },
    },
    additionalProperties: false,
  };
  bad(s, {}, '/findings');
  const errs = bad(s, { findings: [{ severity: 'major' }, {}, {}, { severity: 'x' }] }, '/findings/3/severity');
  assert.ok(errs.some((e) => e.path === '/findings/1/severity' && e.message === 'is required'));
  bad(s, { findings: [], extra: 1 }, '/extra');
  bad(s, { findings: [], 'a/b~c': 1 }, '/a~1b~0c');
  ok({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', other: 2 });
});

test('enum and const use deep equality', () => {
  ok({ enum: [1, 'a', null, { x: [1] }] }, { x: [1] });
  bad({ enum: [1, 'a'] }, 'b', '');
  ok({ const: 1 }, 1);
  bad({ const: 1 }, 2, '');
  ok({ const: { a: 1, b: 2 } }, { b: 2, a: 1 });
});

test('items, minItems, maxItems', () => {
  const s = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 };
  ok(s, [1]);
  bad(s, [], '');
  bad(s, [1, 2, 3], '');
  bad(s, [1, 'x'], '/1');
});

test('minLength, maxLength count code points; pattern uses the unicode flag', () => {
  ok({ type: 'string', minLength: 2, maxLength: 2 }, '🙂ё');
  bad({ type: 'string', minLength: 3 }, '🙂ё');
  bad({ type: 'string', maxLength: 1 }, 'ab');
  ok({ type: 'string', pattern: '^\\p{L}+$' }, 'кириллица');
  bad({ type: 'string', pattern: '^[a-z]+$' }, 'abc1', '');
});

test('minimum and maximum', () => {
  ok({ type: 'integer', minimum: 1, maximum: 5 }, 5);
  bad({ type: 'integer', minimum: 1 }, 0);
  bad({ type: 'number', maximum: 1 }, 1.01);
});

test('unknown keywords are ignored; $id/description/default are documentation', () => {
  ok({ $id: 'x', description: 'y', default: 3, anyOf: [{ type: 'string' }], type: 'integer' }, 3);
});

test('every schema file loads, uses only the supported subset and parses', () => {
  const names = listSchemas();
  const expected = [
    'run', 'lenses', 'sources', 'strip', 'mechanical', 'frozen', 'state', 'manifest', 'jobs', 'clusters', 'gate', 'ledger-event',
    'answer-lens-writer', 'answer-planter', 'answer-validator', 'answer-reviewer', 'answer-matcher', 'answer-verifier', 'answer-dispute', 'answer-decoy',
    'canary-key', 'detections', 'm-run', 'm-canary', 'm-detection', 'm-verdict', 'm-decoy', 'm-control', 'm-escape',
  ];
  assert.deepEqual([...names].sort(), [...expected].sort());
  const allowed = new Set(['$id', 'description', 'default', 'type', 'required', 'properties', 'additionalProperties', 'enum', 'const', 'items',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern']);
  const walk = (s, at) => {
    if (typeof s !== 'object' || s === null) return;
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${at}: keyword ${k} is outside the SPEC 9.0 subset`);
    if (s.additionalProperties !== undefined) assert.equal(typeof s.additionalProperties, 'boolean', at);
    if (s.pattern) new RegExp(s.pattern, 'u');
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${at}/properties/${k}`);
    if (s.items) walk(s.items, `${at}/items`);
  };
  for (const n of names) {
    const raw = fs.readFileSync(schemaPath(n));
    assert.notEqual(raw[0], 0xef, `${n} has no BOM`);
    assert.ok(!raw.includes(Buffer.from('\r\n')), `${n} uses LF`);
    walk(loadSchema(n), n);
    assert.equal(loadSchema(`${n}.schema.json`), loadSchema(n));
  }
  assert.throws(() => loadSchema('nope'), UsageError);
  assert.throws(() => loadSchema('../package'), UsageError);
});

test('the reviewer fixture validates, including an ignored "score" key', () => {
  const a = fixtureJson('answer-reviewer.valid.json');
  ok(loadSchema('answer-reviewer'), a);
  const hollow = { ...a, findings: [{ n: 0, severity: 'huge' }] };
  const errs = bad(loadSchema('answer-reviewer'), hollow);
  assert.ok(errs.some((e) => e.path === '/findings/0/n'));
  assert.ok(errs.some((e) => e.path === '/findings/0/severity'));
  assert.ok(errs.some((e) => e.path === '/findings/0/location'));
  const noQuoteKey = structuredClone(a);
  delete noQuoteKey.findings[0].quote;
  bad(loadSchema('answer-reviewer'), noQuoteKey, '/findings/0/quote');
});

test('role answers: minimal valid and typical invalid', () => {
  const nonce = 'PL-AB2C-D3EF';
  ok(loadSchema('answer-verifier'), { schemaVersion: 1, nonce, items: [{ item: 'V1', verdict: 'confirmed', severity: 'major', evidence: 'page.md line 14: 120 €' }] });
  bad(loadSchema('answer-verifier'), { schemaVersion: 1, nonce, items: [{ item: 'V1', verdict: 'ok', severity: null, evidence: 'short' }] }, '/items/0/verdict');
  ok(loadSchema('answer-dispute'), { schemaVersion: 1, nonce, items: [{ item: 'D1', outcome: 'withdrawn', severity: null, why: 'the source shows 147' }] });
  ok(loadSchema('answer-matcher'), { schemaVersion: 1, nonce, pairs: [{ canary: 'C1', finding: 'abcdefgh#3', score: 4, alsoReal: false, why: 'same number' }, { canary: 'C2', finding: null, score: 1, alsoReal: false, why: '' }] });
  bad(loadSchema('answer-matcher'), { schemaVersion: 1, nonce, pairs: [{ canary: 'C1', finding: 'job#x', score: 6, alsoReal: false, why: '' }] }, '/pairs/0/score');
  ok(loadSchema('answer-planter'), { schemaVersion: 1, nonce, candidates: [{ slot: 'S1', alt: 1, file: 'content/page.md', locator: 'line 3', before: '147 €', after: '174 €', description: 'swapped digits', howProvable: '3 × 49 = 147', intendedSeverity: 'major' }], incidental: [] });
  bad(loadSchema('answer-planter'), { schemaVersion: 1, nonce, candidates: [{ slot: 'S1', alt: 3, file: 'x', locator: '', before: 'ab', after: '', description: 'd', howProvable: 'h', intendedSeverity: 'cosmetic' }], incidental: [] }, '/candidates/0/before');
  ok(loadSchema('answer-validator'), { schemaVersion: 1, nonce, verdicts: [{ slot: 'S1', alt: 1, originalCorrect: true, isDefect: true, provable: true, natural: 4, giveaway: false, severity: 'major', keep: true, why: 'w' }] });
  bad(loadSchema('answer-validator'), { schemaVersion: 1, nonce, verdicts: [{ slot: 'S1', alt: 1, originalCorrect: true, isDefect: true, provable: true, natural: 0, giveaway: false, severity: 'major', keep: true, why: 'w' }] }, '/verdicts/0/natural');
  bad(loadSchema('answer-verifier'), { schemaVersion: 2, nonce, items: [] }, '/schemaVersion');
});

test('run.json fixture validates once defaults are applied; closed objects catch typos', () => {
  const run = applyDefaults(fixtureJson('run.minimal.json'));
  ok(loadSchema('run'), run);
  const typo = structuredClone(run);
  typo.limits.maxRound = 20;
  bad(loadSchema('run'), typo, '/limits/maxRound');
  const badAs = structuredClone(run);
  badAs.material.roots[0].as = 'Content Root';
  bad(loadSchema('run'), badAs, '/material/roots/0/as');
  assert.throws(() => assertValid('run', badAs), UsageError);
});

test('schema files live in the repository schemas folder', () => {
  assert.equal(path.dirname(schemaPath('run')), path.join(REPO, 'schemas'));
});
