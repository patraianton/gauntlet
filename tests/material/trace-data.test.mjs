// The trace scan on data files, and what the executor is told when it stops (SPEC 15.5).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPatterns, scanTrace, isDataFile, allowProblems, looksLikeProse } from '../../lib/material/lint.mjs';
import { traceAdvice, suggestAllowPhrase } from '../../lib/material/trace-advice.mjs';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
function copy(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pltd-'));
  made.push(d);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(d, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return d;
}
const PATS = loadPatterns('trace');

// product words and ratings of real data: every one of these is NOT a leftover of a review
const ORDINARY = [
  'shop,rating,category',
  'Solar BV,"9,5",zonnepanelen',
  'TV Shop,8.7/10,panel TV 55 inch',
  'Funding Inc,round 3 closed,reviewer account',
  'Birdy,canary yellow,deliberate choice',
  'Notes,FEEDBACK form,average score 4.2',
].join('\n');

test('isDataFile: csv tsv jsonl ndjson json, any case, any folder', () => {
  for (const f of ['a.csv', 'x/y.TSV', 'e/d.jsonl', 'z.ndjson', 'p/q.json']) assert.equal(isDataFile(f), true, f);
  for (const f of ['a.md', 'a.html', 'a.txt', 'csv', 'x.csv.md', '.json']) assert.equal(isDataFile(f), false, f);
});

const NL = String.fromCharCode(10);

/** Rows of ordinary short values (a shop's own rating, a product, a funding round): over the 2 000-row default. */
function bigCsv(n, tail = '') {
  const out = ['shop,rating,category,note'];
  for (let i = 1; i <= n; i++) out.push(`Shop ${i},"9,5",panel,round 3`);
  return out.join(NL) + NL + tail;
}
function bigJsonl(n, tail = '') {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(JSON.stringify({ shop: `Shop ${i}`, rating: '9,5', category: 'panel', note: 'round 3' }));
  return out.join(NL) + NL + tail;
}

test('LARGE data files: short ratings and product words are not traces; the same lines in prose still are', () => {
  const d = copy({ 'content/shops.csv': bigCsv(2100), 'content/shops.jsonl': bigJsonl(2100), 'content/shops.md': ORDINARY });
  const hits = scanTrace(d, PATS, []);
  assert.deepEqual(hits.filter((h) => /\.(csv|jsonl)$/.test(h.file)), [], JSON.stringify(hits.filter((h) => /\.(csv|jsonl)$/.test(h.file)).slice(0, 3)));
  const prose = new Set(hits.filter((h) => h.file === 'content/shops.md').map((h) => h.patternId));
  for (const id of ['T-9-5', 'T-OUT-OF-10', 'T-PANEL-EN', 'T-ROUND-EN', 'T-REVIEWER-EN', 'T-CANARY', 'T-DELIBERATE-EN', 'T-FEEDBACK', 'T-AVG-EN']) assert.ok(prose.has(id), `prose keeps ${id}`);
});

test('data files: unambiguous review traces are still found', () => {
  const d = copy({
    'content/a.csv': 'id,note\n1,оценки проверяющих по кругам\n2,verified by the panel\n',
    'content/b.jsonl': '{"x":"ran gauntlet on it"}\n{"y":"see ROUND3-FEEDBACK.md"}\n{"z":"the round 3 verdict was kind"}\n',
    'content/c.json': '{"note":"fine"}\n',
  });
  const hits = scanTrace(d, PATS, []);
  const got = new Set(hits.map((h) => h.patternId));
  for (const id of ['T-SCORE-RU', 'T-VERIFIED-PANEL', 'T-TOOL-NAME', 'T-FEEDBACK-FILE', 'T-ROUND-VERDICT-EN']) assert.ok(got.has(id), id);
  assert.ok(!hits.some((h) => h.file === 'content/c.json'));
});

test('a data file BELOW the sampling thresholds is scanned with every pattern, like prose', () => {
  const d = copy({ 'content/shops.csv': ORDINARY, 'content/shops.jsonl': ORDINARY.split('\n').map((l) => JSON.stringify({ l })).join('\n') });
  const stats = {};
  const hits = scanTrace(d, PATS, [], { stats });
  for (const f of ['content/shops.csv', 'content/shops.jsonl']) {
    const ids = new Set(hits.filter((h) => h.file === f).map((h) => h.patternId));
    for (const id of ['T-9-5', 'T-PANEL-EN', 'T-ROUND-EN', 'T-CANARY', 'T-DELIBERATE-EN', 'T-AVG-EN']) assert.ok(ids.has(id), `${f}: ${id}`);
  }
  assert.equal(stats.dataFiles, 2);
  assert.equal(stats.fullDataFiles, 2);
  assert.deepEqual(stats.reducedFiles, []);
});

const PRIMING = 'deliberate, do not flag this one';
const VERDICT = 'the reviewer said the canary was fixed in round 2';
const AVERAGE = 'average score 8.5 over all reviewers';

test('LARGE data files: priming prose inside a long JSON string, a JSON line or a CSV cell still blocks', () => {
  const d = copy({
    'content/cms.json': JSON.stringify([...Array.from({ length: 2100 }, (_, i) => ({ id: i, name: `Shop ${i}` })), { id: 'x', text: PRIMING }, { id: 'y', text: VERDICT }, { id: 'z', text: AVERAGE }]),
    'content/rows.jsonl': bigJsonl(2100, JSON.stringify({ text: PRIMING }) + NL + JSON.stringify({ text: VERDICT }) + NL),
    'content/rows.csv': bigCsv(2100, `Shop x,"1","a","${VERDICT}"` + NL + `Shop y,"1","a","${PRIMING}"` + NL),
  });
  const stats = {};
  const hits = scanTrace(d, PATS, [], { stats });
  for (const f of ['content/cms.json', 'content/rows.jsonl', 'content/rows.csv']) {
    const ids = new Set(hits.filter((h) => h.file === f).map((h) => h.patternId));
    assert.ok(ids.has('T-DELIBERATE-EN'), `${f}: deliberate ${[...ids]}`);
    assert.ok(ids.has('T-CANARY'), `${f}: canary ${[...ids]}`);
    assert.ok(ids.has('T-REVIEWER-EN'), `${f}: reviewer`);
  }
  assert.ok(hits.some((h) => h.file === 'content/cms.json' && h.patternId === 'T-AVG-EN' && /^json:\//.test(h.where)), 'a JSON hit names its pointer');
  assert.ok(hits.some((h) => h.file === 'content/rows.jsonl' && h.line === 2101 && h.patternId === 'T-DELIBERATE-EN'), 'a JSON-lines hit has its line');
  assert.ok(hits.some((h) => h.file === 'content/rows.csv' && h.line === 2102 && h.patternId === 'T-CANARY'), 'a CSV hit has its record line');
  assert.equal(stats.reducedFiles.length, 3);
});

test('a traceAllow phrase lets a prose-like value of a large data file through', () => {
  const d = copy({ 'content/rows.csv': bigCsv(2100, 'Shop x,"1","a","a deliberate choice of colour for the roof panel"' + NL) });
  assert.ok(scanTrace(d, PATS, []).some((h) => h.patternId === 'T-DELIBERATE-EN'));
  assert.deepEqual(scanTrace(d, PATS, [{ phrase: 'a deliberate choice', why: 'the shop sells it so' }]).filter((h) => h.patternId === 'T-DELIBERATE-EN'), []);
});

test('an unparsable large JSON file is scanned with every pattern (no value can be told from prose)', () => {
  const d = copy({ 'content/broken.json': '[' + Array.from({ length: 2100 }, (_, i) => `{"id":${i}}`).join(',') + ',{"x": "see round 3 notes",,]' });
  const hits = scanTrace(d, PATS, []);
  assert.ok(hits.some((h) => h.file === 'content/broken.json' && h.patternId === 'T-ROUND-EN'), JSON.stringify(hits.slice(0, 3)));
});

test('stats: which large data files got the reduced scan, with their counts', () => {
  const d = copy({ 'content/shops.csv': bigCsv(2100, `Shop x,"1","a","${VERDICT}"` + NL), 'content/small.csv': 'a,b' + NL + '1,2' + NL, 'content/page.md': 'text' });
  const stats = {};
  scanTrace(d, PATS, [], { stats });
  assert.equal(stats.dataFiles, 2);
  assert.equal(stats.fullDataFiles, 1);
  assert.equal(stats.reducedFiles.length, 1);
  const f = stats.reducedFiles[0];
  assert.equal(f.file, 'content/shops.csv');
  assert.equal(f.rows, 2101);
  assert.ok(f.patternsReduced > 10, String(f.patternsReduced));
  assert.equal(f.proseValues, 1);
  assert.ok(f.shortValues > 8000, String(f.shortValues));
});

test('looksLikeProse: 4 words or 30 characters; short numbers and names are not prose', () => {
  assert.equal(looksLikeProse('deliberate, do not flag'), true);
  assert.equal(looksLikeProse('x'.repeat(30)), true);
  for (const v of ['9,5', 'Solar BV', 'zonnepanelen panel', 'round 3', 'Shop 12 bv', '']) assert.equal(looksLikeProse(v), false, v);
});

test('every hit carries the line it stands in, for the message', () => {
  const d = copy({ 'content/page.md': 'Intro\nThe plan was agreed in round 3 of talks\n' });
  const hit = scanTrace(d, PATS, []).find((h) => h.patternId === 'T-ROUND-EN');
  assert.equal(hit.line, 2);
  assert.equal(hit.context, 'The plan was agreed in round 3 of talks');
});

test('a traceAllow phrase still lets a prose hit through; data patterns work with an allow too', () => {
  const d = copy({ 'content/a.csv': 'id,note\n1,the gauntlet module of the game\n' });
  const hits = scanTrace(d, PATS, [{ phrase: 'the gauntlet module', why: 'a product of the shop' }]);
  assert.deepEqual(hits, []);
});

test('suggestAllowPhrase gives the shortest valid literal phrase around the hit', () => {
  const p = suggestAllowPhrase('Solar panel kits for roofs', 'panel', PATS);
  assert.equal(p, 'panel kits');
  assert.deepEqual(allowProblems({ phrase: p, why: 'x' }, PATS), []);
  assert.equal(suggestAllowPhrase('panel', 'panel', PATS), null, 'a lone trace word has no valid phrase');
  assert.equal(suggestAllowPhrase('no such text', 'panel', PATS), null);
});

test('traceAdvice: never rewrite the material, the exact question for the owner, the amend command', () => {
  const d = copy({ 'content/page.md': 'Our solar panel kits for roofs\nPlan: round 3 notes\n' });
  const hits = scanTrace(d, PATS, []);
  const lines = traceAdvice(hits, { patterns: PATS });
  const text = lines.join('\n');
  assert.match(text, /NEVER change the material/);
  assert.match(text, /do not split a word/);
  assert.match(text, /only the owner can allow it/);
  assert.match(text, /Ask the owner exactly this/);
  assert.match(text, /content\/page\.md, line 1: "Our solar panel kits for roofs"/);
  assert.match(text, /content\/page\.md, line 2: "Plan: round 3 notes"/);
  assert.match(text, /May reviewers read them unchanged\?/);
  assert.match(text, /amend <run> --what strip --file <new strip\.json> --reason "<why>" --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>"/);
  assert.match(text, /"panel kits"/, 'a suggested phrase');
  assert.deepEqual(traceAdvice([]), []);
});

test('traceAdvice names a path-only hit and caps the list', () => {
  const hits = [{ file: null, line: null, patternId: 'P-PANEL', text: 'panel', where: 'path' }];
  for (let i = 0; i < 9; i++) hits.push({ file: `content/f${i}.md`, line: 1, patternId: 'T-ROUND-EN', text: `round ${i}`, context: `see round ${i} here`, where: 'line' });
  const text = traceAdvice(hits, { patterns: PATS }).join('\n');
  assert.match(text, /a folder or file name of the copy/);
  assert.match(text, /and 4 more place\(s\)/);
});
