// Sampled review of large data files (SPEC 14.10, D40): scanning, drawing, the planter's guard,
// the files the reviewers get, read receipts over sampled rows, the rewritten mandatory minimum.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SAMPLE_DEFAULTS,
  samplingSettings,
  dataKindOf,
  scanRecords,
  scanFile,
  planSample,
  sampleHash,
  addCanaryRows,
  makeSampleGuard,
  assertStructure,
  renderSampleFile,
  sampleReceiptLines,
  sampleView,
  clearSampleCaches,
  annotateForReviewer,
  annotateForPlanter,
  annotateForLensWriter,
  largeDataFiles,
  unsampledDataFiles,
  unsampledOf,
  dataFilesOfRun,
  classifyEntries,
  largeDataFilesOfRun,
  coverageOf,
  jobFile,
} from '../../lib/material/sample.mjs';
import { makeChallenges, checkReceipts } from '../../lib/material/receipts.mjs';
import { validateCandidate } from '../../lib/measure/canary.mjs';
import { loadTaxonomy } from '../../lib/measure/taxonomy.mjs';
import { minimumValue, sampleSealProblem } from '../../lib/engine/round.mjs';
import { materialListValue } from '../../lib/engine/setup.mjs';
import { manifestOfDir } from '../../lib/material/manifest.mjs';
import { validateRun, looserLimits, DEFAULT_LIMITS, applyDefaults } from '../../lib/core/config.mjs';
import { sha256Hex, hashJson } from '../../lib/core/hash.mjs';
import { normalizeLine } from '../../lib/material/lint.mjs';
import { tmpDir, put, seededRng } from '../fixtures/material/helpers.mjs';

const TINY = { thresholdBytes: 1000000, thresholdRows: 40, rows: 10, maxBytes: 100000 };

function csvRows(n, { eol = '\n' } = {}) {
  const lines = ['id,shop,value,url'];
  for (let i = 1; i <= n; i++) lines.push(`r${String(i).padStart(3, '0')},Shop ${i},${i * 7},https://example.test/${i}`);
  return lines.join(eol) + eol;
}

function jsonl(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(JSON.stringify({ id: i, shop: `Shop ${i}`, value: i * 3 }));
  return out.join('\n') + '\n';
}

test('dataKindOf and settings: defaults, and the run overrides them', () => {
  assert.equal(dataKindOf('a/b.CSV'), 'csv');
  assert.equal(dataKindOf('a/b.ndjson'), 'jsonl');
  assert.equal(dataKindOf('a/b.md'), null);
  assert.deepEqual(samplingSettings({}), { ...SAMPLE_DEFAULTS, groupBytes: 4 * SAMPLE_DEFAULTS.thresholdBytes });
  assert.equal(samplingSettings({ limits: { sampleThresholdBytes: 5000 } }).groupBytes, 20000, 'the group threshold follows the file threshold');
  assert.equal(SAMPLE_DEFAULTS.thresholdBytes, 1048576);
  assert.equal(SAMPLE_DEFAULTS.thresholdRows, 2000);
  assert.equal(SAMPLE_DEFAULTS.rows, 200);
  const s = samplingSettings({ limits: { sampleRows: 7, sampleThresholdRows: 9 } });
  assert.equal(s.rows, 7);
  assert.equal(s.thresholdRows, 9);
  assert.equal(s.thresholdBytes, SAMPLE_DEFAULTS.thresholdBytes);
});

test('scanRecords: csv with quoted line breaks, a quote inside a field, CRLF and blank lines', () => {
  const text = 'id,note\r\n1,"two\r\nlines"\r\n\r\n2,5" screen\r\n3,"say ""hi"""\r\n';
  const s = scanRecords('csv', text);
  assert.equal(s.delimiter, ',');
  assert.equal(text.slice(s.header.start, s.header.end), 'id,note');
  assert.equal(s.header.line, 1);
  assert.deepEqual(s.rows.map((r) => text.slice(r.start, r.end)), ['1,"two\r\nlines"', '2,5" screen', '3,"say ""hi"""']);
  assert.deepEqual(s.rows.map((r) => r.line), [2, 5, 6]);
});

test('scanRecords: semicolon and tab delimited, json lines, a json array with nesting and brackets in strings', () => {
  assert.equal(scanRecords('csv', 'a;b;c\n1;2;3\n').delimiter, ';');
  assert.equal(scanRecords('tsv', 'a\tb\n1\t2\n').rows.length, 1);
  const jl = scanRecords('jsonl', '{"a":1}\n\n{"a":2}\r\n');
  assert.equal(jl.header, null);
  assert.equal(jl.rows.length, 2);
  const text = '[\n  {"a": "x]", "b": [1, 2, {"c": "}"}]},\n  {"a": 2},\n  "str, with comma",\n  3\n]\n';
  const a = scanRecords('json', text);
  assert.deepEqual(a.rows.map((r) => text.slice(r.start, r.end)), ['{"a": "x]", "b": [1, 2, {"c": "}"}]}', '{"a": 2}', '"str, with comma"', '3']);
  assert.equal(scanRecords('json', '{"not": "an array"}'), null);
  assert.equal(scanRecords('json', '[1, 2'), null);
  assert.deepEqual(scanRecords('json', '[]').rows, []);
});

test('planSample: a small file is not sampled and draws no randomness', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/small.csv', csvRows(30));
  put(dir, 'content/page.md', '# hello\n');
  let called = 0;
  const sel = planSample(dir, TINY, () => {
    called++;
    return seededRng();
  });
  assert.equal(sel, null);
  assert.equal(called, 0, 'no large file, no draw');
});

