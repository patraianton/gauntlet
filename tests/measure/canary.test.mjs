import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCandidate,
  chooseApproved,
  applyEdits,
  buildKey,
  sealKey,
  revealKey,
  validateFixedKey,
  locate,
} from '../../lib/measure/canary.mjs';
import { loadTaxonomy } from '../../lib/measure/taxonomy.mjs';
import { positionIndex } from '../../lib/material/manifest.mjs';
import { dataPaths } from '../../lib/core/datahome.mjs';
import { hashJson, sha256Hex } from '../../lib/core/hash.mjs';
import { IntegrityError } from '../../lib/core/errors.mjs';
import { validate, loadSchema } from '../../lib/core/schema.mjs';

const tax = loadTaxonomy();
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pl-canary-'));
}

/** A copy with a BOM+CRLF json file and an LF markdown file of known sizes. */
function makeCopy() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  const posts = [];
  for (let i = 1; i <= 30; i++) posts.push(`    { "id": ${i}, "caption": "Post ${i}: a family wagon under 7 000 EUR, ask us for a free selection today." }`);
  const json = '{\r\n  "posts": [\r\n' + posts.join(',\r\n') + '\r\n  ],\r\n  "total": "9 180 + 600 + 210 + 200 = 10 190 EUR"\r\n}\r\n';
  fs.writeFileSync(path.join(dir, 'content', 'plan.json'), Buffer.concat([BOM, Buffer.from(json, 'utf8')]));
  const md = [];
  for (let i = 1; i <= 40; i++) md.push(`Line ${i} of the offer page explains prices, delivery and the request form in plain words.`);
  md[19] = 'Call to action: write ORDER in a direct message and we reply within one working day.';
  md[20] = 'Every price includes delivery to Springfield and packaging; the service fee is shown separately.';
  fs.writeFileSync(path.join(dir, 'content', 'page.md'), md.join('\n') + '\n');
  return dir;
}

const RUN = { canaries: { maxEditChars: 240, minDistanceChars: 400 } };
const slotAt = (band, type = 'FACT-NUM') => ({
  slot: 'S1',
  purpose: 'attention',
  targetLens: 'facts',
  type,
  band,
  range: { start: [0, 1 / 3], middle: [1 / 3, 2 / 3], end: [2 / 3, 1] }[band],
  severityFloor: 'major',
});

