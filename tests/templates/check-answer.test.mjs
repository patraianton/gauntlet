// P5: templates/check-answer.mjs — standalone validator (SPEC 9.0 subset + 9.9 cross-field rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES, TEMPLATES, readJson, schemas, tryImport } from '../fixtures/templates/helpers.mjs';

const CHECKER = join(TEMPLATES, 'check-answer.mjs');
const { validate, checkAnswerBytes } = await import(pathToFileURL(CHECKER).href);

const ROLES = ['answer-reviewer', 'answer-verifier', 'answer-dispute', 'answer-matcher', 'answer-planter', 'answer-validator', 'answer-lens-writer'];
const valid = (role) => readJson(join(FIXTURES, 'answers', `${role}.valid.json`));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Runs check-answer.mjs the way an agent does: copied alone into a job folder with the schema. */
function runInJobDir(schema, answerBytes, { name = 'answer.json', copySchema = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-p5-job-'));
  try {
    copyFileSync(CHECKER, join(dir, 'check-answer.mjs'));
    if (copySchema) writeFileSync(join(dir, 'answer.schema.json'), JSON.stringify(schema, null, 2));
    if (answerBytes !== null) writeFileSync(join(dir, name), answerBytes);
    const r = spawnSync(process.execPath, [join(dir, 'check-answer.mjs'), join(dir, 'answer.json')], { encoding: 'utf8', windowsHide: true, shell: false });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Invalid variants per role: [description, mutate(answer), expected JSON path in the output]. */
const INVALID = {
  'answer-reviewer': [
    ['missing nonce', (a) => { delete a.nonce; }, '/nonce'],
    ['bad nonce pattern', (a) => { a.nonce = 'PL-abcd-1234'; }, '/nonce'],
    ['unknown severity', (a) => { a.findings[0].severity = 'critical'; }, '/findings/0/severity'],
    ['location without locator', (a) => { delete a.findings[0].location.locator; }, '/findings/0/location/locator'],
    ['how shorter than 10', (a) => { a.inspected[0].how = 'read it'; }, '/inspected/0/how'],
    ['receipt not an array', (a) => { a.receipt = 'Q1: x'; }, '/receipt'],
    ['schemaVersion 2', (a) => { a.schemaVersion = 2; }, '/schemaVersion'],
    ['requirement status unknown', (a) => { a.requirements[0].status = 'ok'; }, '/requirements/0/status'],
    ['n is a string', (a) => { a.findings[0].n = '1'; }, '/findings/0/n'],
    ['duplicate n (cross-field)', (a) => { a.findings[1].n = 1; }, '/findings/1/n'],
    ['omission without missingWhat (cross-field)', (a) => { delete a.findings[2].missingWhat; }, '/findings/2/missingWhat'],
    ['visual without seen (cross-field)', (a) => { delete a.findings[1].seen; }, '/findings/1/seen'],
    ['number finding without quote (cross-field)', (a) => { a.findings[0].quote = null; }, '/findings/0/quote'],
    ['source result too long', (a) => { a.sourceChecks[0].result = 'x'.repeat(2001); }, '/sourceChecks/0/result'],
  ],
  'answer-verifier': [
    ['unknown verdict', (a) => { a.items[0].verdict = 'probably'; }, '/items/0/verdict'],
    ['confirmed without severity (cross-field)', (a) => { a.items[0].severity = null; }, '/items/0/severity'],
    ['evidence too short', (a) => { a.items[1].evidence = 'no'; }, '/items/1/evidence'],
    ['empty items', (a) => { a.items = []; }, '/items'],
  ],
  'answer-dispute': [
    ['unknown outcome', (a) => { a.items[0].outcome = 'accepted'; }, '/items/0/outcome'],
    ['reclassified without severity (cross-field)', (a) => { a.items[1].severity = null; }, '/items/1/severity'],
  ],
  'answer-matcher': [
    ['score above 5', (a) => { a.pairs[0].score = 6; }, '/pairs/0/score'],
    ['score not integer', (a) => { a.pairs[0].score = 3.5; }, '/pairs/0/score'],
    ['alsoReal as string', (a) => { a.pairs[0].alsoReal = 'no'; }, '/pairs/0/alsoReal'],
  ],
  'answer-planter': [
    ['before shorter than 3', (a) => { a.candidates[0].before = 'ab'; }, '/candidates/0/before'],
    ['intendedSeverity cosmetic', (a) => { a.candidates[0].intendedSeverity = 'cosmetic'; }, '/candidates/0/intendedSeverity'],
    ['missing incidental', (a) => { delete a.incidental; }, '/incidental'],
  ],
  'answer-validator': [
    ['natural 0', (a) => { a.verdicts[0].natural = 0; }, '/verdicts/0/natural'],
    ['keep missing', (a) => { delete a.verdicts[0].keep; }, '/verdicts/0/keep'],
  ],
  'answer-lens-writer': [
    ['two lenses only', (a) => { a.lenses = a.lenses.slice(0, 2); }, '/lenses'],
    ['bad lens id', (a) => { a.lenses[0].id = 'Numbers'; }, '/lenses/0/id'],
    ['checklist with 4 items', (a) => { a.lenses[0].checklist = a.lenses[0].checklist.slice(0, 4); }, '/lenses/0/checklist'],
    ['procedure with 2 steps', (a) => { a.lenses[0].procedure = a.lenses[0].procedure.slice(0, 2); }, '/lenses/0/procedure'],
    ['ifMissing cosmetic', (a) => { a.requirements[0].ifMissing = 'cosmetic'; }, '/requirements/0/ifMissing'],
    ['minimum kind unknown', (a) => { a.lenses[0].minimum[0].kind = 'some-files'; }, '/lenses/0/minimum/0/kind'],
  ],
};

const NOT_PINNED_BY_SPEC = new Set(['empty items', 'schemaVersion 2', 'missing incidental', 'bad nonce pattern']);

for (const role of ROLES) {
  for (const { source, schema } of schemas(role)) {
    test(`${role} (${source}): valid fixture answer passes, exit 0`, () => {
      const r = runInJobDir(schema, JSON.stringify(valid(role), null, 2));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^OK/m);
    });
    for (const [what, mutate, path] of INVALID[role]) {
      // SPEC 9.9 does not pin these down exactly; only our SPEC-derived double is held to them.
      if (source !== 'fixture' && NOT_PINNED_BY_SPEC.has(what)) continue;
      test(`${role} (${source}): rejects ${what}`, () => {
        const a = clone(valid(role));
        mutate(a);
        const res = checkAnswerBytes(Buffer.from(JSON.stringify(a)), schema);
        assert.equal(res.ok, false, `expected invalid: ${what}`);
        if (source === 'fixture') {
          assert.ok(res.errors.some((e) => e.path === path), `expected an error at ${path}, got ${JSON.stringify(res.errors)}`);
        }
      });
    }
  }
}

test('CLI prints each error with its JSON path and exits 1', () => {
  const schema = readJson(join(FIXTURES, 'schemas', 'answer-verifier.schema.json'));
  const a = valid('answer-verifier');
  a.items[0].verdict = 'probably';
  delete a.nonce;
  const r = runInJobDir(schema, JSON.stringify(a));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^ERROR \/items\/0\/verdict: /m);
  assert.match(r.out, /^ERROR \/nonce: /m);
  assert.match(r.out, /^INVALID: 2 error/m);
});

test('accepts a UTF-8 BOM and CRLF line endings', () => {
  const schema = readJson(join(FIXTURES, 'schemas', 'answer-matcher.schema.json'));
  const text = JSON.stringify(valid('answer-matcher'), null, 2).replace(/\n/g, '\r\n');
  const r = runInJobDir(schema, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  assert.equal(r.code, 0, r.out);
});

test('rejects bytes that are not UTF-8', () => {
  const schema = readJson(join(FIXTURES, 'schemas', 'answer-matcher.schema.json'));
  const r = runInJobDir(schema, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
  assert.equal(r.code, 1);
  assert.match(r.out, /not valid UTF-8/);
});

test('rejects malformed JSON, an empty file and a missing file', () => {
  const schema = readJson(join(FIXTURES, 'schemas', 'answer-matcher.schema.json'));
  let r = runInJobDir(schema, '{"schemaVersion": 1,');
  assert.equal(r.code, 1);
  assert.match(r.out, /not valid JSON/);
  r = runInJobDir(schema, '   \n');
  assert.equal(r.code, 1);
  assert.match(r.out, /empty/);
  r = runInJobDir(schema, null);
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot read the answer file/);
});

test('fails closed when answer.schema.json is missing beside the script', () => {
  const r = runInJobDir(null, JSON.stringify(valid('answer-matcher')), { copySchema: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /answer\.schema\.json/);
});

test('score-like keys are reported as ignored, not as errors', () => {
  const schema = readJson(join(FIXTURES, 'schemas', 'answer-reviewer.schema.json'));
  const a = valid('answer-reviewer');
  a.score = 9.5;
  a.findings[0].rating = 'high';
  const r = runInJobDir(schema, JSON.stringify(a));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^WARNING \/score: /m);
  assert.match(r.out, /^WARNING \/findings\/0\/rating: /m);
});

test('the file has no import statements (it is copied alone into job folders)', () => {
  const src = readFileSync(CHECKER, 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

// ---- the SPEC 9.0 subset, keyword by keyword ----
const cases = [
  ['type string', { type: 'string' }, 'x', true],
  ['type string vs number', { type: 'string' }, 1, false],
  ['type array of types', { type: ['string', 'null'] }, null, true],
  ['integer accepts 3', { type: 'integer' }, 3, true],
  ['integer rejects 3.5', { type: 'integer' }, 3.5, false],
  ['number accepts 3.5', { type: 'number' }, 3.5, true],
  ['boolean', { type: 'boolean' }, false, true],
  ['null', { type: 'null' }, 0, false],
  ['object rejects array', { type: 'object' }, [], false],
  ['array rejects object', { type: 'array' }, {}, false],
  ['required', { type: 'object', required: ['a'] }, {}, false],
  ['properties nested', { type: 'object', properties: { a: { type: 'integer' } } }, { a: 'x' }, false],
  ['additionalProperties false', { type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 }, false],
  ['additionalProperties absent allows extra', { type: 'object', properties: { a: {} } }, { a: 1, b: 2 }, true],
  ['enum hit', { enum: ['a', 'b'] }, 'b', true],
  ['enum miss', { enum: ['a', 'b'] }, 'c', false],
  ['enum with null', { enum: ['a', null] }, null, true],
  ['const', { const: 1 }, 1, true],
  ['const miss', { const: 1 }, '1', false],
  ['items', { type: 'array', items: { type: 'string' } }, ['a', 2], false],
  ['minItems', { type: 'array', minItems: 2 }, [1], false],
  ['maxItems', { type: 'array', maxItems: 1 }, [1, 2], false],
  ['minLength', { type: 'string', minLength: 3 }, 'ab', false],
  ['maxLength', { type: 'string', maxLength: 3 }, 'abcd', false],
  ['minimum', { type: 'number', minimum: 1 }, 0, false],
  ['maximum', { type: 'number', maximum: 5 }, 5, true],
  ['pattern', { type: 'string', pattern: '^R[0-9]{2}$' }, 'R1', false],
  ['pattern unicode flag', { type: 'string', pattern: '^\\p{Lu}' }, 'Ā', true],
  ['unknown keywords are ignored', { type: 'string', format: 'email', $id: 'x', description: 'd', default: 'y' }, 'not-an-email', true],
];
for (const [name, schema, value, ok] of cases) {
  test(`validator subset: ${name}`, () => {
    assert.equal(validate(schema, value).ok, ok, JSON.stringify(validate(schema, value).errors));
  });
}

test('error paths are JSON pointers', () => {
  const r = validate({ type: 'object', properties: { 'a/b': { type: 'array', items: { type: 'object', properties: { 'c~d': { type: 'string' } } } } } },
    { 'a/b': [{ 'c~d': 1 }] });
  assert.deepEqual(r.errors.map((e) => e.path), ['/a~1b/0/c~0d']);
});

test('agrees with lib/core/schema.mjs (P1) on every case, when it exists', async (t) => {
  const core = await tryImport('lib/core/schema.mjs');
  if (!core || typeof core.validate !== 'function') { t.skip('lib/core/schema.mjs not present yet'); return; }
  for (const [name, schema, value] of cases) {
    assert.equal(core.validate(schema, value).ok, validate(schema, value).ok, `case ${name}`);
  }
  for (const role of ROLES) {
    const schema = readJson(join(FIXTURES, 'schemas', `${role}.schema.json`));
    for (const [what, mutate] of INVALID[role]) {
      if (what.includes('cross-field')) continue;
      const a = clone(valid(role));
      mutate(a);
      assert.equal(core.validate(schema, a).ok, validate(schema, a).ok, `${role}: ${what}`);
    }
  }
});