test('planSample: header + exactly `rows` distinct rows, sorted, uniform over the file, deterministic per seed', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  const a = planSample(dir, TINY, () => seededRng('00112233445566778899aabbccddeeff'));
  assert.equal(a.files.length, 1);
  const e = a.files[0];
  assert.equal(e.file, 'content/shops.csv');
  assert.equal(e.rows, 300);
  assert.equal(e.header, true);
  assert.equal(e.chosen.length, 10);
  assert.equal(new Set(e.chosen).size, 10);
  assert.deepEqual(e.chosen, [...e.chosen].sort((x, y) => x - y));
  assert.ok(e.chosen.every((n) => n >= 1 && n <= 300));
  assert.deepEqual(e.forCanary, []);
  const b = planSample(dir, TINY, () => seededRng('00112233445566778899aabbccddeeff'));
  assert.deepEqual(a, b, 'the same seed draws the same rows');
  const c = planSample(dir, TINY, () => seededRng('ffeeddccbbaa99887766554433221100'));
  assert.notDeepEqual(a.files[0].chosen, c.files[0].chosen, 'another seed draws other rows');
  assert.notEqual(sampleHash(a), sampleHash(c));
  // over many seeds every part of the file is reached (a draw is not stuck at the start)
  const seen = new Set();
  for (let k = 0; k < 40; k++) for (const n of planSample(dir, TINY, () => seededRng(String(k).padStart(2, '0').repeat(16))).files[0].chosen) seen.add(Math.floor((n - 1) / 100));
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test('planSample: the size cap stops the draw, but never below the minimum number of rows', (t) => {
  const dir = tmpDir(t);
  const wide = [];
  for (let i = 1; i <= 100; i++) wide.push(JSON.stringify({ id: i, text: 'x'.repeat(500) }));
  put(dir, 'content/wide.jsonl', wide.join('\n') + '\n');
  const sel = planSample(dir, { thresholdBytes: 1000, thresholdRows: 1000000, rows: 80, maxBytes: 5000 }, () => seededRng());
  const e = sel.files[0];
  assert.equal(e.capped, true);
  assert.ok(e.chosen.length >= 20 && e.chosen.length < 80, `got ${e.chosen.length}`);
  // when the sample would hold every row there is nothing to draw: the file is read whole
  const none = planSample(dir, { thresholdBytes: 1000, thresholdRows: 1000000, rows: 500, maxBytes: 100000000 }, () => seededRng());
  assert.equal(none, null);
});

test('planSample: a file over the byte threshold with few rows, and a json array, are sampled too', (t) => {
  const dir = tmpDir(t);
  put(dir, 'x/a.jsonl', jsonl(200));
  const arr = '[' + Array.from({ length: 120 }, (_, i) => JSON.stringify({ i })).join(',\n') + ']';
  put(dir, 'x/b.json', arr);
  put(dir, 'x/c.json', '{"posts": [1,2,3]}');
  const sel = planSample(dir, { ...TINY, thresholdRows: 50 }, () => seededRng());
  assert.deepEqual(sel.files.map((f) => f.file), ['x/a.jsonl', 'x/b.json']);
  assert.equal(sel.files[1].header, false);
  assert.deepEqual(largeDataFiles(dir, { ...TINY, thresholdRows: 50 }).map((f) => f.file), ['x/a.jsonl', 'x/b.json']);
});

test('addCanaryRows: the row of a planted error joins the sample once', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  const sel = planSample(dir, TINY, () => seededRng());
  const e = sel.files[0];
  let row = 1;
  while (e.chosen.includes(row)) row++;
  const canary = { file: 'content/shops.csv', before: `r${String(row).padStart(3, '0')},Shop ${row},${row * 7}` };
  const r = addCanaryRows(dir, sel, [canary], { use: 'before' });
  assert.deepEqual(r.added, [{ file: 'content/shops.csv', row }]);
  assert.ok(r.selection.files[0].chosen.includes(row));
  assert.deepEqual(r.selection.files[0].forCanary, [row]);
  assert.equal(r.selection.files[0].chosen.length, 11, 'a row beyond the draw is added, not swapped in');
  assert.equal(sel.files[0].chosen.length, 10, 'the input is not changed');
  const again = addCanaryRows(dir, r.selection, [canary]);
  assert.deepEqual(again.added, []);
  // a canary inside a row that is already drawn adds nothing; a file that is not sampled is ignored
  const inside = { file: 'content/shops.csv', before: `r${String(e.chosen[0]).padStart(3, '0')},Shop` };
  assert.deepEqual(addCanaryRows(dir, sel, [inside, { file: 'content/page.md', before: 'x' }]).added, []);
  // `after` (a bench key already planted)
  put(dir, 'content/shops.csv', csvRows(300).replace(`r${String(row).padStart(3, '0')},Shop ${row},${row * 7}`, `r${String(row).padStart(3, '0')},Shop ${row},${row * 7 + 1}`));
  clearSampleCaches();
  const planted = addCanaryRows(dir, sel, [{ file: 'content/shops.csv', after: `Shop ${row},${row * 7 + 1}` }], { use: 'after' });
  assert.deepEqual(planted.added, [{ file: 'content/shops.csv', row }]);
});

