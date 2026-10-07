import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyStrip } from '../../lib/material/strip.mjs';
import { makeReviewCopy, neutralName, copyTreeHash, rebuildCopy, copyListing, diffListings, isScratchPath, removeScratch } from '../../lib/material/copy.mjs';
import { takeSnapshot } from '../../lib/material/snapshot.mjs';
import { loadPatterns } from '../../lib/material/lint.mjs';
import { NEUTRAL_ALPHABET } from '../../lib/core/rand.mjs';
import { tmpDir, put, makeMaterial, runFor, seededRng, makeRunTemplates, BOM } from '../fixtures/material/helpers.mjs';

const read = (p) => fs.readFileSync(p);

test('applyStrip: excludes first, then regex rules; expect any / atLeastOne / zero; BOM and CRLF kept', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/page.md', Buffer.concat([BOM, Buffer.from('Title\r\nScores: 9.3 average\r\nBody\r\n')]));
  put(dir, 'content/ROUND2-FEEDBACK.md', 'old feedback\n');
  put(dir, 'content/sub/scores.json', '{}\n');
  put(dir, 'content/img.png', Buffer.from('Scores: 9.3 average'));
  const strip = {
    excludeGlobs: ['**/*FEEDBACK*.md', '**/scores.json'],
    regex: [
      { glob: '**/*.md', pattern: 'Scores: [0-9.]+ average\\r?\\n', expect: 'atLeastOne', why: 'score line' },
      { glob: '**/*.md', pattern: 'never-there', expect: 'atLeastOne', why: 'must hit' },
      { glob: '**/*.md', pattern: 'Body', expect: 'zero', why: 'must be absent' },
      { glob: '**/*.md', pattern: 'Title', replace: 'Heading', expect: 'any', why: 'rename' },
      { glob: '**/*.md', pattern: '(', expect: 'any', why: 'broken' },
    ],
  };
  const r = applyStrip(dir, strip);
  assert.deepEqual(r.excluded.sort(), ['content/ROUND2-FEEDBACK.md', 'content/sub/scores.json']);
  assert.ok(!fs.existsSync(path.join(dir, 'content', 'sub')), 'emptied folder removed');
  const page = read(path.join(dir, 'content', 'page.md'));
  assert.ok(page.subarray(0, 3).equals(BOM));
  // the 'zero' rule is violated and still applied (its empty replacement removed "Body")
  assert.equal(page.subarray(3).toString('utf8'), 'Heading\r\n\r\n');
  assert.equal(read(path.join(dir, 'content', 'img.png')).toString('utf8'), 'Scores: 9.3 average', 'binary untouched');
  const v = Object.fromEntries(r.violations.map((x) => [x.rule, x]));
  assert.equal(v['regex[1]'].expect, 'atLeastOne');
  assert.equal(v['regex[1]'].matches, 0);
  assert.equal(v['regex[2]'].expect, 'zero');
  assert.equal(v['regex[2]'].matches, 1);
  assert.ok(v['regex[4]'].error);
  assert.ok(!v['regex[0]'] && !v['regex[3]']);
  assert.ok(r.log.some((l) => l.rule === 'regex[0]' && l.file === 'content/page.md' && l.matches === 1));
});

test('applyStrip: a rule that breaks a JSON file is a violation', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/p.json', '{"a": "keep", "b": 1}\n');
  const r = applyStrip(dir, { excludeGlobs: [], regex: [{ glob: '**/*.json', pattern: '"keep",', expect: 'atLeastOne', why: 'x' }] });
  assert.ok(r.violations.some((v) => v.expect === 'json-valid' && v.file === 'content/p.json'));
});

test('neutralName: 8 chars of the neutral alphabet; a name that hits a trace pattern is regenerated', (t) => {
  const base = tmpDir(t);
  const pats = loadPatterns('trace');
  const name = neutralName(base, seededRng(), pats);
  assert.match(name, /^[a-z2-9]{8}$/);
  for (const ch of name) assert.ok(NEUTRAL_ALPHABET.includes(ch));
  const queue = ['canary', 'abcd2345'];
  const fake = { id: () => queue.shift() };
  assert.equal(neutralName(base, fake, pats), 'abcd2345');
  // an existing folder is skipped too
  fs.mkdirSync(path.join(base, 'zzzz2222'));
  const q2 = ['zzzz2222', 'yyyy3333'];
  assert.equal(neutralName(base, { id: () => q2.shift() }, pats), 'yyyy3333');
});

function setup(t, extra = {}) {
  const base = tmpDir(t);
  const root = makeMaterial(path.join(base, 'live'));
  const run = runFor(root, extra);
  const snap = path.join(base, 'run', 'rounds', '01', 'snapshot');
  takeSnapshot(run, snap);
  const templatesDir = makeRunTemplates(path.join(base, 'run', 'templates'));
  const reviewBase = path.join(base, 'wc');
  return { base, root, run, snap, templatesDir, reviewBase };
}

