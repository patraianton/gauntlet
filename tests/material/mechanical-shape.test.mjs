// Shape check of mechanical.json before freeze (bug 13, a night run):
// file-exists checks written with "glob" instead of "path" were frozen and failed only in round 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mechanicalProblems, mechanicalRefusal, unrunnableCheckIds, mechanicalNarrowing } from '../../lib/material/mechanical-shape.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';
import { runMechanical } from '../../lib/material/mechanical.mjs';
import { tmpDir, put } from '../fixtures/material/helpers.mjs';

const FILES = ['work/PRODUCT.md', 'work/targets-upsell.csv', 'work/notes/plan.json', 'work/notes/two.json', 'work/page.html'].map((rel) => ({ rel, abs: null }));
const ALLOW = ['node', 'git'];
const mech = (...checks) => ({ schemaVersion: 1, checks });
const base = { what: 'a check', severity: 'blocker' };
const problems = (m, extra = {}) => mechanicalProblems(m, { files: FILES, allow: ALLOW, schemaErrors: validate(loadSchema('mechanical'), m).errors, ...extra });
const one = (check, extra) => problems(mech({ id: 'K1', ...base, ...check }), extra);

test('the exact K1/K2 shape of that night run: file-exists with "glob" is refused, naming the id and the fix', () => {
  const m = mech(
    { id: 'K1', what: 'the product description exists', severity: 'blocker', kind: 'file-exists', glob: 'work/PRODUCT.md' },
    { id: 'K2', what: 'the target list exists', severity: 'blocker', kind: 'file-exists', glob: 'work/targets-upsell.csv' },
    { id: 'K3', what: 'no leftover placeholders', severity: 'major', kind: 'no-forbidden-text', glob: 'work/**/*.md', patterns: ['TODO'] },
  );
  // the schema alone accepts this file: that is the bug
  assert.equal(validate(loadSchema('mechanical'), m).ok, true);
  const out = problems(m);
  assert.equal(out.length, 2, out.join('\n'));
  assert.match(out[0], /^K1: kind "file-exists" has the field "glob", which belongs to "json-valid" \/ "count" \/ "no-forbidden-text" checks\. Fix: rename "glob" to "path" \(use "path": "work\/PRODUCT\.md"\)\./);
  assert.match(out[1], /^K2: .*use "path": "work\/targets-upsell\.csv"/);
  assert.match(mechanicalRefusal(out), /K1: .*\n {2}K2: /);
});

test('file-exists with a wildcard in "glob" points to a count check instead of a wrong rename', () => {
  const out = one({ kind: 'file-exists', glob: 'work/*.md' });
  assert.equal(out.length, 1);
  assert.match(out[0], /use kind "count" with "glob": "work\/\*\.md", "op": ">=", "value": 1/);
});

test('a sound file gives no problems (every kind)', () => {
  const m = mech(
    { id: 'K1', ...base, kind: 'file-exists', path: 'work/PRODUCT.md' },
    { id: 'K2', ...base, kind: 'json-valid', glob: 'work/notes/*.json' },
    { id: 'K3', ...base, kind: 'json-valid' },
    { id: 'K4', ...base, kind: 'count', glob: 'work/*.md', op: '>=', value: 1 },
    { id: 'K5', ...base, kind: 'no-forbidden-text', glob: 'work/**/*.md', patterns: ['TODO', '\\{\\{'] },
    { id: 'K6', ...base, kind: 'command', cmd: 'node', args: ['--version'] },
  );
  assert.deepEqual(problems(m), []);
});

test('unknown kind, a missing kind and "type" instead of "kind"', () => {
  assert.match(one({ kind: 'regex-match' })[0], /^K1: "kind" "regex-match" is not a known kind\. Fix: set "kind" to one of json-valid, count, file-exists, no-forbidden-text, command\./);
  const missing = problems(mech({ id: 'K1', ...base }));
  assert.match(missing[0], /^K1: "kind" is missing/);
  const typed = problems(mech({ id: 'K1', ...base, type: 'file-exists', path: 'work/PRODUCT.md' }));
  assert.equal(typed.length, 1, typed.join('\n'));
  assert.match(typed[0], /^K1: has "type" "file-exists", but the field is called "kind"\. Fix: rename "type" to "kind"/);
});