test('makeSampleGuard: an edit must sit inside one sampled row and keep the row\'s shape', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  put(dir, 'content/lines.jsonl', jsonl(300));
  const sel = planSample(dir, TINY, () => seededRng());
  const guard = makeSampleGuard(dir, sel);
  assert.equal(guard.has('content/shops.csv'), true);
  assert.equal(guard.has('content/other.md'), true === false);
  const f = scanFile(dir, 'content/shops.csv');
  const e = sel.files.find((x) => x.file === 'content/shops.csv');
  const inRow = e.chosen[3];
  const outRow = [...Array(300).keys()].map((i) => i + 1).find((n) => !e.chosen.includes(n));
  const at = (n) => f.scan.rows[n - 1];
  const idx = (n, token) => at(n).start + f.text.slice(at(n).start, at(n).end).indexOf(token);
  assert.deepEqual(guard.check('content/shops.csv', idx(inRow, `Shop ${inRow},`), 4, 'Shap'), { ok: true, row: inRow });
  const out = guard.check('content/shops.csv', idx(outRow, `Shop ${outRow},`), 4, 'Shap');
  assert.equal(out.ok, false);
  assert.match(out.error, /^outside-sample/);
  // across two rows
  const span = guard.check('content/shops.csv', at(inRow).start + 3, at(inRow + 1).start - at(inRow).start + 2, 'x');
  assert.match(span.error, /not inside one data row/);
  // a new comma adds a field; a new line break changes the rows
  assert.match(guard.check('content/shops.csv', idx(inRow, `Shop ${inRow},`), 4, 'Sh,op').error, /^row-shape/);
  assert.match(guard.check('content/shops.csv', idx(inRow, `Shop ${inRow},`), 4, 'Sh\nop').error, /^row-shape/);
  // an opening quote that never closes
  assert.match(guard.check('content/shops.csv', idx(inRow, `Shop ${inRow},`), 4, '"Sho').error, /^row-shape/);
  // json lines: still valid json
  const j = scanFile(dir, 'content/lines.jsonl');
  const ej = sel.files.find((x) => x.file === 'content/lines.jsonl');
  const rj = ej.chosen[0];
  const ji = j.scan.rows[rj - 1].start + j.text.slice(j.scan.rows[rj - 1].start).indexOf('"shop"');
  assert.deepEqual(guard.check('content/lines.jsonl', ji, 6, '"shap"'), { ok: true, row: rj });
  assert.match(guard.check('content/lines.jsonl', ji, 6, '"shap').error, /^row-shape/);
  assert.equal(guard.check('content/page.md', 0, 3, 'x').ok, true, 'a file outside the selection is not restricted');
});

test('assertStructure: planted edits that kept the rows pass, a lost row is an error', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  const sel = planSample(dir, TINY, () => seededRng());
  assertStructure(dir, sel);
  put(dir, 'content/shops.csv', csvRows(299));
  clearSampleCaches();
  assert.throws(() => assertStructure(dir, sel), /rows of content\/shops.csv changed/);
});

test('renderSampleFile: header, row and line numbers, rows exactly as stored (CRLF file)', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300, { eol: '\r\n' }));
  const sel = planSample(dir, TINY, () => seededRng());
  const e = sel.files[0];
  const md = renderSampleFile(dir, e, 'SAMPLE-1.md');
  assert.match(md, /^# Rows to read in content\/shops.csv$/m);
  assert.match(md, /300 data rows and a header/);
  assert.match(md, /drew 10 of them/);
  assert.match(md, /^## Header \(line 1\)$/m);
  assert.match(md, /^id,shop,value,url$/m);
  for (const n of e.chosen) {
    const id = `r${String(n).padStart(3, '0')}`;
    assert.match(md, new RegExp(`^## Row ${n} \\(line ${n + 1}\\)\\n\\n${id},Shop ${n},${n * 7},https://example.test/${n}\\n`, 'm'));
  }
  assert.ok(!/\r/.test(md.replace(/\r\n/g, '')), 'no stray carriage returns');
  assert.equal((md.match(/^## Row /gm) || []).length, 10);
  assert.ok(!md.includes('Shop 1,7') || e.chosen.includes(1));
});

test('read receipts over a sampled file: lines come only from the sampled rows and no entry count is asked', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  put(dir, 'content/page.md', ['# Offer', 'Price: 49 EUR per month', 'Rules apply to every order.'].join('\n') + '\n');
  const sel = planSample(dir, TINY, () => seededRng());
  const view = sampleView(dir, sel);
  const allowed = new Set(view.receiptLines.get('content/shops.csv').map((l) => l.line));
  assert.ok(allowed.size >= 10, 'header and sampled rows');
  const lens = {
    id: 'facts',
    minimum: [
      { id: 'M1', rule: 'read every row', kind: 'all-files', glob: 'content/*.csv' },
      { id: 'M2', rule: 'read the page', kind: 'all-files', glob: 'content/*.md' },
    ],
  };
  let lineOnCsv = 0;
  for (let k = 0; k < 40; k++) {
    const ch = makeChallenges({ copyDir: dir, lens, rng: seededRng(String(k).padStart(2, '0').repeat(16)), n: 3, sample: view.receiptLines });
    for (const c of ch.filter((x) => x.kind === 'line' && x.file === 'content/shops.csv')) {
      lineOnCsv++;
      assert.ok(allowed.has(c.line), `line ${c.line} of a sampled file must be a sampled row`);
    }
  }
  assert.ok(lineOnCsv > 0, 'the sampled file is asked about too');
  // an honest reader of the sample answers the question correctly
  const ch = makeChallenges({ copyDir: dir, lens, rng: seededRng(), n: 3, sample: view.receiptLines });
  const text = fs.readFileSync(path.join(dir, 'content', 'shops.csv'), 'utf8').split('\n');
  const answers = ch.map((c) => ({ id: c.id, answer: c.kind === 'line' ? (c.file === 'content/shops.csv' ? text[c.line - 1] : fs.readFileSync(path.join(dir, c.file), 'utf8').split('\n')[c.line - 1]) : String(c.expected) }));
  assert.equal(checkReceipts(ch, answers).correct, ch.length);
  // no pointer count over a sampled json array
  put(dir, 'content/big.json', '[' + Array.from({ length: 120 }, (_, i) => JSON.stringify({ i, name: `entry number ${i}` })).join(',\n') + ']');
  const sel2 = planSample(dir, { ...TINY, thresholdRows: 50 }, () => seededRng());
  const v2 = sampleView(dir, sel2);
  const ch2 = makeChallenges({ copyDir: dir, lens: { id: 'x', minimum: [{ id: 'M1', rule: 'r', kind: 'all-entries', glob: 'content/big.json', pointer: '/' }, { id: 'M2', rule: 'r', kind: 'all-files', glob: 'content/*.md' }] }, rng: seededRng(), n: 3, sample: v2.receiptLines });
  assert.ok(!ch2.some((c) => c.pointer), 'no entry count over a sampled array');
  assert.ok(ch2.every((c) => c.kind === 'count' || c.file !== 'content/big.json' || v2.receiptLines.get('content/big.json').some((l) => l.line === c.line)));
});

test('sampleView: files named SAMPLE-<k>.md in file order, cached, with the receipt lines', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/a.csv', csvRows(100));
  put(dir, 'content/b.jsonl', jsonl(100));
  const sel = planSample(dir, TINY, () => seededRng());
  const v = sampleView(dir, sel);
  assert.deepEqual(v.entries.map((e) => [e.file, e.name, e.rows, e.sampled]), [
    ['content/a.csv', 'SAMPLE-1.md', 100, 10],
    ['content/b.jsonl', 'SAMPLE-2.md', 100, 10],
  ]);
  assert.deepEqual(v.files.map((f) => f.name), ['SAMPLE-1.md', 'SAMPLE-2.md']);
  assert.equal(sampleView(dir, sel), v, 'cached');
  assert.equal(sampleView(dir, null), null);
  assert.deepEqual(coverageOf(sel), [{ file: 'content/a.csv', rows: 100, sampled: 10 }, { file: 'content/b.jsonl', rows: 100, sampled: 10 }]);
  const note = annotateForReviewer(v)('content/a.csv');
  assert.ok(note.includes(jobFile('SAMPLE-1.md')) && /LARGE DATA FILE/.test(note) && /100 rows/.test(note));
  assert.equal(annotateForReviewer(v)('content/page.md'), '');
  assert.match(annotateForPlanter(v)('content/b.jsonl'), /only inside a row listed in <<JOB_FILE:SAMPLE-2\.md>>/);
  assert.match(annotateForLensWriter([{ file: 'content/a.csv', bytes: 5000000, rows: 100 }], { rows: 200 })('content/a.csv'), /random sample of at most 200 rows/);
});

test('the planter\'s candidate: accepted inside a sampled row, refused outside it', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  const sel = planSample(dir, TINY, () => seededRng());
  const guard = makeSampleGuard(dir, sel);
  const e = sel.files[0];
  const inRow = e.chosen[4];
  const outRow = [...Array(300).keys()].map((i) => i + 1).find((n) => !e.chosen.includes(n));
  const cand = (n) => ({ slot: 'S1', alt: 1, file: 'content/shops.csv', locator: `row ${n}`, before: `r${String(n).padStart(3, '0')},Shop ${n},${n * 7}`, after: `r${String(n).padStart(3, '0')},Shop ${n},${n * 7 + 1}` });
  const run = { canaries: { maxEditChars: 240, minDistanceChars: 400 } };
  const tax = loadTaxonomy();
  const ok = validateCandidate(cand(inRow), { copyDir: dir, slot: null, run, taxonomy: tax, sample: guard });
  assert.deepEqual(ok.errors, []);
  const bad = validateCandidate(cand(outRow), { copyDir: dir, slot: null, run, taxonomy: tax, sample: guard });
  assert.ok(bad.errors.some((x) => x.startsWith('outside-sample')), bad.errors.join(' | '));
  // without a guard (a run without large files) nothing changes
  assert.deepEqual(validateCandidate(cand(outRow), { copyDir: dir, slot: null, run, taxonomy: tax }).errors, []);
  // an edit that adds a field to a sampled row is refused
  const broken = { ...cand(inRow), after: `r${String(inRow).padStart(3, '0')},Shop ${inRow},${inRow * 7},extra` };
  assert.ok(validateCandidate(broken, { copyDir: dir, slot: null, run, taxonomy: tax, sample: guard }).errors.some((x) => x.startsWith('row-shape')));
});

