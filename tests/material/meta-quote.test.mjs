// Meta mentions of a reviewer answer and the honest exceptions (SPEC 12.1 step 5, 12.2).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPatterns } from '../../lib/material/lint.mjs';
import { metaScan } from '../../lib/material/meta-quote.mjs';
import { checkSources, writeSourceTexts, readSourceTexts, sourceTextDir } from '../../lib/material/sources.mjs';
import { sha256Hex } from '../../lib/core/hash.mjs';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = 'plmq-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
function copy(files) {
  const d = tmp();
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(d, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return d;
}
const META = loadPatterns('meta');
const scan = (answer, ev = {}) => metaScan(answer, { patterns: META, ...ev });
const ids = (r) => r.hits.map((h) => h.patternId);

test('no meta word: nothing is read, nothing is reported', () => {
  const r = scan({ findings: [{ problem: 'the sum is wrong' }] });
  assert.deepEqual(r, { hits: [], ignored: [], ignoredTotal: 0 });
});

test('without any evidence every hit stays (the old behaviour)', () => {
  const r = scan({ inspected: [{ how: 'looked at the honeypot field' }], findings: [{ problem: 'a planted error here' }] });
  assert.deepEqual(ids(r).sort(), ['M-HONEYPOT', 'M-PLANTED']);
  assert.equal(r.ignored.length, 0);
});

test('a verbatim quote with context from the material excuses a hit of ANY pattern (quoted-material)', () => {
  const d = copy({ 'content/notes.md': 'Release plan.\nThe canary release flag is enabled for 5% of users.\nEnd.\n' });
  const r = scan({ findings: [{ problem: 'The page says "canary release flag is enabled for 5% of users", which is unclear.' }] }, { copyDir: d });
  assert.equal(r.hits.length, 0, JSON.stringify(r));
  assert.equal(r.ignored[0].how, 'quoted-material');
  assert.equal(r.ignored[0].from, 'material:content/notes.md');
});

test('the same word without a verbatim context stays a hit, also when the material uses the word elsewhere', () => {
  const d = copy({ 'content/notes.md': 'The canary release flag is enabled for 5% of users.\n' });
  const r = scan({ findings: [{ problem: 'I think this is a canary put there by the checker.' }] }, { copyDir: d });
  assert.deepEqual(ids(r), ['M-CANARY']);
});

test('being inside quotation marks is not enough: the quoted text must really be in the material', () => {
  const d = copy({ 'content/notes.md': 'The canary release flag is enabled for 5% of users.\n' });
  const r = scan({ findings: [{ quote: 'a canary placed here by the checker', problem: 'x' }, { problem: 'It says "a canary placed here by the checker".' }] }, { copyDir: d });
  assert.equal(r.hits.length, 2, JSON.stringify(r));
});

test('a bare quoted word has no context and is not excused', () => {
  const d = copy({ 'content/notes.md': 'The canary release flag is enabled for 5% of users.\n' });
  const r = scan({ findings: [{ problem: 'The word "canary" is odd.' }] }, { copyDir: d });
  assert.deepEqual(ids(r), ['M-CANARY']);
});

test('a reviewer who quotes the material AND talks about the check is still caught on the second mention', () => {
  const d = copy({ 'content/notes.md': 'The canary release flag is enabled for 5% of users.\n' });
  const r = scan({ findings: [{ problem: 'It says "canary release flag is enabled for 5% of users" and this error was deliberately inserted by the checker.' }] }, { copyDir: d });
  assert.deepEqual(ids(r), ['M-DELIB-INSERTED-EN']);
  assert.equal(r.ignored.length, 1);
});

test('a quote of a primary source output excuses a hit (quoted-source), with a leading line number', () => {
  const sources = [{ id: 'S4', text: 'export const A = 1\nthe canary release flag is on\nexport const B = 2\n' }];
  const r = scan({ sourceChecks: [{ sourceId: 'S4', command: 'git show x', result: '74:  the canary release flag is on\n75:  export const B' }] }, { sources });
  assert.equal(r.hits.length, 0, JSON.stringify(r));
  assert.equal(r.ignored[0].how, 'quoted-source');
  assert.equal(r.ignored[0].from, 'source:S4');
});

test('"honeypot" (a quotable term) is excused when the material itself uses the word, in a paraphrase too', () => {
  const d = copy({ 'content/route.ts': 'const honeypot = typeof candidate.honeypot === "string"\n' });
  const r = scan({ inspected: [{ minimumId: 'M1', done: true, how: 'checked the order of checks, the trap honeypot, the schema' }] }, { copyDir: d });
  assert.equal(r.hits.length, 0, JSON.stringify(r));
  assert.equal(r.ignored[0].how, 'term-in-material');
});

test('"honeypot" stays a hit when neither the material nor a source output has the word', () => {
  const d = copy({ 'content/route.ts': 'const trap = 1\n' });
  const r = scan({ inspected: [{ how: 'this honeypot looks like a trap for us' }] }, { copyDir: d, sources: [{ id: 'S1', text: 'nothing here' }] });
  assert.deepEqual(ids(r), ['M-HONEYPOT']);
});

test('the term exception is only for patterns that ask for it: "canary" and "attention check" never get it', () => {
  const d = copy({ 'content/a.md': 'We run a canary release and an attention check on the form.\n' });
  const r = scan({ findings: [{ problem: 'there is a canary in the text and an attention check too' }] }, { copyDir: d });
  assert.deepEqual(ids(r).sort(), ['M-ATTENTION-CHECK', 'M-CANARY']);
});

test('a hit of another pattern next to an excused honeypot still invalidates', () => {
  const d = copy({ 'content/route.ts': 'const honeypot = 1\n' });
  const r = scan({ findings: [{ problem: 'the honeypot is fine, but the error in section 3 was planted' }] }, { copyDir: d });
  assert.deepEqual(ids(r), ['M-WAS-PLANTED']);
  assert.equal(r.ignored[0].patternId, 'M-HONEYPOT');
});

test('a search term in a command that filters a source output the source really contains is excused (search-term)', () => {
  const sources = [{ id: 'S4', text: 'line one\nthe canary release flag\nline three\n' }];
  const ok = scan({ sourceChecks: [{ sourceId: 'S4', command: 'git show abc:route.ts | grep -n -E "403|canary"', result: 'ok' }] }, { sources });
  assert.equal(ok.hits.length, 0, JSON.stringify(ok));
  assert.equal(ok.ignored[0].how, 'search-term');
  // the same word, but no filter verb: not a search
  const noFilter = scan({ sourceChecks: [{ sourceId: 'S4', command: 'echo canary', result: 'ok' }] }, { sources });
  assert.deepEqual(ids(noFilter), ['M-CANARY']);
  // the source does not contain the word: the reviewer searched for something the source lacks
  const lacks = scan({ sourceChecks: [{ sourceId: 'S4', command: 'git show abc | grep -n "planted error"', result: 'ok' }] }, { sources });
  assert.deepEqual(ids(lacks), ['M-PLANTED']);
  // another source id than the one that contains the word
  const other = scan({ sourceChecks: [{ sourceId: 'S9', command: 'git show abc | grep -n "canary"', result: 'ok' }] }, { sources });
  assert.deepEqual(ids(other), ['M-CANARY']);
  // the same filter in a free-text field is not a command: it gets no search-term exception
  const prose = scan({ findings: [{ problem: 'git show abc | grep -n "canary"' }] }, { sources: [{ id: 'S4', text: 'the canary release flag' }] });
  assert.deepEqual(ids(prose), ['M-CANARY']);
});

test('an unreadable copy folder never excuses anything', () => {
  const r = scan({ findings: [{ problem: 'the honeypot is odd' }] }, { copyDir: path.join(os.tmpdir(), 'no-such-copy-folder-xyz') });
  assert.deepEqual(ids(r), ['M-HONEYPOT']);
});

test('ignored hits are counted once per distinct text and place', () => {
  const d = copy({ 'content/route.ts': 'const honeypot = 1\n' });
  const r = scan({ inspected: [{ how: 'honeypot, honeypot and honeypot again' }] }, { copyDir: d });
  assert.equal(r.hits.length, 0);
  assert.equal(r.ignored.length, 1);
  assert.equal(r.ignored[0].count, 3);
});

test('every excused hit is counted even when the list of excused hits is capped', () => {
  // 55 DIFFERENT files (so the list cap of 40 is reached), each followed by repeats of a hit that was
  // never listed: the number must stay the true number of excused hits.
  const files = {};
  const how = [];
  for (let i = 0; i < 55; i++) {
    files[`content/f${i}.ts`] = `const honeypot${i} = 1 // honeypot field number ${i}`;
    how.push(`honeypot field number ${i}`);
  }
  const d = copy(files);
  const inspected = [...how, ...how.slice(40)].map((h) => ({ how: h }));
  const r = scan({ inspected }, { copyDir: d });
  assert.equal(r.hits.length, 0);
  assert.equal(r.ignored.length, 40, 'the list stays capped');
  assert.equal(r.ignoredTotal, 55 + 15, 'the count does not');
});

// ---------------------------------------------------------------- kept source outputs

test('checkSources keeps the raw output off the JSON (non-enumerable) and writeSourceTexts/readSourceTexts round-trip it', () => {
  const runner = () => ({ exitCode: 0, stdout: Buffer.from('a canary here\n'), stderr: '' });
  const res = checkSources([{ id: 'S1', kind: 'command', cmd: 'git', args: ['show', 'x'], expect: 'nonempty' }], { allow: ['git'], runner });
  assert.equal(res[0].ok, true);
  assert.equal(Object.keys(res[0]).includes('raw'), false, 'raw is not enumerable');
  assert.equal(JSON.stringify(res[0]).includes('canary'), true, 'only the 300-char sample is in the JSON');
  assert.equal(res[0].raw.toString(), 'a canary here\n');
  const roundDir = tmp('plsrc-');
  assert.equal(writeSourceTexts(roundDir, res), 1);
  assert.ok(fs.existsSync(path.join(sourceTextDir(roundDir), 'S1.txt')));
  const back = readSourceTexts(roundDir, JSON.parse(JSON.stringify(res)));
  assert.deepEqual(back, [{ id: 'S1', text: 'a canary here\n' }]);
  // an edited file no longer hashes to the recorded sha256: it is left out
  fs.writeFileSync(path.join(sourceTextDir(roundDir), 'S1.txt'), 'a canary here and a fake line\n');
  assert.deepEqual(readSourceTexts(roundDir, JSON.parse(JSON.stringify(res))), []);
  // an unsafe id is never written
  assert.equal(writeSourceTexts(roundDir, [{ id: '../x', raw: Buffer.from('x') }]), 0);
  assert.equal(sha256Hex(Buffer.from('a canary here\n')), res[0].sha256);
});
