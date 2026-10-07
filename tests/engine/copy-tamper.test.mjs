import test from 'node:test';
import assert from 'node:assert/strict';
import { jobWindows, runningAt, buildTamperRecord, ledgerData, tamperLinesRu, scratchLineRu, MAX_FILES_RECORDED, MAX_FILES_LEDGER, MAX_FILES_TEXT } from '../../lib/engine/copy-tamper.mjs';
import { isoLocal } from '../../lib/core/clock.mjs';
import { loadPhrases, fill } from '../../lib/report/report-ru.mjs';

const T0 = Date.parse('2026-10-06T23:00:00.000Z');
const at = (min) => isoLocal(new Date(T0 + min * 60000));
const jobs = [
  { job: 'aaaaaaa2', role: 'reviewer', lens: 'facts', attempt: 1, issuedAt: at(0), answeredAt: at(10) },
  { job: 'bbbbbbb2', role: 'reviewer', lens: 'language', attempt: 1, issuedAt: at(0), answeredAt: at(40) },
  { job: 'ccccccc2', role: 'reviewer', lens: 'path', attempt: 1, issuedAt: at(0) }, // no answer yet
  { job: 'ddddddd2', role: 'decoy', attempt: 1, issuedAt: at(1), answeredAt: at(5) },
  { job: 'eeeeeee2', role: 'matcher', attempt: 1, issuedAt: at(0), answeredAt: at(1) }, // never works on the copy
];
const titles = { facts: 'Факты', language: 'Язык', path: 'Путь' };

test('jobWindows keeps only the jobs that work on the planted copy and gives lens titles', () => {
  const w = jobWindows(jobs, (id) => titles[id] ?? null);
  assert.deepEqual(w.map((x) => x.job), ['aaaaaaa2', 'bbbbbbb2', 'ccccccc2', 'ddddddd2']);
  assert.equal(w[0].lensTitle, 'Факты');
  assert.equal(w[3].lensTitle, null);
});

test('runningAt: a job is running from its issue time to its answer file time; no answer means still running; before everything means nobody', () => {
  const w = jobWindows(jobs);
  const ids = (min) => runningAt(w, T0 + min * 60000).map((x) => x.job);
  assert.deepEqual(ids(-5), []);
  assert.deepEqual(ids(3), ['aaaaaaa2', 'bbbbbbb2', 'ccccccc2', 'ddddddd2']);
  assert.deepEqual(ids(8), ['aaaaaaa2', 'bbbbbbb2', 'ccccccc2']);
  assert.deepEqual(ids(30), ['bbbbbbb2', 'ccccccc2']);
  assert.deepEqual(ids(300), ['ccccccc2']);
  assert.equal(runningAt(w, null), null, 'no time, no guess');
});

function rec(diff, over = {}) {
  return buildTamperRecord({ round: 3, diff, expectedTreeHash: 'a'.repeat(64), foundTreeHash: 'b'.repeat(64), listingKnown: true, copyMissing: false, windows: jobWindows(jobs, (id) => titles[id] ?? null), detectedAt: at(50), isoLocal, ...over });
}

test('buildTamperRecord: rows with change, sizes, time and running jobs; removed files have no time; scratch is flagged', () => {
  const r = rec({
    added: [{ rel: 'a/__pycache__/x.cpython-312.pyc', bytes: 10, mtimeMs: T0 + 3 * 60000 }, { rel: 'a/helper.py', bytes: 5, mtimeMs: T0 + 30 * 60000 }],
    changed: [{ rel: 'a/page.md', bytesBefore: 100, bytes: 120, mtimeMs: T0 + 8 * 60000 }],
    removed: [{ rel: 'a/old.md', bytesBefore: 7, mtimeMsBefore: T0 }],
  });
  assert.deepEqual(r.counts, { added: 2, changed: 1, removed: 1, total: 4 });
  const by = Object.fromEntries(r.files.map((f) => [f.rel, f]));
  assert.equal(by['a/__pycache__/x.cpython-312.pyc'].scratch, true);
  assert.equal(by['a/helper.py'].scratch, false);
  assert.deepEqual(by['a/helper.py'].runningJobs.map((j) => j.job), ['bbbbbbb2', 'ccccccc2']);
  assert.deepEqual(by['a/page.md'].runningJobs.map((j) => j.job), ['aaaaaaa2', 'bbbbbbb2', 'ccccccc2']);
  assert.equal(by['a/old.md'].runningJobs, null);
  assert.equal(by['a/old.md'].mtime, null);
  assert.equal(by['a/page.md'].mtime, at(8));
  assert.ok(!('mtimeMs' in by['a/page.md']), 'no raw millisecond field next to the ISO time');
  assert.equal(r.jobs.length, 4);
});