test('minimumValue: "every row" over a sampled file becomes every sampled row + every summary number; other rules are unchanged', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  put(dir, 'content/README.md', 'There are 300 shops.\n');
  put(dir, 'content/plan.json', JSON.stringify({ posts: [{ id: 1 }, { id: 2 }] }));
  const sel = planSample(dir, TINY, () => seededRng());
  const view = sampleView(dir, sel);
  const manifest = manifestOfDir(dir);
  const lens = {
    id: 'consistency',
    minimum: [
      { id: 'M1', rule: 'Read every row of shops.csv: key, empty cells.', kind: 'all-files', glob: 'content/*.csv' },
      { id: 'M2', rule: 'Every stated number in the markdown.', kind: 'all-files', glob: 'content/*.md' },
      { id: 'M3', rule: 'Everything once.', kind: 'all-files', glob: 'content/**/*' },
      { id: 'M4', rule: 'Recount rows.', kind: 'action', glob: 'content/*.csv' },
      { id: 'M5', rule: 'Every post.', kind: 'all-entries', glob: 'content/plan.json', pointer: '/posts' },
    ],
  };
  const text = minimumValue(lens, dir, manifest, view);
  assert.match(text, /^- M1 \(all-files\): every sampled row of the large data files listed below, and every summary number that the other files of the work state about them\. What to look at in each row: Read every row of shops\.csv: key, empty cells\./m);
  assert.match(text, /- content\/shops\.csv: 10 of 300 rows, in <<JOB_FILE:SAMPLE-1\.md>>/);
  assert.match(text, /means every sampled row/);
  assert.match(text, /^- M2 \(all-files\): Every stated number in the markdown\.\n  Files matching content\/\*\.md \(1\): content\/README\.md$/m);
  assert.match(text, /^- M3 \(all-files\): every sampled row/m, 'a catch-all rule is rewritten too');
  assert.match(text, /Files matching content\/\*\*\/\* that are read whole \(2\): content\/README\.md, content\/plan\.json/);
  assert.match(text, /^- M4 \(action\): Recount rows\.\n  Applies to 1 file\(s\) matching content\/\*\.csv\. For the large data files among them \(content\/shops\.csv\) it applies to the rows of their sample files/m);
  assert.match(text, /^- M5 \(all-entries\): Every post\.\n  Every entry at \/posts in content\/plan\.json: 2 entries in total\.$/m);
  // without a sample the old text is produced
  const plain = minimumValue(lens, dir, manifest, null);
  assert.match(plain, /^- M1 \(all-files\): Read every row of shops\.csv: key, empty cells\.\n  Files matching content\/\*\.csv \(1\): content\/shops\.csv$/m);
  assert.ok(!/sample/i.test(plain));
  // the material list names the sample
  const list = materialListValue(dir, manifest, { annotate: annotateForReviewer(view) });
  assert.match(list, /- content\/shops\.csv \(text, \d+ bytes\) — LARGE DATA FILE/);
  assert.match(list, /- content\/README\.md \(text, \d+ bytes\)\n/);
});