test('a required field is missing for every kind', () => {
  assert.match(one({ kind: 'file-exists' })[0], /^K1: kind "file-exists" needs the field "path"/);
  assert.match(one({ kind: 'count', glob: 'work/*.md' })[0], /^K1: kind "count" needs the field "value" \(a number\)/);
  assert.match(one({ kind: 'count', value: 1 })[0], /^K1: kind "count" needs the field "glob"/);
  assert.match(one({ kind: 'no-forbidden-text', glob: 'work/**/*.md' })[0], /^K1: kind "no-forbidden-text" needs the field "patterns"/);
  assert.match(one({ kind: 'command' })[0], /^K1: kind "command" needs the field "cmd"/);
});

test('a field that belongs to another kind, and a field nobody knows', () => {
  assert.match(one({ kind: 'json-valid', patterns: ['x'] })[0], /^K1: kind "json-valid" has the field "patterns", which belongs to "no-forbidden-text" checks\. Fix: delete "patterns" from K1, or change its "kind" to "no-forbidden-text"/);
  assert.match(one({ kind: 'count', glob: 'work/*.md', value: 1, path: 'work/PRODUCT.md' })[0], /has the field "path", which belongs to "file-exists"/);
  assert.match(one({ kind: 'command', cmd: 'node', glob: 'x' })[0], /has the field "glob"/);
  assert.match(one({ kind: 'file-exists', path: 'work/PRODUCT.md', colour: 'red' })[0], /^K1: has an unknown field "colour"\. Fix: delete it \(kind "file-exists" takes: path\)/);
});

test('bad contents: op, value type, pointer, patterns that do not compile, empty patterns', () => {
  assert.match(one({ kind: 'count', glob: 'work/*.md', op: '>', value: 1 })[0], /"op" must be ">=", "=" or "<="/);
  assert.match(one({ kind: 'count', glob: 'work/*.md', value: '12' })[0], /"value" must be a number/);
  assert.match(one({ kind: 'count', glob: 'work/notes/*.json', pointer: 'posts', value: 1 })[0], /"pointer" must be a JSON pointer starting with "\/"/);
  const re = one({ kind: 'no-forbidden-text', glob: 'work/**/*.md', patterns: ['ok', '{{', '(open'] });
  assert.equal(re.length, 2, re.join('\n'));
  assert.match(re[0], /^K1: patterns\[1\] "\{\{" is not a valid regular expression/);
  assert.match(re[1], /^K1: patterns\[2\] "\(open" is not a valid regular expression/);
  assert.match(one({ kind: 'no-forbidden-text', patterns: [] })[0], /"patterns" must be a non-empty list/);
});

test('file-exists path: absolute, "..", a pattern, a folder, a missing file, a wrong root, a similar file elsewhere', () => {
  assert.match(one({ kind: 'file-exists', path: 'C:\\Users\\x\\PRODUCT.md' })[0], /must be relative to the material/);
  assert.match(one({ kind: 'file-exists', path: '../PRODUCT.md' })[0], /must be relative to the material/);
  assert.match(one({ kind: 'file-exists', path: 'work/*.md' })[0], /names ONE exact file/);
  assert.match(one({ kind: 'file-exists', path: 'work/notes' })[0], /is not a file in the material \(5 files\)\. It is a folder; name a file in it\./);
  const wrongRoot = one({ kind: 'file-exists', path: 'PRODUCT.md' });
  assert.match(wrongRoot[0], /"PRODUCT\.md" is not a material root name: paths start with the root name \(work\)/);
  assert.match(wrongRoot[0], /Did you mean: work\/PRODUCT\.md\?/);
  assert.match(one({ kind: 'file-exists', path: 'work/MISSING.md' })[0], /^K1: file-exists path "work\/MISSING\.md" is not a file in the material/);
  assert.deepEqual(one({ kind: 'file-exists', path: 'work\\PRODUCT.md' }), [], 'backslashes are normalised like at runtime');
});

