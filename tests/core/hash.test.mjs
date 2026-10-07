import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonical } from '../../lib/core/canon.mjs';
import { sha256Hex, hashJson, fileKind, hashFile, treeHash, normalizeTextBuffer } from '../../lib/core/hash.mjs';
import { sha256 as pureSha256 } from '../../lib/core/sha256-pure.js';
import { makeRng } from '../../lib/core/rand.mjs';
import { tempDir, rmTemp, REPO } from './_helpers.mjs';

test('canonical JSON sorts keys recursively and has no whitespace', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical([1, 'two', null, true, false]), '[1,"two",null,true,false]');
  assert.equal(canonical({ x: undefined, y: 1 }), '{"y":1}');
  assert.equal(canonical([undefined]), '[null]');
  assert.equal(canonical(1.5e21), JSON.stringify(1.5e21));
  assert.equal(canonical('кириллица "q"'), JSON.stringify('кириллица "q"'));
  assert.equal(canonical({ B: 1, a: 2, _: 3 }), '{"B":1,"_":3,"a":2}');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
});

test('sha256Hex matches node:crypto for strings and buffers', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
});

test('fileKind follows SPEC 9.3', () => {
  const cases = {
    'content/plan.json': 'json', 'a/b.HTML': 'html', 'x.htm': 'html', 'p.md': 'text', 'p.txt': 'text', 'p.csv': 'text',
    's.css': 'text', 'a.js': 'text', 'a.mjs': 'text', 'a.ts': 'text', 'a.tsx': 'text', 'a.py': 'text', 'a.yaml': 'text',
    'a.yml': 'text', 'a.xml': 'text', 'logo.svg': 'text', 'i.png': 'image', 'i.JPG': 'image', 'i.jpeg': 'image',
    'i.gif': 'image', 'i.webp': 'image', 'v.mp4': 'video', 'v.mov': 'video', 'v.webm': 'video', 'doc.pdf': 'binary',
    'Makefile': 'text', '.gitignore': 'text', 'Dockerfile': 'text', 'run.sh': 'text', 'a.ps1': 'text', 'a.go': 'text', 'a.rs': 'text',
    'a.sql': 'text', 'a.jsx': 'text', 'a.cjs': 'text', 'a.toml': 'text', 'notes': 'binary', 'dir\\win.md': 'text',
  };
  for (const [rel, kind] of Object.entries(cases)) assert.equal(fileKind(rel), kind, rel);
});

test('text/json/html hashes ignore BOM and CRLF; binary hashes are raw', (t) => {
  const d = tempDir('hash');
  t.after(() => rmTemp(d));
  const lf = 'line one\nстрока два\n{"a": 1}\n';
  const variants = {
    lf: Buffer.from(lf, 'utf8'),
    crlf: Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8'),
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf, 'utf8')]),
    bomcrlf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')]),
  };
  for (const ext of ['md', 'json', 'html']) {
    const hashes = Object.entries(variants).map(([name, buf]) => {
      const p = path.join(d, `${name}.${ext}`);
      fs.writeFileSync(p, buf);
      return hashFile(p);
    });
    assert.equal(new Set(hashes).size, 1, `all variants equal for .${ext}`);
    assert.equal(hashes[0], sha256Hex(lf));
  }
  // binary kinds are raw
  const a = path.join(d, 'a.png');
  const b = path.join(d, 'b.png');
  fs.writeFileSync(a, variants.lf);
  fs.writeFileSync(b, variants.crlf);
  assert.notEqual(hashFile(a), hashFile(b));
  assert.equal(hashFile(a), sha256Hex(variants.lf));
  // explicit kind overrides the extension
  assert.equal(hashFile(b, 'text'), sha256Hex(lf));
  // a lone CR is kept (only CRLF is normalised)
  assert.equal(normalizeTextBuffer(Buffer.from('a\rb')).toString(), 'a\rb');
});

test('treeHash sorts entries by path and rejects duplicates', () => {
  const e = [['content/b.md', 'b'.repeat(64)], ['content/a.md', 'a'.repeat(64)], ['assets/x.png', 'c'.repeat(64)]];
  const h1 = treeHash(e);
  const h2 = treeHash([...e].reverse());
  assert.equal(h1, h2);
  const sorted = [...e].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  assert.equal(h1, sha256Hex(canonical(sorted)));
  assert.deepEqual(e[0][0], 'content/b.md', 'input not mutated');
  assert.notEqual(treeHash([['a', '1'.repeat(64)]]), treeHash([['b', '1'.repeat(64)]]));
  assert.throws(() => treeHash([['a', 'x'], ['a', 'y']]));
});

test('sha256-pure equals node:crypto on 200 random strings incl. non-ASCII', () => {
  const rng = makeRng({ seedHex: '00112233445566778899aabbccddeeff' });
  const pools = [
    'abcdefghijklmnopqrstuvwxyz0123456789 \n\t"\\{}[]',
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВ',
    'āčēģīķļņšūž ĀČĒ',
    '€—–«»„“”…🙂🚗👍🏽中文日本語 ​',
  ];
  const fixed = ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), '\ud83d', 'a\udc00b'];
  const all = [...fixed];
  while (all.length < 200) {
    const len = rng.int(0, 300);
    let s = '';
    for (let i = 0; i < len; i++) {
      const pool = [...pools[rng.int(0, pools.length)]];
      s += pool[rng.int(0, pool.length)];
    }
    all.push(s);
  }
  for (const s of all) {
    assert.equal(pureSha256(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s).slice(0, 80));
  }
  // a long input crosses many blocks
  const big = randomBytes(5000).toString('base64') + 'ё';
  assert.equal(pureSha256(big), createHash('sha256').update(big, 'utf8').digest('hex'));
});

test('sha256-pure source has markers, no imports and nothing the Workflow sandbox forbids', () => {
  const text = fs.readFileSync(path.join(REPO, 'lib', 'core', 'sha256-pure.js'), 'utf8');
  const m = /\/\/ BEGIN sha256-pure\n([\s\S]*?)\/\/ END sha256-pure/.exec(text);
  assert.ok(m, 'markers present');
  const body = m[1];
  for (const bad of ['import', 'require', 'Date.now', 'Math.random', 'new Date', 'TextEncoder', 'Buffer', 'export']) {
    assert.ok(!body.includes(bad), `inlined block must not contain ${bad}`);
  }
  assert.ok(!/^\s*import\s/m.test(text), 'file has no import statements');
  // The inlined block must work on its own (as the Workflow script will run it).
  const fn = new Function(`${body}\nreturn sha256;`)();
  assert.equal(fn('gauntlet'), createHash('sha256').update('gauntlet').digest('hex'));
});