test('largeDataFilesOfRun: reads the live roots, by manifest path', (t) => {
  const root = tmpDir(t);
  put(root, 'shops.csv', csvRows(300));
  put(root, 'notes.md', 'x\n');
  const run = { material: { roots: [{ path: root, as: 'dataset', include: ['**/*'] }] } };
  const manifest = { files: [{ rel: 'dataset/shops.csv', kind: 'text' }, { rel: 'dataset/notes.md', kind: 'text' }] };
  assert.deepEqual(largeDataFilesOfRun(run, manifest, TINY).map((x) => [x.file, x.rows]), [['dataset/shops.csv', 300]]);
  assert.deepEqual(largeDataFilesOfRun(run, manifest, SAMPLE_DEFAULTS), []);
});

test('sample settings in run.json: stricter or equal values are free, looser ones need the owner\'s words', () => {
  const base = applyDefaults({ schemaVersion: 1, runId: '20260115-0930-a1b2c3', project: 'p', artifactType: 'other', material: { roots: [{ path: 'C:\\x', as: 'content', include: ['**/*'] }] } });
  assert.equal(base.limits.sampleThresholdBytes, DEFAULT_LIMITS.sampleThresholdBytes);
  assert.deepEqual(looserLimits(base), []);
  const stricter = { ...base, limits: { ...base.limits, sampleRows: 400, sampleTotalBytes: 500000 } };
  assert.deepEqual(looserLimits(stricter), []);
  const loose = { ...base, limits: { ...base.limits, sampleRows: 20, sampleThresholdRows: 100 } };
  assert.deepEqual(looserLimits(loose).map((x) => x.key).sort(), ['sampleRows', 'sampleThresholdRows']);
  assert.ok(validateRun(loose).some((e) => e.path === '/limits' && /sampleRows=20/.test(e.message)));
  const withWords = { ...loose, limitsOptIn: { approvedBy: 'owner', quote: 'для теста возьми выборку поменьше', question: 'Что именно вы разрешаете?', date: '2026-10-07' } };
  assert.deepEqual(validateRun(withWords).filter((e) => e.path.startsWith('/limits')), []);
  assert.ok(validateRun({ ...base, limits: { ...base.limits, sampleRows: 0 } }).length > 0, 'a zero sample is not allowed');
});

test('receipt line rule is the same one (8..300 characters) for sampled rows', (t) => {
  const dir = tmpDir(t);
  const rows = ['id,v'];
  for (let i = 1; i <= 100; i++) rows.push(i % 2 ? `${i},${'z'.repeat(400)}` : `${i},okokokokok`);
  put(dir, 'content/t.csv', rows.join('\n') + '\n');
  const sel = planSample(dir, TINY, () => seededRng());
  const lines = sampleReceiptLines(dir, sel.files[0]);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(l.text.length <= 300 && normalizeLine(l.text).length >= 8, l.text.slice(0, 40));
  assert.equal(sha256Hex(normalizeLine(lines[0].text)).length, 64);
});

test('planSample: a total budget over all large files; every file keeps its minimum rows', (t) => {
  const dir = tmpDir(t);
  const FILES = 12;
  for (let k = 1; k <= FILES; k++) put(dir, `data/f${String(k).padStart(2, '0')}.csv`, csvRows(400));
  const settings = { thresholdBytes: 1000000, thresholdRows: 40, rows: 200, maxBytes: 100000, totalBytes: 18000 };
  const sel = planSample(dir, settings, () => seededRng());
  assert.equal(sel.files.length, FILES);
  const spent = (e) => {
    const f = scanFile(dir, e.file);
    return e.chosen.reduce((sum, n) => sum + (f.scan.rows[n - 1].end - f.scan.rows[n - 1].start), 0);
  };
  const total = sel.files.reduce((sum, e) => sum + spent(e), 0);
  const free = planSample(dir, { ...settings, totalBytes: 100000000 }, () => seededRng());
  assert.ok(free.files.every((e) => e.chosen.length === 200), 'without the budget each file gets its full 200 rows');
  assert.ok(sel.files.every((e) => e.chosen.length >= 20 && e.chosen.length < 200 && e.capped), 'each file is cut by its share of the budget');
  assert.ok(sel.files.every((e) => e.capBytes === 1500));
  // the share is 1500 characters per file; the draw stops at the first row that would pass it (one row of slack at most)
  assert.ok(total <= FILES * (1500 + 60), `the files together hold ${total} characters`);
  assert.ok(total < 0.2 * free.files.reduce((sum, e) => sum + spent(e), 0), 'far less than without the budget');
  // a budget too small for the minimum still gives every file its 20 rows
  const tight = planSample(dir, { ...settings, totalBytes: 100 }, () => seededRng());
  assert.ok(tight.files.every((e) => e.chosen.length === 20));
  // the numbers shown to the reviewer follow the real sample
  assert.deepEqual(coverageOf(sel).map((c) => c.sampled), sel.files.map((e) => e.chosen.length));
});

test('samplingSettings: the total budget has a default and the run can change it', () => {
  assert.equal(SAMPLE_DEFAULTS.totalBytes, 250000);
  assert.equal(samplingSettings({}).totalBytes, 250000);
  assert.equal(samplingSettings({ limits: { sampleTotalBytes: 90000 } }).totalBytes, 90000);
});

