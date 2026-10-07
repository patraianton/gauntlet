import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildManifest,
  manifestOfDir,
  countFor,
  countKey,
  positionIndex,
  resolvePointer,
  selectLiveFiles,
} from '../../lib/material/manifest.mjs';
import { takeSnapshot } from '../../lib/material/snapshot.mjs';
import { treeHash } from '../../lib/core/hash.mjs';
import { tmpDir, put, makeMaterial, runFor, BOM, PNG_BYTES } from '../fixtures/material/helpers.mjs';

test('manifest: kinds by extension, rel = <as>/<rel>, sorted, versionHash = treeHash', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  put(root, 'clip.mp4', Buffer.from([0, 1, 2]));
  put(root, 'data.bin', Buffer.from([9, 9]));
  put(root, 'style.css', 'a{}\n');
  const m = buildManifest(runFor(root));
  const kinds = Object.fromEntries(m.files.map((f) => [f.rel, f.kind]));
  assert.deepEqual(kinds, {
    'content/AUTHOR-NOTES.md': 'text',
    'content/clip.mp4': 'video',
    'content/data.bin': 'binary',
    'content/img.png': 'image',
    'content/page.html': 'html',
    'content/page.md': 'text',
    'content/plan.json': 'json',
    'content/style.css': 'text',
  });
  assert.deepEqual(m.files.map((f) => f.rel), [...m.files.map((f) => f.rel)].sort());
  assert.equal(m.versionHash, treeHash(m.files.map((f) => [f.rel, f.sha256])));
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.files.find((f) => f.rel === 'content/img.png').bytes, PNG_BYTES.length);
});

test('manifest: text hashed after BOM strip and CRLF->LF, binary raw', (t) => {
  const a = tmpDir(t);
  const b = tmpDir(t);
  put(a, 'x/page.md', Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]));
  put(b, 'x/page.md', 'a\nb\n');
  put(a, 'x/img.png', Buffer.from('a\r\nb'));
  put(b, 'x/img.png', Buffer.from('a\nb'));
  const ma = manifestOfDir(a);
  const mb = manifestOfDir(b);
  assert.equal(ma.files[1].sha256, mb.files[1].sha256, 'text equal');
  assert.notEqual(ma.files[0].sha256, mb.files[0].sha256, 'binary differs');
});

test('manifest: include/exclude globs are relative to each root; two roots; duplicate as refused', (t) => {
  const base = tmpDir(t);
  const r1 = makeMaterial(path.join(base, 'one'));
  const r2 = path.join(base, 'two');
  put(r2, 'out/a.png', PNG_BYTES);
  put(r2, 'notes/x.md', 'x\n');
  const run = {
    material: {
      roots: [
        { path: r1, as: 'content', include: ['**/*.json', '**/*.md'], exclude: ['AUTHOR-*'] },
        { path: r2, as: 'render', include: ['out/**'] },
      ],
    },
  };
  const rels = buildManifest(run).files.map((f) => f.rel);
  assert.deepEqual(rels, ['content/page.md', 'content/plan.json', 'render/out/a.png']);
  assert.throws(() => selectLiveFiles({ material: { roots: [{ path: r1, as: 'a' }, { path: r2, as: 'a' }] } }), /duplicate/);
  assert.throws(() => selectLiveFiles({ material: { roots: [{ path: path.join(base, 'nope'), as: 'a' }] } }), /does not exist/);
});

test('manifest: counts for a glob and for glob#pointer', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  put(root, 'posts/p1.md', 'one\n');
  put(root, 'posts/p2.md', 'two\n');
  const specs = [{ glob: 'content/posts/*.md' }, { glob: 'content/plan.json', pointer: '/posts' }, { glob: 'content/*.json', pointer: '/nope' }];
  const m = buildManifest(runFor(root), { countsFor: specs });
  assert.deepEqual(m.counts, { 'content/posts/*.md': 2, 'content/plan.json#/posts': 12, 'content/*.json#/nope': 0 });
  assert.equal(countKey({ glob: 'g', pointer: '/p' }), 'g#/p');
  // countFor over a snapshot-like folder gives the same numbers
  const snap = path.join(tmpDir(t), 'snap');
  takeSnapshot(runFor(root), snap);
  assert.equal(countFor(snap, { glob: 'content/posts/*.md' }), 2);
  assert.equal(countFor(snap, { glob: 'content/plan.json', pointer: '/posts' }), 12);
  assert.equal(resolvePointer({ a: [{ 'b/c': 1 }] }, '/a/0/b~1c'), 1);
});

test('manifest: unlistedRecent lists fresh files excluded by the globs, not old ones', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  const fresh = put(root, 'ROUND-NOTES.txt', 'x\n');
  const old = put(root, 'old-draft.txt', 'y\n');
  const now = Date.now();
  const twoDaysAgo = new Date(now - 48 * 3600 * 1000);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  const run = { material: { roots: [{ path: root, as: 'content', include: ['**/*.json', '**/*.md'] }] } };
  const m = buildManifest(run, { nowMs: now });
  assert.ok(m.unlistedRecent.includes(fresh));
  assert.ok(!m.unlistedRecent.includes(old));
  assert.ok(!m.unlistedRecent.some((p) => p.endsWith('plan.json')), 'selected files are not listed');
});

test('positionIndex: reading order first, then path order; fractions over BOM-stripped text', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/a.md', 'aaaa');
  put(dir, 'content/b.md', Buffer.concat([BOM, Buffer.from('bbbb')]));
  put(dir, 'content/c.json', '"cc"');
  put(dir, 'content/img.png', PNG_BYTES);
  const idx = positionIndex(dir, ['content/c.json']);
  assert.deepEqual(idx.files.map((f) => f.rel), ['content/c.json', 'content/a.md', 'content/b.md']);
  assert.equal(idx.totalChars, 12);
  assert.equal(idx.offsetOf('content/c.json', 0), 0);
  assert.equal(idx.offsetOf('content/a.md', 2), 6 / 12);
  assert.equal(idx.offsetOf('content/b.md', 4), 1);
  assert.equal(idx.offsetOf('content/img.png', 0), null);
});

test('snapshot: byte-exact copy (BOM, CRLF, binary) and versionHash equal to the live manifest', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  const snap = path.join(tmpDir(t), 'snapshot');
  const run = runFor(root);
  const m = takeSnapshot(run, snap);
  const live = buildManifest(run);
  assert.equal(m.versionHash, live.versionHash);
  for (const f of live.files) {
    const rel = f.rel.replace(/^content\//, '');
    assert.ok(fs.readFileSync(path.join(snap, 'content', ...rel.split('/'))).equals(fs.readFileSync(path.join(root, ...rel.split('/')))), rel);
  }
  const md = fs.readFileSync(path.join(snap, 'content', 'page.md'));
  assert.ok(md.subarray(0, 3).equals(BOM), 'BOM kept');
  assert.ok(md.includes(Buffer.from('\r\n')), 'CRLF kept');
  assert.throws(() => takeSnapshot(run, snap), /not empty/);
});

test('snapshot: excluded files are not copied', (t) => {
  const root = makeMaterial(path.join(tmpDir(t), 'live'));
  const snap = path.join(tmpDir(t), 'snapshot');
  const run = { material: { roots: [{ path: root, as: 'content', include: ['**/*'], exclude: ['**/*.png'] }] } };
  const m = takeSnapshot(run, snap);
  assert.ok(!m.files.some((f) => f.kind === 'image'));
  assert.ok(!fs.existsSync(path.join(snap, 'content', 'img.png')));
});