test('valid candidate: unique before, in band, json still parses', () => {
  const dir = makeCopy();
  try {
    const pi = positionIndex(dir);
    const c = { slot: 'S1', alt: 1, file: 'content/plan.json', locator: 'total', before: '= 10 190 EUR', after: '= 10 290 EUR' };
    // plan.json comes first in path order? page.md < plan.json, so plan.json is the end of the text.
    const band = pi.offsetOf('content/plan.json', 0) > 0.5 ? 'end' : 'start';
    const r = validateCandidate(c, { copyDir: dir, slot: slotAt(band), run: RUN, positionIndex: pi, taxonomy: tax });
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok && Number.isInteger(r.index) && typeof r.positionFraction === 'number');
    const wrong = validateCandidate(c, { copyDir: dir, slot: slotAt('middle'), run: RUN, positionIndex: pi, taxonomy: tax });
    assert.ok(wrong.errors.some((e) => e.startsWith('outside-band')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code checks: exactly once, sizes, omission length, distance, json, giveaway, trace, file', () => {
  const dir = makeCopy();
  try {
    const opts = { copyDir: dir, slot: null, run: RUN, taxonomy: tax };
    const v = (c, o = {}) => validateCandidate({ slot: 'S1', alt: 1, file: 'content/page.md', ...c }, { ...opts, ...o }).errors.join(' | ');
    assert.match(v({ before: 'of the offer page', after: 'of the offer pages' }), /before-not-unique/);
    assert.match(v({ before: 'not in the file at all', after: 'x' }), /before-not-found/);
    assert.match(v({ before: 'write ORDER', after: 'write ORDER' }), /after-equals-before/);
    assert.match(v({ before: 'ab', after: 'abc' }), /before-too-short/);
    assert.match(v({ before: 'write ORDER', after: 'x'.repeat(241) }), /after-too-long/);
    assert.match(
      v({ before: 'Every price includes delivery to Springfield and packaging;', after: 'Every price includes delivery to Springfield;' }, { slot: { ...slotAt('middle', 'OMIT-CAVEAT'), range: [0, 1] } }),
      /omission-not-shorter/,
    );
    assert.doesNotMatch(
      v({ before: 'Every price includes delivery to Springfield and packaging; the service fee', after: 'Every price includes the service fee' }, { slot: { ...slotAt('middle', 'OMIT-CAVEAT'), range: [0, 1] } }),
      /omission-not-shorter/,
    );
    assert.match(v({ before: 'write ORDER in a direct', after: 'write ORDER [in] a direct' }), /giveaway: adds "\["/);
    assert.match(v({ before: 'write ORDER in a direct', after: 'write ORDER TODO a direct' }), /giveaway: adds "TODO"/);
    assert.match(v({ before: 'write ORDER in a direct', after: 'write ORDER, rated 9,5 by reviewers, in a direct' }), /trace-in-after/);
    assert.match(v({ before: 'write ORDER', after: 'write ORDRE' }, { otherEdits: [{ file: 'content/page.md', before: 'Every price includes delivery' }] }), /too-close/);
    assert.match(validateCandidate({ slot: 'S1', alt: 1, file: '../escape.md', before: 'abc', after: 'abd' }, opts).errors.join(), /file-path-unsafe/);
    assert.match(validateCandidate({ slot: 'S1', alt: 1, file: 'content/none.md', before: 'abc', after: 'abd' }, opts).errors.join(), /file-missing/);
    assert.match(
      validateCandidate({ slot: 'S1', alt: 1, file: 'content/plan.json', before: '"total": "9 180', after: '"total: "9 180' }, opts).errors.join(),
      /json-broken/,
    );
    assert.match(v({ before: 'write ORDER', after: 'write ORDRE' }, { slot: { ...slotAt('start'), slot: 'S2' } }), /slot-mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VISUAL needs visualAllowed and a rebuild source file', () => {
  const dir = makeCopy();
  try {
    const slot = { ...slotAt('start', 'VISUAL'), range: [0, 1] };
    const c = { slot: 'S1', alt: 1, file: 'content/page.md', before: 'write ORDER', after: 'write ORDRE' };
    const off = validateCandidate(c, { copyDir: dir, slot, run: RUN, taxonomy: tax }).errors.join();
    assert.match(off, /visual-not-allowed/);
    assert.match(off, /visual-not-rebuild-source/);
    const on = validateCandidate(c, { copyDir: dir, slot, run: { canaries: { visualAllowed: true }, rebuild: { sourcesGlob: ['content/*.md'] } }, taxonomy: tax });
    assert.deepEqual(on.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF-aware search and BOM/EOL-preserving application', () => {
  const dir = makeCopy();
  try {
    const file = path.join(dir, 'content', 'plan.json');
    const raw0 = fs.readFileSync(file);
    const text0 = raw0.subarray(3).toString('utf8');
    // a multi-line before written with LF matches the CRLF file
    const lfBefore = '  ],\n  "total": "9 180';
    assert.equal(locate(text0, lfBefore).indexes.length, 1);
    const approved = [
      { slot: 'S1', alt: 1, file: 'content/plan.json', before: lfBefore, after: '  ],\n  "total": "9 280' },
      { slot: 'S2', alt: 2, file: 'content/page.md', before: 'write ORDER in a direct', after: 'write ORDRE in a direct' },
    ];
    const { applied } = applyEdits(dir, approved, { positionIndex: positionIndex(dir) });
    assert.deepEqual(applied.map((a) => a.slot), ['S1', 'S2']);
    assert.ok(applied.every((a) => typeof a.positionFraction === 'number'));
    const raw1 = fs.readFileSync(file);
    assert.deepEqual([...raw1.subarray(0, 3)], [...BOM], 'BOM kept');
    const text1 = raw1.subarray(3).toString('utf8');
    assert.equal(text1.replace(/\r\n/g, '').length, text0.replace(/\r\n/g, '').length, 'only one character changed');
    assert.ok(text1.includes('  ],\r\n  "total": "9 280'), 'CRLF kept inside the edit');
    assert.equal((text1.match(/\r\n/g) ?? []).length, (text0.match(/\r\n/g) ?? []).length);
    assert.equal((text1.match(/(?<!\r)\n/g) ?? []).length, 0, 'no bare LF introduced');
    JSON.parse(text1);
    const md = fs.readFileSync(path.join(dir, 'content', 'page.md'), 'utf8');
    assert.ok(md.includes('write ORDRE in a direct') && !md.includes('\r'));
    assert.throws(() => applyEdits(dir, [approved[1]]), /occurs 0 times/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseApproved: first candidate passing code and validator, severity floor, distance', () => {
  const slots = [
    { slot: 'S1', severityFloor: 'major' },
    { slot: 'S2', severityFloor: 'blocker' },
    { slot: 'S3', severityFloor: 'major' },
  ];
  const cands = [
    { slot: 'S1', alt: 1, file: 'a.md', before: 'one', after: 'two' },
    { slot: 'S1', alt: 2, file: 'a.md', before: 'three', after: 'four' },
    { slot: 'S2', alt: 1, file: 'b.md', before: 'five', after: 'six' },
    { slot: 'S3', alt: 1, file: 'a.md', before: 'seven', after: 'eight' },
    { slot: 'S3', alt: 2, file: 'c.md', before: 'nine', after: 'ten' },
  ];
  const good = (slot, alt, severity = 'major', extra = {}) => ({ slot, alt, originalCorrect: true, isDefect: true, provable: true, natural: 4, giveaway: false, severity, keep: true, ...extra });
  const verdicts = [good('S1', 1, 'major', { natural: 2 }), good('S1', 2), good('S2', 1, 'major'), good('S3', 1), good('S3', 2)];
  const checks = [
    { slot: 'S1', alt: 1, ok: true, index: 10 },
    { slot: 'S1', alt: 2, ok: true, index: 100, positionFraction: 0.2 },
    { slot: 'S2', alt: 1, ok: true, index: 5 },
    { slot: 'S3', alt: 1, ok: true, index: 300 },
    { slot: 'S3', alt: 2, ok: true, index: 50 },
  ];
  const r = chooseApproved(slots, cands, verdicts, checks, { minDistanceChars: 400 });
  assert.deepEqual(r.approved.map((a) => `${a.slot}#${a.alt}`), ['S1#2', 'S3#2']);
  assert.deepEqual(r.unfilled, ['S2'], 'validator severity below the blocker floor');
  assert.equal(r.approved[0].validatorSeverity, 'major');
  assert.equal(r.approved[0].positionFraction, 0.2);
  const failedCode = chooseApproved(slots.slice(0, 1), cands, verdicts, [{ slot: 'S1', alt: 2, ok: false }]);
  assert.deepEqual(failedCode.unfilled, ['S1']);
});

test('key: commitment = hashJson(key); reveal checks it, deletes on success, keeps on mismatch', () => {
  const home = tmp();
  try {
    const dp = dataPaths(home);
    const slots = [{ slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', band: 'end', severityFloor: 'major' }];
    const applied = [{ slot: 'S1', alt: 1, file: 'content/plan.json', locator: 'total', before: '10 190', after: '10 290', description: 'sum', howProvable: 'add', intendedSeverity: 'blocker', positionFraction: 0.9 }];
    const key = buildKey({ runId: '20261006-0930-a1b2c3', round: 1, seedHex: 'ab'.repeat(16), applied, slots, validator: { verdicts: [{ slot: 'S1', alt: 1, severity: 'major' }] } });
    assert.equal(key.canaries[0].canary, 'C1');
    assert.equal(key.canaries[0].validatorSeverity, 'major');
    assert.equal(key.canaries[0].band, 'end');
    assert.equal(key.canaries[0].prePlanted, false);
    const sv = validate(loadSchema('canary-key'), key);
    assert.ok(sv.ok, JSON.stringify(sv.errors));
    const { path: p, commitment } = sealKey(dp, key.runId, 1, key);
    assert.equal(commitment, hashJson(key));
    assert.ok(p.startsWith(path.join(home, 'sealed')));
    assert.equal(path.basename(p), '01.key.json');
    const back = revealKey(dp, key.runId, 1, commitment);
    assert.deepEqual(back, key);
    assert.equal(fs.existsSync(p), false, 'sealed file deleted at reveal');

    sealKey(dp, key.runId, 2, key);
    const tampered = JSON.parse(fs.readFileSync(dp.sealedKey(key.runId, '02'), 'utf8'));
    tampered.canaries[0].after = '10 190';
    fs.writeFileSync(dp.sealedKey(key.runId, '02'), JSON.stringify(tampered));
    assert.throws(
      () => revealKey(dp, key.runId, 2, commitment),
      (e) => e instanceof IntegrityError && e.code === 'COMMITMENT_MISMATCH',
    );
    assert.ok(fs.existsSync(dp.sealedKey(key.runId, '02')), 'evidence kept');
    assert.throws(() => revealKey(dp, key.runId, 3, commitment), (e) => e.code === 'COMMITMENT_MISMATCH');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('validateFixedKey: prePlanted needs every after exactly once; not prePlanted needs before', () => {
  const dir = makeCopy();
  try {
    const key = {
      schemaVersion: 1,
      canaries: [{ canary: 'C1', slot: 'S1', purpose: 'attention', targetLens: 'facts', type: 'FACT-NUM', file: 'content/page.md', before: 'write ORDER in', after: 'write ORDRE in', prePlanted: true }],
    };
    assert.match(validateFixedKey(key, dir, { prePlanted: true }).errors.join(), /occurs 0 times/);
    const k2 = { ...key, canaries: [{ ...key.canaries[0], prePlanted: false }] };
    assert.deepEqual(validateFixedKey(k2, dir, { prePlanted: false }).errors, []);
    const k3 = { ...key, canaries: [{ ...key.canaries[0], after: 'of the offer page', before: 'x of the offer page' }] };
    assert.match(validateFixedKey(k3, dir, { prePlanted: true }).errors.join(), /occurs 38 times/);
    assert.match(validateFixedKey({ schemaVersion: 1, canaries: [{ ...key.canaries[0], type: 'NOPE' }] }, dir).errors.join(), /unknown type/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MATERIAL_BLIND = process.env.GAUNTLET_BENCH_MATERIAL ?? fileURLToPath(new URL('../../bench/material/bakery', import.meta.url)); // the shipped synthetic bench material; GAUNTLET_BENCH_MATERIAL points at another copy

test('bench key: five canaries, every after copied exactly from the bakery bench material (read-only)', { skip: !fs.existsSync(MATERIAL_BLIND) && 'the bench material is not on this machine' }, () => {
  const key = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'bakery.key.json'), 'utf8'));
  assert.equal(key.canaries.length, 5);
  assert.deepEqual(key.canaries.map((c) => c.targetLens), ['risk', 'copy', 'conversion', 'growth', 'design']);
  assert.ok(key.canaries.every((c) => c.prePlanted === true && c.purpose === 'attention'));
  const sv = validate(loadSchema('canary-key'), key);
  assert.ok(sv.ok, JSON.stringify(sv.errors));
  const mtimes = key.canaries.map((c) => fs.statSync(path.join(MATERIAL_BLIND, ...c.file.split('/'))).mtimeMs);
  const r = validateFixedKey(key, MATERIAL_BLIND, { prePlanted: true });
  assert.deepEqual(r.errors, []);
  for (const c of key.canaries.filter((x) => !x.after.startsWith('sha256:'))) {
    const text = fs.readFileSync(path.join(MATERIAL_BLIND, ...c.file.split('/')), 'utf8');
    assert.equal(text.split(c.after).length - 1, 1, `${c.canary} after occurs exactly once`);
    assert.equal(text.includes(c.before), false, `${c.canary} before is not in the planted copy`);
  }
  const png = key.canaries.find((c) => c.type === 'VISUAL');
  assert.equal(png.after, 'sha256:' + sha256Hex(fs.readFileSync(path.join(MATERIAL_BLIND, 'render', 'out', 'B3.png'))));
  assert.deepEqual(key.canaries.map((c) => fs.statSync(path.join(MATERIAL_BLIND, ...c.file.split('/'))).mtimeMs), mtimes, 'nothing written');
});