test('a sampling threshold above the free ceiling needs the owner\'s words (it would hand reviewers a huge file whole)', () => {
  const base = applyDefaults({ schemaVersion: 1, runId: '20260115-0930-a1b2c3', project: 'p', artifactType: 'other', material: { roots: [{ path: 'C:\\x', as: 'content', include: ['**/*'] }] } });
  assert.equal(base.limits.sampleTotalBytes, DEFAULT_LIMITS.sampleTotalBytes);
  const huge = { ...base, limits: { ...base.limits, sampleThresholdBytes: 500 * 1048576 } };
  assert.deepEqual(looserLimits(huge).map((x) => x.key), ['sampleThresholdBytes']);
  assert.ok(validateRun(huge).some((e) => e.path === '/limits' && /sampleThresholdBytes=/.test(e.message)));
  const rows = { ...base, limits: { ...base.limits, sampleThresholdRows: 5000000 } };
  assert.deepEqual(looserLimits(rows).map((x) => x.key), ['sampleThresholdRows']);
  // the ceiling is the default: even the old free values (20 MiB / 100 000 rows) are flagged now, and a file of 99 000 rows cannot be unsampled silently
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleThresholdBytes: 20 * 1048576, sampleThresholdRows: 100000 } }).map((x) => x.key).sort(), ['sampleThresholdBytes', 'sampleThresholdRows']);
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleThresholdBytes: 10 * 1048576, sampleThresholdRows: 50000 } }).map((x) => x.key).sort(), ['sampleThresholdBytes', 'sampleThresholdRows']);
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleThresholdBytes: 1048577, sampleThresholdRows: 2001 } }).map((x) => x.key).sort(), ['sampleThresholdBytes', 'sampleThresholdRows']);
  assert.ok(validateRun({ ...base, limits: { ...base.limits, sampleThresholdRows: 99000 } }).some((e) => e.path === '/limits' && /sampleThresholdRows=99000/.test(e.message)));
  // the defaults themselves are free; a smaller total budget is looser
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleThresholdBytes: 1048576, sampleThresholdRows: 2000 } }), []);
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleTotalBytes: 50000 } }).map((x) => x.key), ['sampleTotalBytes']);
  assert.deepEqual(looserLimits({ ...base, limits: { ...base.limits, sampleTotalBytes: 400000 } }), []);
  const withWords = { ...huge, limitsOptIn: { approvedBy: 'owner', quote: 'этот файл целиком читать можно, он нужен целиком', question: 'Что именно вы разрешаете?', date: '2026-10-07' } };
  assert.deepEqual(validateRun(withWords).filter((e) => e.path.startsWith('/limits')), []);
});

test('scanFile: the text is read on first use and refreshed after clearSampleCaches', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(60));
  const f = scanFile(dir, 'content/shops.csv');
  assert.equal(f.scan.rows.length, 60);
  assert.ok(f.text.startsWith('id,shop,value,url'));
  // a second look gives the same scan, and the text of another large file does not break the first one
  put(dir, 'content/other.csv', csvRows(70));
  const g = scanFile(dir, 'content/other.csv');
  assert.equal(g.scan.rows.length, 70);
  assert.equal(f.text.slice(f.scan.rows[0].start, f.scan.rows[0].end), 'r001,Shop 1,7,https://example.test/1');
  put(dir, 'content/shops.csv', csvRows(60).replace('r001,Shop 1,', 'r001,Shop X,'));
  clearSampleCaches();
  const h = scanFile(dir, 'content/shops.csv');
  assert.equal(h.text.slice(h.scan.rows[0].start, h.scan.rows[0].end), 'r001,Shop X,7,https://example.test/1');
});

test('sampleSealProblem: the sample must hash to the commitment in the round\'s canary-commit event', (t) => {
  const root = tmpDir(t);
  const dir = path.join(root, 'rounds', '01');
  const sealed = path.join(root, 'sealed');
  fs.mkdirSync(dir, { recursive: true });
  const rc = { runId: 'r1', dataPaths: { sealedDir: () => sealed }, paths: { roundDir: () => ({ dir, roundJson: path.join(dir, 'round.json') }) } };
  const sel = { schemaVersion: 1, settings: {}, files: [{ file: 'a.csv', kind: 'csv', bytes: 9, rows: 50, header: true, chosen: [1, 5, 9], capped: false, forCanary: [] }] };
  const commit = (data) => [{ type: 'canary-commit', round: 1, data }, { type: 'canary-commit', round: 2, data: { sampleCommitment: 'f'.repeat(64) } }];
  // no commit event, or a round without a sample: nothing to check
  assert.equal(sampleSealProblem(rc, 1, []), null);
  assert.equal(sampleSealProblem(rc, 1, commit({ commitment: null })), null);
  // staged (not yet revealed)
  const staged = path.join(sealed, '01-stage', 'sample.json');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, JSON.stringify(sel));
  assert.equal(sampleSealProblem(rc, 1, commit({ sampleCommitment: hashJson(sel) })), null);
  fs.writeFileSync(staged, JSON.stringify({ ...sel, files: [{ ...sel.files[0], chosen: [1, 5] }] }));
  assert.match(sampleSealProblem(rc, 1, commit({ sampleCommitment: hashJson(sel) })), /does not match the sample committed in the ledger/);
  // a sample that exists although none was committed, and a committed one that is missing
  assert.match(sampleSealProblem(rc, 1, commit({ commitment: null })), /committed to no sample/);
  fs.rmSync(staged);
  assert.match(sampleSealProblem(rc, 1, commit({ sampleCommitment: hashJson(sel) })), /sample\.json is missing/);
  // revealed: the file lives in the round folder
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify(sel));
  assert.equal(sampleSealProblem(rc, 1, commit({ sampleCommitment: hashJson(sel) })), null);
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ ...sel, files: [] }));
  assert.match(sampleSealProblem(rc, 1, commit({ sampleCommitment: hashJson(sel) })), /does not match/);
});

// ------------------------------------------------------------------ files that cannot be sampled, and groups

const BIG = { thresholdBytes: 2000, thresholdRows: 100000, rows: 10, maxBytes: 100000, totalBytes: 250000, groupBytes: 8000 };

function jsonObject(bytes) {
  return JSON.stringify({ meta: { n: 1 }, items: { blob: 'x'.repeat(bytes) } });
}

