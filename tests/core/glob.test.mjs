import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchGlob, selectFiles } from '../../lib/core/glob.mjs';

const cs = { nocase: false };
const ci = { nocase: true };

test('* stays inside one segment; ? is one character', () => {
  assert.ok(matchGlob('content/plan.json', 'content/*.json', cs));
  assert.ok(!matchGlob('content/a/plan.json', 'content/*.json', cs));
  assert.ok(matchGlob('a/b1.md', 'a/b?.md', cs));
  assert.ok(!matchGlob('a/b12.md', 'a/b?.md', cs));
  assert.ok(!matchGlob('a/b/c', 'a?b/c', cs));
  assert.ok(!matchGlob('plan.json', 'content/*.json', cs), 'whole path must match');
});

test('** matches zero or more segments', () => {
  for (const rel of ['x.md', 'a/x.md', 'a/b/c/x.md']) assert.ok(matchGlob(rel, '**/*.md', cs), rel);
  assert.ok(matchGlob('content/a/b.json', 'content/**', cs));
  assert.ok(!matchGlob('content', 'content/**', cs));
  assert.ok(!matchGlob('other/a', 'content/**', cs));
  assert.ok(matchGlob('a/b', 'a/**/b', cs));
  assert.ok(matchGlob('a/x/y/b', 'a/**/b', cs));
  assert.ok(!matchGlob('a/x/yb', 'a/**/b', cs));
  assert.ok(matchGlob('anything/at/all', '**', cs));
  assert.ok(matchGlob('content/ROUND3-FEEDBACK.md', '**/*FEEDBACK*.md', cs));
  assert.ok(matchGlob('ab/cd', 'a**/cd', cs), '** inside a segment acts like *');
  assert.ok(!matchGlob('a/b/cd', 'a**/cd', cs));
});

test('dotfiles are matched like other names', () => {
  assert.ok(matchGlob('.hidden', '*', cs));
  assert.ok(matchGlob('content/.env', 'content/*', cs));
  assert.ok(matchGlob('.git-like/x/.y.md', '**/*.md', cs));
  assert.ok(matchGlob('content/.drafts/a.md', 'content/**/*.md', cs));
});

test('case: insensitive on request (default on win32), sensitive otherwise', () => {
  assert.ok(matchGlob('Content/Plan.JSON', 'content/*.json', ci));
  assert.ok(!matchGlob('Content/Plan.JSON', 'content/*.json', cs));
  const defaultCi = process.platform === 'win32';
  assert.equal(matchGlob('A.MD', '*.md'), defaultCi);
});

test('classes, braces, special characters, backslashes and ./', () => {
  assert.ok(matchGlob('slide3.png', 'slide[0-9].png', cs));
  assert.ok(!matchGlob('slideX.png', 'slide[0-9].png', cs));
  assert.ok(matchGlob('slideX.png', 'slide[!0-9].png', cs));
  assert.ok(!matchGlob('a/b', 'a[!x]b', cs), 'a negated class never matches /');
  assert.ok(matchGlob('x.md', '*.{md,json}', cs));
  assert.ok(matchGlob('x.json', '*.{md,json}', cs));
  assert.ok(!matchGlob('x.txt', '*.{md,json}', cs));
  assert.ok(matchGlob('a/b/c.md', '{a/b,z}/*.{md,{t,j}s}', cs));
  assert.ok(matchGlob('a/b/c.ts', '{a/b,z}/*.{md,{t,j}s}', cs));
  assert.ok(matchGlob('a+b(1).md', 'a+b(1).md', cs));
  assert.ok(matchGlob('post $1^.md', 'post $1^.md', cs));
  assert.ok(matchGlob('content/plan.json', 'content\\*.json', cs));
  assert.ok(matchGlob('./content/plan.json', './content/*.json', cs));
  assert.ok(matchGlob('content\\plan.json', 'content/*.json', cs));
  assert.ok(matchGlob('контент/план.md', 'контент/*.md', cs));
  assert.ok(globToRegExp('a/*.md', cs) instanceof RegExp);
});

test('selectFiles: include any, exclude none, order kept', () => {
  const rels = ['content/a.md', 'content/b.json', 'content/FEEDBACK.md', 'assets/logo.png', '.hidden'];
  assert.deepEqual(selectFiles(rels, ['**/*'], ['**/FEEDBACK*'], cs), ['content/a.md', 'content/b.json', 'assets/logo.png', '.hidden']);
  assert.deepEqual(selectFiles(rels, ['content/*.md', 'assets/**'], [], cs), ['content/a.md', 'content/FEEDBACK.md', 'assets/logo.png']);
  assert.deepEqual(selectFiles(rels, undefined, ['content/**'], cs), ['assets/logo.png', '.hidden']);
  assert.deepEqual(selectFiles(rels, [], [], cs), []);
});