test('makeReviewCopy: layout <copyDir>/<as>/<rel>, byte-exact, banner prepended, no hits', (t) => {
  const s = setup(t);
  const r = makeReviewCopy({ run: s.run, strip: { excludeGlobs: [], regex: [], traceAllow: [] }, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  assert.equal(path.dirname(r.copyDir), s.reviewBase);
  assert.equal(path.basename(r.copyDir), r.copyId);
  assert.match(r.copyId, /^[a-z2-9]{8}$/);
  assert.deepEqual(r.traceHits, []);
  assert.deepEqual(r.stripViolations, []);
  for (const f of ['plan.json', 'page.md', 'page.html', 'img.png']) {
    assert.ok(read(path.join(r.copyDir, 'content', f)).equals(read(path.join(s.root, f))), f);
  }
  assert.deepEqual(r.bannerFiles, ['content/AUTHOR-NOTES.md']);
  const notes = read(path.join(r.copyDir, 'content', 'AUTHOR-NOTES.md')).toString('utf8');
  assert.ok(notes.startsWith("Author's notes. Claims by the person who made the work."));
  assert.ok(notes.includes('Заметки автора.'));
  assert.ok(notes.endsWith('# Notes\nThe price was checked against S1.\n'));
  assert.equal(r.rebuild, null);
  assert.equal(r.copyTreeHash, copyTreeHash(r.copyDir));
});

test('makeReviewCopy: banner keeps the notes file BOM and CRLF', (t) => {
  const s = setup(t);
  fs.rmSync(s.snap, { recursive: true });
  put(s.root, 'AUTHOR-NOTES.md', Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]));
  takeSnapshot(s.run, s.snap);
  const r = makeReviewCopy({ run: s.run, strip: {}, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), bannerText: 'Line A\nLine B\n' });
  const buf = read(path.join(r.copyDir, 'content', 'AUTHOR-NOTES.md'));
  assert.ok(buf.subarray(0, 3).equals(BOM));
  assert.equal(buf.subarray(3).toString('utf8'), 'Line A\r\nLine B\r\n\r\na\r\nb\r\n');
});