test('unsampled files: a big json object, xml, sql, txt and log are listed; prose, code and small ones are not', (t) => {
  const dir = tmpDir(t);
  put(dir, 'data/object.json', jsonObject(3000));
  put(dir, 'data/feed.xml', '<a>' + 'x'.repeat(3000) + '</a>');
  put(dir, 'data/dump.sql', 'INSERT INTO t VALUES (1);\n'.repeat(200));
  put(dir, 'data/notes.TXT', 'line\n'.repeat(600));
  put(dir, 'data/run.log', 'ok\n'.repeat(1200));
  put(dir, 'data/small.json', jsonObject(100));
  put(dir, 'data/small.sql', 'SELECT 1;\n');
  put(dir, 'docs/readme.md', 'x'.repeat(5000));
  put(dir, 'docs/page.html', '<p>' + 'x'.repeat(5000) + '</p>');
  put(dir, 'src/app.js', 'x'.repeat(5000));
  const list = unsampledDataFiles(dir, BIG);
  assert.deepEqual(list.map((x) => [x.file, x.kind]), [
    ['data/dump.sql', 'sql'],
    ['data/feed.xml', 'xml'],
    ['data/notes.TXT', 'txt'],
    ['data/object.json', 'json'],
    ['data/run.log', 'log'],
  ]);
  assert.ok(list.every((x) => x.bytes > BIG.thresholdBytes && !x.grouped));
  assert.deepEqual(largeDataFiles(dir, BIG), []);
  let called = 0;
  const sel = planSample(dir, BIG, () => {
    called++;
    return seededRng();
  });
  assert.equal(called, 0, 'nothing to draw, no randomness used');
  assert.deepEqual(sel.files, []);
  assert.deepEqual(unsampledOf(sel).map((x) => x.file), list.map((x) => x.file));
  assert.equal(sampleHash(sel), sampleHash(planSample(dir, BIG, () => seededRng())), 'the list is deterministic');
  // a json ARRAY of records over the threshold is sampled, not listed as unsampled
  put(dir, 'data/rows.json', JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, shop: `Shop ${i}` }))));
  assert.deepEqual(largeDataFiles(dir, BIG).map((x) => x.file), ['data/rows.json']);
  assert.ok(!unsampledDataFiles(dir, BIG).some((x) => x.file === 'data/rows.json'));
});

test('unsampled files: a selection without any is of the old shape (no unsampled key, no grouped key)', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/a.csv', csvRows(100));
  put(dir, 'content/tiny.json', '{"a":1}');
  const sel = planSample(dir, TINY, () => seededRng());
  assert.ok(!('unsampled' in sel));
  assert.ok(sel.files.every((f) => !('grouped' in f)));
});

test('unsampled files: reviewer, planter and lens writer are told; the planter cannot put an error there; no receipt lines', (t) => {
  const dir = tmpDir(t);
  put(dir, 'data/object.json', jsonObject(5000));
  put(dir, 'content/a.csv', csvRows(100));
  put(dir, 'content/note.md', 'x\n');
  const settings = { ...TINY, thresholdBytes: 3000, totalBytes: 250000 };
  const sel = planSample(dir, settings, () => seededRng());
  assert.equal(sel.files.length, 1);
  assert.deepEqual(sel.unsampled.map((u) => u.file), ['data/object.json']);
  const view = sampleView(dir, sel);
  assert.ok(view.unsampledByRel.has('data/object.json'));
  assert.deepEqual(view.receiptLines.get('data/object.json'), [], 'nobody is asked to find a line in a file nobody can read whole');
  const rev = annotateForReviewer(view)('data/object.json');
  assert.match(rev, /LARGE DATA FILE THAT CANNOT BE SAMPLED \(\d+(\.\d)? (KB|MB), \.json\)/);
  assert.match(rev, /too big to read whole/);
  assert.match(rev, /check its structure and spot-check it/);
  assert.match(rev, /notChecked/);
  assert.match(annotateForPlanter(view)('data/object.json'), /CANNOT BE SAMPLED[\s\S]*do not put an edit here/);
  assert.match(annotateForLensWriter([], { rows: 200 }, sel.unsampled)('data/object.json'), /CANNOT BE SAMPLED[\s\S]*do not make "every line" of it their duty/);
  assert.equal(annotateForReviewer(view)('content/note.md'), '');
  const guard = makeSampleGuard(dir, sel);
  assert.equal(guard.has('data/object.json'), true);
  const r = guard.check('data/object.json', 10, 3, 'abc');
  assert.equal(r.ok, false);
  assert.match(r.error, /^outside-sample: data\/object\.json is too big/);
  // a selection with only unsampled files still gives a view (and a sealed hash)
  const dir2 = tmpDir(t);
  put(dir2, 'x/dump.sql', 'INSERT INTO t VALUES (1);\n'.repeat(200));
  const sel2 = planSample(dir2, settings, () => seededRng());
  assert.deepEqual(sel2.files, []);
  const v2 = sampleView(dir2, sel2);
  assert.equal(v2.files.length, 0);
  assert.ok(v2.unsampledByRel.has('x/dump.sql'));
});

test('unsampled files: the reviewer minimum names them and does not call them "read whole"', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/shops.csv', csvRows(300));
  put(dir, 'content/dump.sql', 'INSERT INTO t VALUES (1);\n'.repeat(200));
  put(dir, 'content/README.md', 'x\n');
  const settings = { ...TINY, thresholdBytes: 3000 };
  const sel = planSample(dir, settings, () => seededRng());
  const view = sampleView(dir, sel);
  const lens = {
    id: 'consistency',
    minimum: [
      { id: 'M1', rule: 'Read every row.', kind: 'all-files', glob: 'content/*.csv' },
      { id: 'M3', rule: 'Everything once.', kind: 'all-files', glob: 'content/**/*' },
      { id: 'M6', rule: 'Look at the dump.', kind: 'all-files', glob: 'content/*.sql' },
    ],
  };
  const text = minimumValue(lens, dir, manifestOfDir(dir), view);
  assert.match(text, /Files matching content\/\*\*\/\* that are read whole \(1\): content\/README\.md/);
  assert.match(text, /Too big to read whole and with no rows to draw \(1\): content\/dump\.sql\. For these files the duty is to check their structure and to spot-check them/);
  assert.match(text, /^- M6 \(all-files\): Look at the dump\.\n {2}Files matching content\/\*\.sql \(0\): \n {2}Too big to read whole and with no rows to draw \(1\): content\/dump\.sql/m);
  const list = materialListValue(dir, manifestOfDir(dir), { annotate: annotateForReviewer(view) });
  assert.match(list, /- content\/dump\.sql \(text, \d+ bytes\) — LARGE DATA FILE THAT CANNOT BE SAMPLED/);
});