test('a glob that matches nothing is refused: json-valid, no-forbidden-text (text files only), count', () => {
  assert.match(one({ kind: 'json-valid', glob: 'docs/**/*.json' })[0], /json-valid glob "docs\/\*\*\/\*\.json" matches no file in the material \(5 files\)\. "docs" is not a material root name/);
  assert.deepEqual(one({ kind: 'json-valid' }), [], 'the default glob finds the .json files');
  const noJson = one({ kind: 'json-valid' }, { files: FILES.filter((f) => !f.rel.endsWith('.json')) });
  assert.match(noJson[0], /json-valid glob "\*\*\/\*\.json" \(the default\) matches no file/);
  assert.match(one({ kind: 'no-forbidden-text', glob: 'work/*.png', patterns: ['x'] })[0], /no-forbidden-text glob "work\/\*\.png" matches no text file/);
  assert.match(one({ kind: 'count', glob: 'work/*.pdf', op: '>=', value: 1 })[0], /count glob "work\/\*\.pdf" matches no file in the material \(5 files\), so the count is 0 and ">= 1" can never hold/);
  assert.match(one({ kind: 'count', glob: 'work/*.pdf', value: 3 })[0], /"= 3" can never hold/);
});

test('a count that expects zero or at most N may match nothing: that is a real "none of these" check', () => {
  assert.deepEqual(one({ kind: 'count', glob: 'work/*.pdf', value: 0 }), []);
  assert.deepEqual(one({ kind: 'count', glob: 'work/*.pdf', op: '<=', value: 2 }), []);
  assert.deepEqual(one({ kind: 'count', glob: 'work/*.pdf', op: '>=', value: 0 }), []);
});

test('a count pointer that gives a list in none of the matched files is refused', () => {
  const dir = tmpDir();
  const files = [{ rel: 'work/a.json', abs: put(dir, 'a.json', '{"posts":[1,2,3]}') }, { rel: 'work/b.json', abs: put(dir, 'b.json', '{"other":1}') }];
  assert.deepEqual(one({ kind: 'count', glob: 'work/*.json', pointer: '/posts', value: 3 }, { files }), []);
  const out = one({ kind: 'count', glob: 'work/*.json', pointer: '/typo', value: 3 }, { files });
  assert.match(out[0], /count pointer "\/typo" does not give a list in any of the 2 file\(s\) matched by "work\/\*\.json"/);
});

test('command: a program outside the allowlist, or given with a folder, is refused; args must be texts', () => {
  assert.match(one({ kind: 'command', cmd: 'powershell', args: [] })[0], /^K1: command "powershell" is refused: it is not in run\.json "allowExecutables" \(node, git\)\. Fix: use an allowed program, or add its name to allowExecutables/);
  assert.match(one({ kind: 'command', cmd: 'C:\\tools\\node.exe' })[0], /a program must be given by name only/);
  assert.match(one({ kind: 'command', cmd: 'node', args: [1] })[0], /"args" must be a list of texts/);
  assert.deepEqual(one({ kind: 'command', cmd: 'NODE.exe' }), [], 'same rule as for sources');
  assert.deepEqual(one({ kind: 'command', cmd: 'anything' }, { allow: null }), [], 'no allowlist given: not judged');
});

test('id, what, severity and duplicate ids', () => {
  assert.match(problems(mech({ id: 'check1', what: 'x', severity: 'blocker', kind: 'file-exists', path: 'work/PRODUCT.md' }))[0], /^check1: "id" must be K followed by one or two digits/);
  assert.match(problems(mech({ id: 'K1', what: '', severity: 'blocker', kind: 'file-exists', path: 'work/PRODUCT.md' }))[0], /"what" is missing or empty/);
  assert.match(problems(mech({ id: 'K1', what: 'x', severity: 'high', kind: 'file-exists', path: 'work/PRODUCT.md' }))[0], /"severity" must be blocker, major or cosmetic \(got "high"\)/);
  const dup = problems(mech({ id: 'K1', ...base, kind: 'file-exists', path: 'work/PRODUCT.md' }, { id: 'K1', ...base, kind: 'file-exists', path: 'work/page.html' }));
  assert.equal(dup.length, 1);
  assert.match(dup[0], /^K1: the id is used twice \(checks\[0\] and checks\[1\]\)/);
});

test('the top level: not an object, no checks list, wrong schemaVersion (schema text is kept)', () => {
  assert.match(mechanicalProblems([])[0], /must be an object/);
  assert.match(mechanicalProblems({ schemaVersion: 1 })[0], /"checks" must be a list/);
  const out = problems({ schemaVersion: 2, checks: [] });
  assert.equal(out.length, 1);
  assert.match(out[0], /schemaVersion: must equal 1/);
});