test('makeReviewCopy: trace hits in contents and paths are reported; traceAllow removes covered hits', (t) => {
  const s = setup(t);
  fs.rmSync(s.snap, { recursive: true });
  put(s.root, 'page.md', 'Plan\nкруг 3: исправлено\nSolar panel kits\n');
  put(s.root, 'review-notes/x.md', 'plain\n');
  takeSnapshot(s.run, s.snap);
  const strip = { excludeGlobs: [], regex: [], traceAllow: [{ phrase: 'Solar panel kits', why: 'product' }] };
  const r = makeReviewCopy({ run: s.run, strip, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  const ids = r.traceHits.map((h) => `${h.file}:${h.line}:${h.patternId}`);
  assert.ok(ids.includes('content/page.md:2:T-ROUND-RU'));
  assert.ok(ids.includes('content/page.md:2:T-FIXED-RU'));
  assert.ok(!ids.some((x) => x.includes('T-PANEL-EN')), 'allowed product word');
  assert.ok(r.traceHits.some((h) => h.where === 'path' && h.file === 'content/review-notes' && h.patternId === 'P-REVIEW'));
});

test('makeReviewCopy: strip rules clean the copy only; the snapshot is unchanged', (t) => {
  const s = setup(t);
  fs.rmSync(s.snap, { recursive: true });
  put(s.root, 'page.md', 'Plan\nAverage score 9.3/10 after round 4\nEnd\n');
  takeSnapshot(s.run, s.snap);
  const before = read(path.join(s.snap, 'content', 'page.md'));
  const strip = { excludeGlobs: [], regex: [{ glob: '**/page.md', pattern: 'Average score[^\\n]*\\n', expect: 'atLeastOne', why: 'history line' }] };
  const r = makeReviewCopy({ run: s.run, strip, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  assert.deepEqual(r.traceHits, []);
  assert.equal(read(path.join(r.copyDir, 'content', 'page.md')).toString(), 'Plan\nEnd\n');
  assert.ok(read(path.join(s.snap, 'content', 'page.md')).equals(before));
});

test('makeReviewCopy: rebuild runs on the copy with {copy} and strip.rebuildEnv', (t) => {
  const script =
    "const fs=require('fs'),p=require('path');const c=process.argv[1];" +
    "fs.mkdirSync(p.join(c,'content','out'),{recursive:true});" +
    "fs.writeFileSync(p.join(c,'content','out','render.txt'),'mode='+process.env.BLIND+'\\n');";
  const s = setup(t, {
    rebuild: { cmd: 'node', args: ['-e', script, '{copy}'], cwd: '{copy}', sourcesGlob: ['content/*.json'], outputsGlob: ['content/out/**'], timeoutS: 60 },
  });
  const r = makeReviewCopy({ run: s.run, strip: { rebuildEnv: { BLIND: '1' } }, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  assert.equal(r.rebuild.exitCode, 0, r.rebuild.stderrTail);
  assert.deepEqual(r.rebuild.outputs, ['content/out/render.txt']);
  assert.equal(read(path.join(r.copyDir, 'content', 'out', 'render.txt')).toString(), 'mode=1\n');
  assert.ok(!fs.existsSync(path.join(s.root, 'out')), 'live root untouched');
  // a refused executable is reported, not thrown
  const bad = rebuildCopy({ rebuild: { cmd: 'powershell', args: [] }, allowExecutables: ['node'] }, {}, r.copyDir);
  assert.equal(bad.exitCode, null);
  assert.match(bad.error, /allowlist/);
});

test('copyTreeHash changes when someone writes into the copy', (t) => {
  const s = setup(t);
  const r = makeReviewCopy({ run: s.run, strip: {}, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  const h0 = copyTreeHash(r.copyDir);
  put(r.copyDir, 'content/scratch.txt', 'notes\n');
  assert.notEqual(copyTreeHash(r.copyDir), h0);
});

test('makeReviewCopy: author notes without a banner source is a usage error', (t) => {
  const s = setup(t);
  assert.throws(() => makeReviewCopy({ run: s.run, strip: {}, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng() }), /banner/);
});

// ---------------------------------------------------------------- which file changed (SPEC 14.13)


test('copyListing: the tree hash of copyTreeHash plus hash, size and time of every file', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/a.md', 'alpha\n');
  put(dir, 'data/rows.csv', 'x,y\n1,2\n');
  const l = copyListing(dir);
  assert.equal(l.treeHash, copyTreeHash(dir));
  assert.deepEqual(l.files.map((f) => f.rel), ['content/a.md', 'data/rows.csv']);
  const a = l.files[0];
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.bytes, 6);
  assert.ok(Math.abs(a.mtimeMs - Date.now()) < 60_000);
});

test('diffListings: added, changed (by content), removed; a BOM or line-ending change is not a change; either side may be missing', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/a.md', 'alpha\n');
  put(dir, 'content/b.md', 'beta\n');
  put(dir, 'content/c.md', 'gamma\n');
  const before = copyListing(dir);
  fs.writeFileSync(path.join(dir, 'content', 'a.md'), 'alpha changed\n');
  fs.rmSync(path.join(dir, 'content', 'b.md'));
  put(dir, 'content/helper.py', 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'content', 'c.md'), Buffer.concat([BOM, Buffer.from('gamma\r\n')]));
  const d = diffListings(before, copyListing(dir));
  assert.deepEqual(d.added.map((f) => f.rel), ['content/helper.py']);
  assert.deepEqual(d.changed.map((f) => f.rel), ['content/a.md']);
  assert.equal(d.changed[0].bytesBefore, 6);
  assert.equal(d.changed[0].bytes, 14);
  assert.deepEqual(d.removed.map((f) => f.rel), ['content/b.md']);
  assert.equal(d.removed[0].bytesBefore, 5);
  // the folder is gone: everything the before list held is "removed"
  assert.deepEqual(diffListings(before, null).removed.map((f) => f.rel), ['content/a.md', 'content/b.md', 'content/c.md']);
});

test('isScratchPath: only byte-code in __pycache__ and the pytest cache; nothing else, whatever its folder', () => {
  for (const ok of ['content/__pycache__/parse.cpython-312.pyc', '__pycache__/x.pyc', 'a/b/.pytest_cache/README.md', 'a/.pytest_cache/v/cache/lastfailed', 'a/.pytest_cache/v/cache/nodeids', 'a/.pytest_cache/v/cache/stepwise', 'a/.pytest_cache/.gitignore', 'a/.pytest_cache/CACHEDIR.TAG', 'a/__pycache__/x.PYC']) {
    assert.equal(isScratchPath(ok), true, ok);
  }
  for (const no of ['content/helper.py', 'content/extract.json', 'content/__pycache__/notes.txt', 'content/__pycache__/sub/x.pyc', 'content/x.pyc', 'content/pycache/x.pyc', 'content/my__pycache__/x.pyc', 'content/.pytest_cache', 'content/.pytest_cache/notes.md', 'content/.pytest_cache/v/cache/other', 'content/.pytest_cache/v/notes.txt', 'content/.pytest_cache/sub/README.md', 'content/.mypy_cache/x', 'content/data.csv']) {
    assert.equal(isScratchPath(no), false, no);
  }
});

const PYC_BYTES = Buffer.concat([Buffer.from([0xcb, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]), Buffer.from('payload')]);

test('isScratchPath with the copy folder also looks at the content: byte-code header and source, the way pytest starts its files, JSON, size', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/parse.py', 'import json\n');
  put(dir, 'content/__pycache__/parse.cpython-312.pyc', PYC_BYTES);
  put(dir, 'content/__pycache__/orphan.cpython-312.pyc', PYC_BYTES); // no orphan.py
  put(dir, 'content/__pycache__/note.cpython-312.pyc', 'a note, not byte-code');
  put(dir, 'content/__pycache__/short.cpython-312.pyc', 'x');
  put(dir, 'content/note.py', '');
  put(dir, 'content/short.py', '');
  put(dir, 'content/.pytest_cache/README.md', '# pytest cache directory #\n\nThis directory contains data');
  put(dir, 'content/.pytest_cache/.gitignore', '# Created by pytest automatically.\n*\n');
  put(dir, 'content/.pytest_cache/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n');
  put(dir, 'content/.pytest_cache/v/cache/lastfailed', '{"tests/test_a.py::test_x": true}');
  put(dir, 'content/.pytest_cache/v/cache/nodeids', '["a::b"]');
  put(dir, 'content/.pytest_cache/v/cache/stepwise', 'a note, not JSON');
  const big = 'x'.repeat(5000);
  put(dir, 'tests/.pytest_cache/README.md', '# pytest cache directory #\n' + big);
  put(dir, 'tests/.pytest_cache/.gitignore', 'a note for the other reviewers');
  for (const ok of ['content/__pycache__/parse.cpython-312.pyc', 'content/.pytest_cache/README.md', 'content/.pytest_cache/.gitignore', 'content/.pytest_cache/CACHEDIR.TAG', 'content/.pytest_cache/v/cache/lastfailed', 'content/.pytest_cache/v/cache/nodeids']) {
    assert.equal(isScratchPath(ok, dir), true, ok);
  }
  for (const no of ['content/__pycache__/orphan.cpython-312.pyc', 'content/__pycache__/note.cpython-312.pyc', 'content/__pycache__/short.cpython-312.pyc', 'content/__pycache__/gone.cpython-312.pyc', 'content/.pytest_cache/v/cache/stepwise', 'tests/.pytest_cache/README.md', 'tests/.pytest_cache/.gitignore']) {
    assert.equal(isScratchPath(no, dir), false, no);
  }
  // removeScratch refuses what the content check refuses
  const res = removeScratch(dir, ['content/__pycache__/note.cpython-312.pyc', 'content/__pycache__/parse.cpython-312.pyc']);
  assert.deepEqual(res.removed, ['content/__pycache__/parse.cpython-312.pyc']);
  assert.deepEqual(res.failed.map((f) => f.rel), ['content/__pycache__/note.cpython-312.pyc']);
});

test('removeScratch: removes the listed scratch files and the folders it leaves empty, refuses anything else', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/page.md', 'text\n');
  put(dir, 'content/parse.py', '');
  put(dir, 'content/other.py', '');
  put(dir, 'content/__pycache__/parse.cpython-312.pyc', PYC_BYTES);
  put(dir, 'content/__pycache__/other.cpython-312.pyc', PYC_BYTES);
  put(dir, 'tests/.pytest_cache/v/cache/lastfailed', '{}');
  const res = removeScratch(dir, ['content/__pycache__/parse.cpython-312.pyc', 'content/__pycache__/other.cpython-312.pyc', 'tests/.pytest_cache/v/cache/lastfailed', 'content/page.md']);
  assert.deepEqual(res.failed, [{ rel: 'content/page.md', error: 'not a scratch path' }]);
  assert.equal(res.removed.length, 3);
  assert.ok(!fs.existsSync(path.join(dir, 'content', '__pycache__')), 'the emptied __pycache__ folder is gone');
  assert.ok(!fs.existsSync(path.join(dir, 'tests', '.pytest_cache')), 'the emptied pytest cache is gone');
  assert.ok(fs.existsSync(path.join(dir, 'content', 'page.md')), 'the material file is untouched');
  assert.ok(fs.existsSync(path.join(dir, 'content')) && fs.existsSync(path.join(dir, 'tests')), 'folders outside the scratch folders stay');
});

test('makeReviewCopy returns the listing of the finished copy, equal in hash to copyTreeHash', (t) => {
  const s = setup(t);
  const c = makeReviewCopy({ run: s.run, strip: {}, snapshotDir: s.snap, reviewBase: s.reviewBase, rng: seededRng(), templatesDir: s.templatesDir });
  assert.equal(c.listing.treeHash, c.copyTreeHash);
  assert.equal(c.copyTreeHash, copyTreeHash(c.copyDir));
  assert.ok(c.listing.files.length > 0);
});