test('groups: many small files of one kind in one folder that together pass the group threshold are sampled as one data set', (t) => {
  const dir = tmpDir(t);
  for (let i = 1; i <= 5; i++) put(dir, `parts/part${i}.csv`, csvRows(45)); // each ~1.8 KB: under the 2 000 byte threshold
  const one = fs.statSync(path.join(dir, 'parts/part1.csv')).size;
  assert.ok(one < BIG.thresholdBytes && one * 5 > BIG.groupBytes, 'the fixture is below the file threshold and above the group one');
  put(dir, 'other/lone.csv', csvRows(45)); // another folder: not part of the group
  put(dir, 'parts/notes.md', 'x'.repeat(9000)); // another kind: prose, never grouped
  const large = largeDataFiles(dir, BIG);
  assert.deepEqual(large.map((x) => x.file), [1, 2, 3, 4, 5].map((i) => `parts/part${i}.csv`));
  for (const x of large) assert.deepEqual(x.grouped, { files: 5, bytes: one * 5 });
  const sel = planSample(dir, BIG, () => seededRng());
  assert.equal(sel.files.length, 5);
  for (const f of sel.files) {
    assert.deepEqual(f.grouped, { files: 5, bytes: one * 5 });
    assert.equal(f.chosen.length, BIG.rows);
  }
  assert.ok(!('unsampled' in sel));
  const view = sampleView(dir, sel);
  assert.match(annotateForReviewer(view)('parts/part2.csv'), /one of 5 files of the same kind in its folder that together are \d+ KB, so they are treated as one data set/);
  // the total sampling budget is shared by the whole group
  assert.ok(sel.files.every((f) => f.capBytes <= Math.floor(BIG.totalBytes / 5)));
});

test('groups: below the group threshold, alone in a folder, of different kinds, or in different folders there is no group', (t) => {
  const dir = tmpDir(t);
  for (let i = 1; i <= 3; i++) put(dir, `a/p${i}.csv`, csvRows(45)); // 3 x ~1.8 KB = 5.4 KB < 8 000
  put(dir, 'b/p1.csv', csvRows(45));
  put(dir, 'c/p1.jsonl', jsonl(30));
  put(dir, 'c/p2.csv', csvRows(45));
  assert.deepEqual(largeDataFiles(dir, BIG), []);
  assert.deepEqual(unsampledDataFiles(dir, BIG), []);
  assert.equal(planSample(dir, BIG, () => seededRng()), null);
  // lower the group threshold: now the three files of folder a form a group, b and c do not
  const g = largeDataFiles(dir, { ...BIG, groupBytes: 4000 });
  assert.deepEqual(g.map((x) => x.file), ['a/p1.csv', 'a/p2.csv', 'a/p3.csv']);
  // ndjson and jsonl are one kind
  const dir2 = tmpDir(t);
  put(dir2, 'x/a.jsonl', jsonl(80));
  put(dir2, 'x/b.ndjson', jsonl(80));
  const sz = fs.statSync(path.join(dir2, 'x/a.jsonl')).size;
  assert.deepEqual(largeDataFiles(dir2, { ...BIG, thresholdBytes: sz + 100, groupBytes: sz * 2 - 10 }).map((x) => x.file), ['x/a.jsonl', 'x/b.ndjson']);
});

test('groups: many small json objects in one folder are listed as one unsampled group', (t) => {
  const dir = tmpDir(t);
  for (let i = 1; i <= 6; i++) put(dir, `dump/part${i}.json`, jsonObject(1500));
  const list = unsampledDataFiles(dir, BIG);
  assert.equal(list.length, 6);
  const total = list.reduce((a, x) => a + x.bytes, 0);
  for (const x of list) assert.deepEqual(x.grouped, { files: 6, bytes: total });
  const sel = planSample(dir, BIG, () => seededRng());
  assert.equal(sel.unsampled.length, 6);
  assert.match(annotateForReviewer(sampleView(dir, sel))('dump/part3.json'), /CANNOT BE SAMPLED[\s\S]*one of 6 files of the same kind/);
});

test('dataFilesOfRun: groups and unsampled files are found per manifest folder across the live roots', (t) => {
  const root = tmpDir(t);
  for (let i = 1; i <= 5; i++) put(root, `parts/p${i}.csv`, csvRows(45));
  put(root, 'feed.xml', '<a>' + 'x'.repeat(3000) + '</a>');
  put(root, 'notes.md', 'x\n');
  const run = { material: { roots: [{ path: root, as: 'dataset', include: ['**/*'] }] } };
  const manifest = { files: [...[1, 2, 3, 4, 5].map((i) => ({ rel: `dataset/parts/p${i}.csv`, kind: 'text' })), { rel: 'dataset/feed.xml', kind: 'text' }, { rel: 'dataset/notes.md', kind: 'text' }] };
  const r = dataFilesOfRun(run, manifest, BIG);
  assert.equal(r.large.length, 5);
  assert.ok(r.large.every((x) => x.grouped && x.grouped.files === 5));
  assert.deepEqual(r.unsampled.map((x) => [x.file, x.kind]), [['dataset/feed.xml', 'xml']]);
  assert.equal(largeDataFilesOfRun(run, manifest, BIG).length, 5);
  assert.equal(classifyEntries([], BIG).large.length, 0);
});