test('buildTamperRecord without job windows (before planting): nobody is named', () => {
  const r = rec({ added: [{ rel: 'a/h.py', bytes: 1, mtimeMs: T0 }], changed: [], removed: [] }, { windows: null });
  assert.equal(r.files[0].runningJobs, null);
  assert.deepEqual(r.jobs, []);
});

test('a long list is cut: all counted, MAX_FILES_RECORDED kept in the record, MAX_FILES_LEDGER in the ledger, MAX_FILES_TEXT in the text', () => {
  const added = Array.from({ length: MAX_FILES_RECORDED + 25 }, (_, i) => ({ rel: `d/f${String(i).padStart(4, '0')}.txt`, bytes: i, mtimeMs: T0 }));
  const r = rec({ added, changed: [], removed: [] });
  assert.equal(r.counts.total, MAX_FILES_RECORDED + 25);
  assert.equal(r.files.length, MAX_FILES_RECORDED);
  assert.equal(r.filesRecorded, MAX_FILES_RECORDED);
  const l = ledgerData(r);
  assert.equal(l.files.length, MAX_FILES_LEDGER);
  assert.equal(l.counts.total, MAX_FILES_RECORDED + 25);
  assert.ok(l.files.every((f) => f.runningJobs === null || f.runningJobs.every((j) => typeof j === 'string')), 'the ledger keeps job ids only');
  const lines = tamperLinesRu(r, loadPhrases(), fill, { filesPath: 'C:\\run\\copy-tamper.json' });
  const fileLines = lines.filter((x) => x.startsWith('новый файл:'));
  assert.equal(fileLines.length, MAX_FILES_TEXT);
  assert.ok(lines.some((x) => x === `…и ещё ${MAX_FILES_RECORDED + 25 - MAX_FILES_TEXT} файлов; полный список лежит в файле C:\\run\\copy-tamper.json.`), lines.join('\n'));
});

test('plain-Russian lines: lead, counts, a line per file with size words, time and who; no English jargon', () => {
  const ph = loadPhrases();
  const r = rec({
    added: [{ rel: 'a/x.json', bytes: 1, mtimeMs: T0 + 3 * 60000 }, { rel: 'a/y.json', bytes: 2, mtimeMs: T0 + 3 * 60000 }, { rel: 'a/z.json', bytes: 3, mtimeMs: T0 + 3 * 60000 }],
    changed: [{ rel: 'a/big.csv', bytesBefore: 171 * 1048576, bytes: 171 * 1048576 + 5, mtimeMs: T0 + 300 * 60000 }],
    removed: [],
  });
  const lines = tamperLinesRu(r, ph, fill);
  assert.match(lines[0], /^Пока проверяющие работали, в копию для проверки что-то записали/);
  assert.ok(lines.includes('Что изменилось в копии: новых файлов — 3, изменённых — 1, пропавших — 0.'));
  assert.ok(lines.some((x) => x.startsWith('новый файл: `a/x.json`; размер 1 байт; записан ') && x.includes('проверяющий «Факты» (задание aaaaaaa2)') && x.includes('помощник, который пишет заведомо ложные замечания (задание ddddddd2)')));
  assert.ok(lines.some((x) => x.startsWith('новый файл: `a/y.json`; размер 2 байта;')));
  assert.ok(lines.some((x) => x.startsWith('новый файл: `a/z.json`; размер 3 байта;')));
  assert.ok(lines.some((x) => x.includes('изменён файл: `a/big.csv`; размер был 171,0 МБ, стал 171,0 МБ') && x.includes('в это время работали: проверяющий «Путь» (задание ccccccc2)')));
  const text = lines.join('\n');
  for (const jargon of ['mtime', 'hash', 'scratch', 'ledger', 'INVALID']) assert.ok(!text.includes(jargon), jargon);
});

test('the lines say when the file list was not kept and when the folder is gone', () => {
  const ph = loadPhrases();
  const l1 = tamperLinesRu(rec({ added: [], changed: [], removed: [] }, { listingKnown: false }), ph, fill);
  assert.ok(l1.some((x) => x.startsWith('Список файлов копии на момент её подготовки не сохранился')));
  const l2 = tamperLinesRu(rec({ added: [], changed: [], removed: [{ rel: 'a/b.md', bytesBefore: 1, mtimeMsBefore: T0 }] }, { copyMissing: true }), ph, fill);
  assert.ok(l2.includes('Папка с копией пропала целиком.'));
});

test('scratchLineRu names how many scratch files were removed', () => {
  assert.equal(scratchLineRu(3, loadPhrases(), fill), 'В копии появилось временных файлов, которые Python или pytest создают сами: 3. Программа их удалила, копия снова равна подготовленной, круг засчитан.');
});
