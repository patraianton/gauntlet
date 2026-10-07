// P5: the lens library (lenses/examples/*.json) — SPEC 9.6 shape and the code checks of 9.6 that do not
// need a live run: schema, 3-7 lenses, generalist, unique ids, verbatim task quotes (against a fake task
// that contains them), coverage of a fake manifest, globs that match, known canary types, prompt lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIXTURES, LENS_EXAMPLES, REPO, TEMPLATES, readText, readJson, sha256, schemas, matchGlob, stringsOf,
  PROMPT_LINT_MIN, realPromptPatterns, V1_CANARY_TYPES,
} from '../fixtures/templates/helpers.mjs';

const { checkAnswerBytes } = await import(pathToFileURL(join(TEMPLATES, 'check-answer.mjs')).href);
const TYPES = ['marketing-plan', 'copy', 'slides', 'report', 'code', 'bakery-content-plan'];
const normWs = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

function knownTypes() {
  const p = join(REPO, 'taxonomy', 'canary-types.json');
  if (!existsSync(p)) return { ids: V1_CANARY_TYPES, source: 'SPEC 14.1 list' };
  return { ids: readJson(p).types.map((t) => t.id), source: 'taxonomy/canary-types.json' };
}

test('the library has exactly one example per artifact type of run.json, plus bakery-content-plan', () => {
  const files = readdirSync(LENS_EXAMPLES).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, TYPES.map((t) => `${t}.json`).sort());
});

for (const type of TYPES) {
  const lensesPath = join(LENS_EXAMPLES, `${type}.json`);
  const lenses = readJson(lensesPath);
  const task = readText(join(FIXTURES, 'tasks', `${type}.md`));
  const manifest = readJson(join(FIXTURES, 'manifests', `${type}.json`)).files;

  for (const { source, schema } of schemas('lenses')) {
    test(`${type}: valid against lenses.schema.json (${source})`, () => {
      const res = checkAnswerBytes(Buffer.from(JSON.stringify(lenses)), schema);
      assert.equal(res.ok, true, JSON.stringify(res.errors));
    });
  }

  test(`${type}: file is UTF-8 without BOM, LF, 2-space JSON with a trailing newline`, () => {
    const raw = readText(lensesPath);
    assert.notEqual(raw.charCodeAt(0), 0xfeff);
    assert.equal(raw, JSON.stringify(lenses, null, 2) + '\n');
  });

  test(`${type}: taskSha256 is the hash of the example task, and every taskQuote is in it`, () => {
    assert.equal(lenses.taskSha256, sha256(task));
    for (const r of lenses.requirements) assert.ok(normWs(task).includes(normWs(r.taskQuote)), `${r.id} quote not in task`);
  });

  test(`${type}: 3-7 lenses with generalist, unique ids, duties not personas`, () => {
    assert.ok(lenses.lenses.length >= 3 && lenses.lenses.length <= 7);
    const ids = lenses.lenses.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('generalist'));
    const reqIds = lenses.requirements.map((r) => r.id);
    assert.equal(new Set(reqIds).size, reqIds.length);
    for (const l of lenses.lenses) {
      assert.ok(l.procedure.length >= 3, `${l.id}: procedure`);
      assert.ok(l.checklist.length >= 5, `${l.id}: checklist`);
      assert.ok(l.minimum.length >= 1, `${l.id}: minimum`);
      assert.match(l.duty, /^(?:Find|Read|Check|Найти|Прочитать|Проверить)(?![\p{L}])/u,`${l.id}: the duty is a job to do`);
      assert.doesNotMatch(l.duty, /\b(years old|persona|you are a|as a customer)\b/i, `${l.id}: duty reads like a persona`);
      const mids = l.minimum.map((m) => m.id);
      assert.equal(new Set(mids).size, mids.length, `${l.id}: minimum ids unique`);
    }
  });

  test(`${type}: every minimum rule has the fields its kind needs and uses plain globs`, () => {
    for (const l of lenses.lenses) {
      for (const m of l.minimum) {
        const at = `${l.id}/${m.id}`;
        if (m.kind === 'all-files') assert.ok(m.glob, `${at}: glob`);
        if (m.kind === 'all-entries') { assert.ok(m.glob, `${at}: glob`); assert.match(m.pointer || '', /^\/./, `${at}: pointer`); }
        if (m.kind === 'source-check') { assert.match(m.sourceId || '', /^S[0-9]{1,2}$/, `${at}: sourceId`); assert.ok(m.count >= 1, `${at}: count`); }
        if (m.glob) assert.doesNotMatch(m.glob, /[{}[\]\\]/, `${at}: only *, ** and ? are supported`);
      }
    }
  });

  test(`${type}: all-files/all-entries rules cover every file of the fake manifest, every glob matches a file`, () => {
    const covering = lenses.lenses.flatMap((l) => l.minimum).filter((m) => m.kind === 'all-files' || m.kind === 'all-entries');
    for (const rel of manifest) assert.ok(covering.some((m) => matchGlob(rel, m.glob)), `uncovered: ${rel}`);
    for (const l of lenses.lenses) for (const m of l.minimum) {
      if (m.glob) assert.ok(manifest.some((rel) => matchGlob(rel, m.glob)), `${l.id}/${m.id}: ${m.glob} matches nothing`);
    }
  });

  test(`${type}: canary types exist (${knownTypes().source}) and every lens has an attention-eligible one`, () => {
    const { ids } = knownTypes();
    const notForAttention = new Set(['POLICY', 'OMIT-CAVEAT']);
    for (const l of lenses.lenses) {
      for (const t of l.canaryTypes) assert.ok(ids.includes(t), `${l.id}: unknown type ${t}`);
      assert.ok(l.canaryTypes.some((t) => !notForAttention.has(t) && t !== 'VISUAL'), `${l.id}: no type usable without rebuild`);
    }
  });

  test(`${type}: every string passes the prompt lint (SPEC 15.5 minimum list + real catalog when present)`, () => {
    const patterns = PROMPT_LINT_MIN.map((re) => ({ id: re.source, re }));
    const real = realPromptPatterns();
    if (real) patterns.push(...real);
    const strs = stringsOf(lenses);
    for (const { path, value } of strs) for (const { id, re } of patterns) assert.doesNotMatch(value, re, `${path} hits ${id}`);
  });

}

