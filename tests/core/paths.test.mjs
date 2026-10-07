import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, toPosix, toNative, isUnder, relPosix, assertAllowedRunDir, components, runRoots, runRootOf } from '../../lib/core/paths.mjs';
import { UsageError } from '../../lib/core/errors.mjs';

const W = { platform: 'win32', home: 'C:\\Users\\user', cwd: 'C:\\work' };
const M = { platform: 'darwin', home: '/Users/user', cwd: '/Users/user/work' };

test('win32: C:\\, C:/, /c/, ~, quotes, spaces and Cyrillic all normalise to one native path', () => {
  const want = 'C:\\Users\\user\\work-copies\\мой проект\\план.md';
  for (const p of [
    'C:\\Users\\user\\work-copies\\мой проект\\план.md',
    'C:/Users/user/work-copies/мой проект/план.md',
    'c:/Users/user/work-copies/мой проект/план.md',
    '/c/Users/user/work-copies/мой проект/план.md',
    '/mnt/c/Users/user/work-copies/мой проект/план.md',
    '~/work-copies/мой проект/план.md',
    '~\\work-copies\\мой проект\\план.md',
    '"C:\\Users\\user\\work-copies\\мой проект\\план.md"',
    'C:\\Users\\user\\work-copies\\мой проект\\x\\..\\план.md',
  ]) {
    assert.equal(normalizeInput(p, W), want, p);
  }
  assert.equal(normalizeInput('C:\\Users\\', W), 'C:\\Users');
  assert.equal(normalizeInput('C:\\', W), 'C:\\');
  assert.equal(normalizeInput('/c', W), 'C:\\');
  assert.equal(normalizeInput('rel\\dir', W), 'C:\\work\\rel\\dir');
  assert.equal(normalizeInput('~', W), 'C:\\Users\\user');
  assert.throws(() => normalizeInput('', W), UsageError);
});

test('mac: ~ and relative paths; /c/ is an ordinary folder', () => {
  assert.equal(normalizeInput('~/work-copies/x', M), '/Users/user/work-copies/x');
  assert.equal(normalizeInput('rel', M), '/Users/user/work/rel');
  assert.equal(normalizeInput('/c/x/', M), '/c/x');
});

test('toPosix and toNative', () => {
  assert.equal(toPosix('content\\a\\b.md'), 'content/a/b.md');
  assert.equal(toNative('content/a/b.md', W), 'content\\a\\b.md');
  assert.equal(toNative('content/a/b.md', M), 'content/a/b.md');
});

test('isUnder: inclusive, lexical, case-insensitive on win32, not fooled by prefixes', () => {
  assert.ok(isUnder('C:\\A\\b\\c.md', 'c:/a', W));
  assert.ok(isUnder('/c/a/B', 'C:\\A\\b', W));
  assert.ok(isUnder('C:\\a', 'C:\\a', W));
  assert.ok(!isUnder('C:\\ab\\c', 'C:\\a', W));
  assert.ok(!isUnder('C:\\a\\..\\b', 'C:\\a', W));
  assert.ok(!isUnder('D:\\a', 'C:\\a', W));
  assert.ok(isUnder('C:\\a\\..b\\x', 'C:\\a', W), 'a child folder whose name starts with ".." is inside');
  assert.ok(isUnder('C:\\Проект\\Файл.md', 'c:\\проект', W));
  assert.ok(!isUnder('/Users/A/x', '/Users/a', M), 'case-sensitive off win32');
  assert.ok(isUnder('/Users/a/x y/z', '/Users/a/x y', M));
});

test('relPosix', () => {
  assert.equal(relPosix('C:\\run\\snap', 'c:/run/snap/content/a b/план.md', W), 'content/a b/план.md');
  assert.throws(() => relPosix('C:\\run', 'C:\\other\\x', W), UsageError);
  assert.equal(relPosix('/r', '/r/a/b', M), 'a/b');
});