test('schema errors of a check that the shape check does not cover are kept (wrong text type)', () => {
  // "what" is a number: the shape check names it itself; "patterns" item type is covered by the shape check too.
  const m = mech({ id: 'K1', ...base, kind: 'file-exists', path: 'work/PRODUCT.md', what: 7 });
  const out = problems(m);
  assert.ok(out.some((l) => /^K1: "what" is missing or empty/.test(l)), out.join('\n'));
});

test('without the material (files omitted) the "matches nothing" tests are skipped, the shape tests still run', () => {
  assert.deepEqual(one({ kind: 'file-exists', path: 'nowhere/at-all.md' }, { files: null }), []);
  assert.match(one({ kind: 'file-exists', glob: 'x.md' }, { files: null })[0], /rename "glob" to "path"/);
});

test('amend: a check kept as frozen is not judged against the material (skipMaterial)', () => {
  const m = mech({ id: 'K1', ...base, kind: 'file-exists', path: 'work/GONE.md' });
  assert.equal(problems(m).length, 1);
  assert.deepEqual(problems(m, { skipMaterial: new Set(['K1']) }), []);
});

test('the runtime still fails closed on a malformed check that bypassed the freeze check', () => {
  const dir = tmpDir();
  put(dir, 'work/PRODUCT.md', 'x');
  const [r] = runMechanical(mech({ id: 'K1', ...base, kind: 'file-exists', glob: 'work/PRODUCT.md' }), dir, { allow: [] });
  assert.equal(r.ok, false);
  assert.match(r.details[0], /file-exists check needs a path/);
});

test('unrunnableCheckIds names the checks that could never run, whatever the material (A5)', () => {
  const m = mech(
    { id: 'K1', what: 'a', severity: 'blocker', kind: 'file-exists', glob: 'work/PRODUCT.md' },
    { id: 'K2', what: 'b', severity: 'blocker', kind: 'json-valid', glob: 'no/such/**/*.json' },
    { id: 'K3', what: 'c', severity: 'major', kind: 'command', cmd: 'rm' },
  );
  assert.deepEqual(unrunnableCheckIds(m, { allow: ALLOW }), ['K1', 'K3']);
  assert.deepEqual(unrunnableCheckIds(m, { allow: null }), ['K1'], 'without an allowlist only the shape is judged');
  assert.deepEqual(unrunnableCheckIds(null), []);
  assert.deepEqual(unrunnableCheckIds({ checks: [null, 5, { what: 'no id' }] }), []);
});

test('amend narrowing: a check that never ran may be replaced by a sound one of the same or higher severity, nothing else (A5)', () => {
  const broken = { id: 'K1', what: 'a', severity: 'major', kind: 'file-exists', glob: 'work/PRODUCT.md' };
  const fine = { id: 'K2', what: 'b', severity: 'blocker', kind: 'json-valid' };
  const old = mech(broken, fine);
  const sound = { id: 'K1', what: 'a', severity: 'major', kind: 'file-exists', path: 'work/PRODUCT.md' };
  assert.deepEqual(mechanicalNarrowing(old, mech(sound, fine), { allow: ALLOW }), [], 'repair without owner words');
  assert.deepEqual(mechanicalNarrowing(old, mech({ ...sound, severity: 'blocker' }, fine), { allow: ALLOW }), [], 'a higher severity is fine');
  assert.deepEqual(mechanicalNarrowing(old, mech({ ...sound, severity: 'cosmetic' }, fine), { allow: ALLOW }), ['mechanical check K1 removed or changed'], 'lowering the severity is narrowing');
  assert.deepEqual(mechanicalNarrowing(old, mech(fine), { allow: ALLOW }), ['mechanical check K1 removed or changed'], 'deleting it is narrowing');
  // a check that ran is still protected
  assert.deepEqual(mechanicalNarrowing(old, mech(broken, { ...fine, severity: 'cosmetic' }), { allow: ALLOW }), ['mechanical check K2 removed or changed']);
  assert.deepEqual(mechanicalNarrowing(old, mech(broken, fine), { allow: ALLOW }), [], 'unchanged');
  // the broken check kept as it is stays broken and is refused by the shape check, not here
});