// ---- bakery-content-plan: the five bench lenses plus the generalist (SPEC 21.4, the missed-logo lesson) ----
const bakery = readJson(join(LENS_EXAMPLES, 'bakery-content-plan.json'));

test('bakery: the five duties plus generalist', () => {
  assert.deepEqual(bakery.lenses.map((l) => l.id).sort(), ['conversion', 'copy', 'design', 'generalist', 'growth', 'risk']);
});

test('bakery: design has an explicit cross-slide footer and logo comparison step (the planted missing logo)', () => {
  const design = bakery.lenses.find((l) => l.id === 'design');
  const step = design.procedure.find((s) => /side by side/i.test(s) && /footer/i.test(s) && /logo/i.test(s));
  assert.ok(step, 'no side-by-side footer/logo step in the procedure');
  assert.ok(design.checklist.some((c) => /footer/i.test(c) && /logo/i.test(c)), 'no footer/logo checklist item');
  assert.ok(design.minimum.some((m) => m.kind === 'all-files' && /footer/i.test(m.rule) && /logo/i.test(m.rule)));
  assert.ok(design.canaryTypes.includes('VISUAL'));
});

test('bakery: owner-task requirements quote the task verbatim', () => {
  const quotes = bakery.requirements.map((r) => r.taskQuote);
  for (const q of ['content plan of 30 posts', 'pre-orders of the weekly Loaf Box', 'Make good how-we-bake posts', 'send people to the pre-order page', 'a few slide designs to choose from']) {
    assert.ok(quotes.some((x) => x.includes(q)), `missing requirement for: ${q}`);
  }
});

const BLIND = process.env.GAUNTLET_BENCH_MATERIAL ?? join(REPO, 'bench', 'material', 'bakery'); // the shipped synthetic bench material

function listRels(root) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push('content/' + relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

test('bakery: covers every file of the bench material, pointers are arrays (read-only, when present)', (t) => {
  if (!existsSync(BLIND)) { t.skip('bench material not on this machine'); return; }
  const rels = listRels(BLIND);
  const minimums = bakery.lenses.flatMap((l) => l.minimum.map((m) => ({ ...m, lens: l.id })));
  const covering = minimums.filter((m) => m.kind === 'all-files' || m.kind === 'all-entries');
  for (const rel of rels) assert.ok(covering.some((m) => matchGlob(rel, m.glob)), `uncovered: ${rel}`);
  for (const m of minimums) {
    if (m.glob) assert.ok(rels.some((r) => matchGlob(r, m.glob)), `${m.lens}/${m.id}: ${m.glob} matches nothing`);
    if (m.kind === 'all-entries') {
      for (const rel of rels.filter((r) => matchGlob(r, m.glob))) {
        const json = readJson(join(BLIND, ...rel.split('/').slice(1)));
        const node = m.pointer.split('/').slice(1).reduce((v, k) => (v == null ? v : v[k.replace(/~1/g, '/').replace(/~0/g, '~')]), json);
        assert.ok(Array.isArray(node) && node.length > 0, `${m.lens}/${m.id}: ${rel}#${m.pointer} is not a non-empty array`);
      }
    }
  }
});