test('components', () => {
  assert.deepEqual(components('C:\\Users\\user\\x', W), ['Users', 'user', 'x']);
  assert.deepEqual(components('/Users/user/x', M), ['Users', 'user', 'x']);
});

test('assertAllowedRunDir: only strictly inside a run root (default <home>/work-copies), unless GAUNTLET_TEST=1', () => {
  const env = {};
  assert.equal(
    assertAllowedRunDir('C:/Users/user/work-copies/demo-project/gauntlet-runs/20260115-0930-a1b2c3', { ...W, env }),
    'C:\\Users\\user\\work-copies\\demo-project\\gauntlet-runs\\20260115-0930-a1b2c3',
  );
  assert.ok(assertAllowedRunDir('/c/Users/user/WORK-COPIES/x/gauntlet-runs/r', { ...W, env }), 'case-insensitive on windows');
  assert.ok(assertAllowedRunDir('~/work-copies/demo-project/gauntlet-runs/r', { ...M, env }));
  for (const p of ['C:\\Users\\user\\projects\\x\\gauntlet-runs\\r', 'C:\\Users\\user', 'C:\\Users\\user\\work-copies', 'C:\\tmp\\work-copiesX\\r']) {
    assert.throws(() => assertAllowedRunDir(p, { ...W, env }), UsageError, p);
  }
  assert.throws(() => assertAllowedRunDir('/Users/user/Work-Copies/x', { ...M, env }), UsageError, 'case-sensitive on mac');
  assert.ok(assertAllowedRunDir('C:\\Temp\\anything', { ...W, env: { GAUNTLET_TEST: '1' } }));
  assert.throws(() => assertAllowedRunDir('C:\\Temp\\anything', { ...W, env: { GAUNTLET_TEST: 'true' } }), UsageError);
});

test('runRoots: default, GAUNTLET_RUN_ROOTS list and the "*" entry', () => {
  assert.deepEqual(runRoots({ ...W, env: {} }), { any: false, roots: ['C:\\Users\\user\\work-copies'] });
  assert.deepEqual(runRoots({ ...M, env: {} }), { any: false, roots: ['/Users/user/work-copies'] });
  const win = runRoots({ ...W, env: { GAUNTLET_RUN_ROOTS: 'D:\\runs; C:\\Users\\user\\a\\b' } });
  assert.deepEqual(win, { any: false, roots: ['D:\\runs', 'C:\\Users\\user\\a\\b'] });
  assert.deepEqual(runRoots({ ...M, env: { GAUNTLET_RUN_ROOTS: '/data/runs:~/more' } }).roots, ['/data/runs', '/Users/user/more']);
  const star = runRoots({ ...M, env: { GAUNTLET_RUN_ROOTS: '*' } });
  assert.equal(star.any, true);
  assert.deepEqual(star.roots, ['/Users/user/work-copies']);
  // a custom root replaces the default one
  const env = { GAUNTLET_RUN_ROOTS: 'D:\\runs' };
  assert.ok(assertAllowedRunDir('D:\\runs\\p\\gauntlet-runs\\r', { ...W, env }));
  assert.throws(() => assertAllowedRunDir('C:\\Users\\user\\work-copies\\p\\r', { ...W, env }), UsageError);
  assert.throws(() => assertAllowedRunDir('D:\\runs', { ...W, env }), UsageError, 'the root itself is not a run folder');
  assert.ok(assertAllowedRunDir('E:\\anywhere\\r', { ...W, env: { GAUNTLET_RUN_ROOTS: '*' } }));
  assert.equal(runRootOf('D:\\runs\\p\\r', { ...W, env }), 'D:\\runs');
  assert.equal(runRootOf('C:\\other\\r', { ...W, env }), null);
});

test('real platform round-trip', () => {
  const n = normalizeInput(process.cwd());
  assert.equal(normalizeInput(toPosix(n)), n);
});
