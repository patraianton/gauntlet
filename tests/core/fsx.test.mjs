import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readText, readJson, writeTextAtomic, writeJsonAtomic, writeExclusive, appendLine, readRaw, writeRaw,
  listFiles, copyFiles, safeRemove, mtimeMs, findLinks,
} from '../../lib/core/fsx.mjs';
import { UsageError } from '../../lib/core/errors.mjs';
import { tempDir, rmTemp } from './_helpers.mjs';

function dir(t) {
  const d = tempDir('fsx');
  t.after(() => rmTemp(d));
  return d;
}

function makeLink(target, link) {
  // On Windows a junction needs no admin rights; elsewhere a plain symlink.
  if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction');
  else fs.symlinkSync(target, link);
}

test('readText strips a BOM but keeps line endings; readJson tolerates a BOM', (t) => {
  const d = dir(t);
  const p = path.join(d, 'a.json');
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":"б"}\r\n')]));
  assert.equal(readText(p), '{"a":"б"}\r\n');
  assert.deepEqual(readJson(p), { a: 'б' });
  fs.writeFileSync(p, '{bad');
  assert.throws(() => readJson(p), (e) => e instanceof SyntaxError && e.message.includes(p));
});

test('writeTextAtomic writes UTF-8 without BOM, LF, creates folders, leaves no temp files', (t) => {
  const d = dir(t);
  const p = path.join(d, 'новая папка', 'x y', 'f.md');
  writeTextAtomic(p, '\ufeffone\r\ntwo\n');
  const raw = fs.readFileSync(p);
  assert.notEqual(raw[0], 0xef);
  assert.equal(raw.toString('utf8'), 'one\ntwo\n');
  writeTextAtomic(p, 'replaced');
  assert.equal(readText(p), 'replaced');
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ['f.md']);
  writeJsonAtomic(path.join(d, 'j.json'), { b: 1, a: [1] });
  assert.equal(fs.readFileSync(path.join(d, 'j.json'), 'utf8'), '{\n  "b": 1,\n  "a": [\n    1\n  ]\n}\n');
  writeRaw(path.join(d, 'r.bin'), Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]));
  assert.deepEqual([...readRaw(path.join(d, 'r.bin'))], [0xef, 0xbb, 0xbf, 0x0d, 0x0a]);
});

test('writeExclusive never overwrites and keeps bytes verbatim', (t) => {
  const d = dir(t);
  const p = path.join(d, 'answers', 'job.json');
  writeExclusive(p, '{"a":1}\r\n');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\r\n');
  assert.throws(() => writeExclusive(p, 'other'), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\r\n');
});

test('appendLine adds LF and refuses embedded newlines', (t) => {
  const d = dir(t);
  const p = path.join(d, 'l.jsonl');
  appendLine(p, 'a');
  appendLine(p, 'b');
  assert.equal(fs.readFileSync(p, 'utf8'), 'a\nb\n');
  assert.throws(() => appendLine(p, 'x\ny'), UsageError);
});

test('mtimeMs returns a number or null', (t) => {
  const d = dir(t);
  assert.equal(mtimeMs(path.join(d, 'none')), null);
  writeTextAtomic(path.join(d, 'x'), 'x');
  assert.equal(typeof mtimeMs(path.join(d, 'x')), 'number');
});

test('listFiles: sorted POSIX paths, skips .git, does not follow directory links', (t) => {
  const d = dir(t);
  const root = path.join(d, 'root');
  for (const rel of ['b.md', 'a/z.json', 'a/c d/файл.md', '.hidden', '.git/HEAD', 'sub/.git']) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel);
  }
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'x');
  makeLink(outside, path.join(root, 'linked'));
  assert.deepEqual(listFiles(root), ['.hidden', 'a/c d/файл.md', 'a/z.json', 'b.md']);
  assert.deepEqual(listFiles(path.join(d, 'missing')), []);
});

test('copyFiles is byte-exact and refuses unsafe relative paths', (t) => {
  const d = dir(t);
  const src = path.join(d, 'src');
  const dst = path.join(d, 'dst');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nб\n')]);
  fs.mkdirSync(path.join(src, 'x y'), { recursive: true });
  fs.writeFileSync(path.join(src, 'x y', 'f.md'), bytes);
  fs.writeFileSync(path.join(src, 'img.png'), Buffer.from([0, 1, 2, 255]));
  copyFiles(src, ['x y/f.md', 'img.png'], dst);
  assert.deepEqual(fs.readFileSync(path.join(dst, 'x y', 'f.md')), bytes);
  assert.deepEqual([...fs.readFileSync(path.join(dst, 'img.png'))], [0, 1, 2, 255]);
  for (const bad of ['../x', '/abs', 'C:/x', 'a//b', '']) assert.throws(() => copyFiles(src, [bad], dst), UsageError, bad);
});

test('safeRemove removes a plain tree and treats a missing path as removed', (t) => {
  const d = dir(t);
  const tree = path.join(d, 'wc', 'abcdefgh');
  fs.mkdirSync(path.join(tree, 'content', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'content', 'deep', 'a.md'), 'x');
  fs.writeFileSync(path.join(tree, 'b.md'), 'x');
  assert.deepEqual(safeRemove(tree), { removed: true, refused: [], leftovers: [] });
  assert.ok(!fs.existsSync(tree));
  assert.deepEqual(safeRemove(tree), { removed: true, refused: [], leftovers: [] });
  const f = path.join(d, 'single.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(safeRemove(f).removed, true);
});

test('safeRemove refuses a tree containing a junction/symlink and deletes nothing', (t) => {
  const d = dir(t);
  const precious = path.join(d, 'precious');
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, 'keep.md'), 'keep');
  const tree = path.join(d, 'wc', 'job');
  fs.mkdirSync(path.join(tree, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'inner', 'x.md'), 'x');
  const link = path.join(tree, 'inner', 'node_modules');
  makeLink(precious, link);
  assert.deepEqual(findLinks(tree), [link]);
  const r = safeRemove(tree);
  assert.equal(r.removed, false);
  assert.deepEqual(r.refused, [link]);
  assert.ok(fs.existsSync(path.join(tree, 'inner', 'x.md')), 'nothing removed');
  assert.equal(fs.readFileSync(path.join(precious, 'keep.md'), 'utf8'), 'keep', 'link target untouched');
  // the link itself as the target is refused too
  assert.equal(safeRemove(link).removed, false);
  // clean up the link by hand without following it
  fs.rmSync(link, { recursive: false, force: true });
  if (fs.existsSync(link)) fs.rmdirSync(link);
  assert.equal(safeRemove(tree).removed, true);
  assert.ok(fs.existsSync(path.join(precious, 'keep.md')));
});

test('safeRemove refuses a drive root and the home folder', async () => {
  const os = await import('node:os');
  assert.equal(safeRemove(os.homedir()).removed, false);
  assert.equal(safeRemove(path.parse(process.cwd()).root).removed, false);
});
