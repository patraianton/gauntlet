import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadPatterns,
  scanString,
  scanTrace,
  scanPaths,
  lintPath,
  lintValues,
  lintText,
  normalizeQuote,
  normalizeLine,
  findQuote,
  notesProblems,
  decodeForScan,
  MAX_NOTES_CHARS,
  allowProblems,
  compileAllow,
} from '../../lib/material/lint.mjs';
import { tmpDir, put, readExamples, BOM } from '../fixtures/material/helpers.mjs';

const ex = readExamples();
const cc = (...c) => String.fromCharCode(...c);

function idsHit(text, patterns, scopes) {
  return new Set(scanString(text, patterns, [], scopes).map((h) => h.patternId));
}

for (const [kind, key] of [
  ['trace', 'trace'],
  ['prompt', 'prompt'],
  ['meta', 'meta'],
]) {
  test(`${kind} catalog: every pattern id has a positive and a negative example, and they behave`, () => {
    const patterns = loadPatterns(kind);
    const examples = { ...ex[key], ...(kind === 'trace' ? ex.tracePath : {}) };
    const ids = patterns.map((p) => p.id);
    assert.deepEqual([...ids].sort(), Object.keys(examples).sort(), 'examples cover exactly the catalog ids');
    for (const p of patterns) {
      assert.ok(p.id && p.lang && p.why, `${p.id} has id, lang and why`);
      assert.ok(['en', 'ru', 'lv', 'any'].includes(p.lang), `${p.id} lang`);
      const { pos, neg } = examples[p.id];
      const scopes = p.scope === 'path' ? ['path'] : ['both', 'content'];
      assert.ok(idsHit(pos, [p], scopes).has(p.id), `${p.id} must hit "${pos}"`);
      assert.ok(!idsHit(neg, [p], scopes).has(p.id), `${p.id} must not hit "${neg}"`);
    }
  });
}

test('trace catalog contains at least the patterns SPEC 15.5 lists', () => {
  const pats = loadPatterns('trace');
  const must = [
    'оценки проверяющих', 'average score', 'средний балл', '8,7/10', '9.5', 'round 3', 'круг 3', 'раунд',
    'reviewers', 'проверяющие', 'panel', 'панель', 'canary', 'подложенные', 'исправлено', 'fixed in round 2',
    'версия 3 плана', 'version 3 of the plan', 'deliberate', 'намеренно', 'verified by the panel', 'FEEDBACK',
  ];
  for (const s of must) assert.ok(scanString(s, pats, [], ['both', 'content']).length > 0, `trace scan must catch "${s}"`);
});

test('prompt catalog contains at least the patterns SPEC 15.5 lists', () => {
  const pats = loadPatterns('prompt');
  const must = [
    '≥ 9', '>= 9', '9,5', 'at least 9 points', 'score', 'оценку', 'оценка', 'rating', 'average', 'средний',
    'do not flag', 'не отмечай', 'не указывай', 'deliberate', 'намеренно', 'out of scope', 'вне рамок',
    'already fixed', 'исправлено', 'do not invent', 'не придумывай', 'not substantive', 'несущественно',
    'previous round', 'previous score', 'previous review', 'предыдущий круг', 'предыдущего круга',
  ];
  for (const s of must) assert.ok(lintValues({ v: s }, pats).length > 0, `prompt lint must catch "${s}"`);
});

test('meta catalog catches the SPEC 12.1 examples', () => {
  const pats = loadPatterns('meta');
  for (const s of ['this looks planted', 'canary', 'подложенная ошибка', 'тестовая ошибка']) {
    assert.ok(lintText(s, pats).length > 0, s);
  }
});

test('scanTrace finds RU/EN/LV traces with file and line, and traceAllow removes covered hits', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/page.md', 'Intro\r\nСредняя оценка выросла до 9,3\r\nReviewed in round 4\r\n');
  put(dir, 'content/lv.md', 'Teksts\nvidējais vērtējums bija 8\n');
  put(dir, 'content/solar.md', 'Solar panel kits for roofs\n');
  put(dir, 'content/img.png', Buffer.from('round 3 panel', 'utf8'));
  const pats = loadPatterns('trace');
  const hits = scanTrace(dir, pats, []);
  const at = (file, id) => hits.find((h) => h.file === file && h.patternId === id);
  assert.equal(at('content/page.md', 'T-AVG-RU').line, 2);
  assert.equal(at('content/page.md', 'T-ROUND-EN').line, 3);
  assert.ok(at('content/lv.md', 'T-LV-SCORE'));
  assert.ok(at('content/solar.md', 'T-PANEL-EN'));
  assert.ok(!hits.some((h) => h.file === 'content/img.png'), 'binary files are not scanned');

  const allowed = scanTrace(dir, pats, [{ phrase: 'solar panel kits', why: 'product name' }]);
  assert.ok(!allowed.some((h) => h.file === 'content/solar.md'), 'a literal phrase matches case-insensitively');
  assert.ok(allowed.some((h) => h.file === 'content/page.md'), 'other traces stay');
  // an allow phrase that does not cover the hit does not remove it
  const partial = scanTrace(dir, pats, [{ phrase: 'roof panel kits', why: 'other product' }]);
  assert.ok(partial.some((h) => h.file === 'content/solar.md' && h.patternId === 'T-PANEL-EN'));
});

test('traceAllow takes only narrow literal product phrases; a broad allow cannot switch the scan off (r3-f1)', () => {
  const bad = [
    { pattern: '.+', why: 'product words' },
    { phrase: '.+', why: 'x' },
    { phrase: '[A-Za-z ]+ panel', why: 'x' },
    { phrase: 'panel', why: 'too short' },
    { phrase: 'Panel average score 9.5', why: 'two traces' },
    { phrase: 'ordinary words here', why: 'no trace word' },
    { phrase: 'solar panel kits' },
  ];
  for (const a of bad) {
    assert.ok(allowProblems(a).length > 0, JSON.stringify(a));
    assert.throws(() => compileAllow([a]), /traceAllow/);
  }
  for (const phrase of ['приборная панель', 'instrument panel', 'лампы ошибок на панели', 'Solar panel kits (2 kW)']) {
    assert.deepEqual(allowProblems({ phrase, why: 'product' }), [], phrase);
  }
  // the literal "." does not act as a wildcard
  assert.equal(scanString('Solar panel kits', loadPatterns('trace'), compileAllow([{ phrase: 'Solar.panel kits', why: 'x' }])).length, 1);
});

test('scanTrace decodes JSON \\u escapes so escaped Cyrillic cannot hide a trace', (t) => {
  const dir = tmpDir(t);
  // "оценки проверяющих" (a pattern that also applies inside data files) written with JSON escapes
  const escaped = '"' + [...'оценки проверяющих'].map((ch) => (ch === ' ' ? ' ' : '\\' + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))).join('') + ' по кругам"';
  put(dir, 'content/data.json', `{"note": ${escaped}}\n`);
  const hits = scanTrace(dir, loadPatterns('trace'), []);
  const h = hits.find((x) => x.patternId === 'T-SCORE-RU');
  assert.ok(h, 'decoded string scanned');
  assert.equal(h.line, null);
  assert.match(h.where, /^json:/);
});

test('scanTrace decodes numeric HTML entities', (t) => {
  const dir = tmpDir(t);
  const ent = [...'раунд'].map((ch) => `&#${ch.charCodeAt(0)};`).join('');
  put(dir, 'content/p.html', `<p>${ent} 2</p>\n`);
  const hits = scanTrace(dir, loadPatterns('trace'), []);
  assert.ok(hits.some((h) => h.patternId === 'T-RAUND-RU' && h.where === 'html-text'));
});

test('path lint checks every component; path-only patterns do not fire on contents', (t) => {
  const pats = loadPatterns('trace');
  const hits = lintPath('C:\\Users\\x\\work-copies\\demo\\gauntlet-runs\\round-2\\a.md', pats);
  const comps = hits.map((h) => h.component);
  assert.ok(comps.includes('gauntlet-runs'));
  assert.ok(comps.includes('round-2'));
  assert.deepEqual(lintPath('C:\\Users\\x\\work-copies\\demo\\wc\\abcd2345', pats), []);
  assert.deepEqual(lintPath('/Users/x/work-copies/demo/wc/abcd2345', pats), []);
  assert.ok(lintPath('/tmp/review-tool/wc', pats).some((h) => h.patternId === 'P-REVIEW'));

  const dir = tmpDir(t);
  put(dir, 'content/text.md', 'Please review the offer before the round table.\n');
  put(dir, 'content/ROUND3-FEEDBACK.md', 'ok\n');
  const content = scanTrace(dir, pats, []);
  assert.ok(!content.some((h) => h.patternId === 'P-REVIEW' || h.patternId === 'P-ROUND'));
  const paths = scanPaths(dir, pats, []);
  assert.ok(paths.some((h) => h.file === 'content/ROUND3-FEEDBACK.md' && h.where === 'path'));
});

test('lintValues walks strings, arrays and nested objects', () => {
  const pats = loadPatterns('prompt');
  const hits = lintValues(
    {
      TASK: 'Make a plan for 12 posts.',
      CHECKLIST: ['prices match the site', 'do not flag the old logo'],
      LENS: { duty: 'check facts', notes: ['until the average is high'] },
    },
    pats,
  );
  const names = hits.map((h) => h.name);
  assert.ok(names.includes('CHECKLIST[1]'));
  assert.ok(names.includes('LENS.notes[0]'));
  assert.ok(!names.includes('TASK'));
});

test('normalizeQuote follows 12.3', () => {
  const nbsp = cc(0xa0);
  const zw = cc(0x200b);
  assert.equal(normalizeQuote(`  ${cc(0xab)}Цена${nbsp}49${cc(0xbb)}  ${cc(0x2014)} ${zw}итого `), '"Цена 49" - итого');
  assert.equal(normalizeQuote(`${cc(0x201c)}a${cc(0x201d)} ${cc(0x201e)}b${cc(0x2019)}`), '"a" "b"');
  assert.equal(normalizeQuote(`x${cc(0x2013)}y${cc(0x2212)}z`), 'x-y-z');
  assert.equal(normalizeQuote('Case Kept'), 'Case Kept');
  // NFKC: fullwidth letters fold
  assert.equal(normalizeQuote(cc(0xff21, 0xff22)), 'AB');
});

test('normalizeLine: NFKC, collapse whitespace, trim', () => {
  assert.equal(normalizeLine('  Price:\t49   EUR\r'), 'Price: 49 EUR');
  assert.equal(normalizeLine(cc(0xff11, 0xff12)), '12');
});

test('findQuote: cited file first, JSON decoded strings, HTML text, short quotes', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/plan.json', JSON.stringify({ posts: [{ caption: 'Line one\nLine "two"' }] }) + '\n');
  put(dir, 'content/page.html', '<p>Fast <b>delivery</b> to Springfield</p>\n');
  put(dir, 'content/a.md', Buffer.concat([BOM, Buffer.from('Price is 49 EUR\r\nsecond line\r\n')]));
  put(dir, 'content/b.md', 'Price is 49 EUR\n');

  assert.deepEqual(findQuote(dir, 'content/b.md', 'Price is 49 EUR'), { found: true, file: 'content/b.md' });
  assert.deepEqual(findQuote(dir, null, 'Price is 49 EUR'), { found: true, file: 'content/a.md' });
  assert.deepEqual(findQuote(dir, 'content/missing.md', 'second line'), { found: true, file: 'content/a.md' });
  // decoded JSON value with a real newline and quotes
  assert.equal(findQuote(dir, 'content/plan.json', 'Line one Line "two"').found, true);
  // raw JSON text with escapes
  assert.equal(findQuote(dir, 'content/plan.json', 'Line one\\nLine').found, true);
  // HTML with tags removed
  assert.equal(findQuote(dir, 'content/page.html', 'Fast delivery to Springfield').found, true);
  // typographic quotes and NBSP on the quote side
  assert.equal(findQuote(dir, null, `Line one Line ${cc(0x201c)}two${cc(0x201d)}`).found, true);
  // fewer than 4 characters is never grounded
  assert.deepEqual(findQuote(dir, null, ' 49 '), { found: false, file: null });
  // not present
  assert.deepEqual(findQuote(dir, null, 'Price is 59 EUR'), { found: false, file: null });
  // absolute cited path inside the copy is accepted
  assert.equal(findQuote(dir, path.join(dir, 'content', 'b.md'), 'Price is 49 EUR').file, 'content/b.md');
});

test('prompt catalog: controlOnly leaves out the rating words, keeps every loop-control construct', () => {
  const all = loadPatterns('prompt');
  const ctl = loadPatterns('prompt', { controlOnly: true });
  const rating = all.filter((p) => p.class === 'rating-word').map((p) => p.id).sort();
  assert.deepEqual(rating, ['F-AVERAGE', 'F-LV-SCORE', 'F-OCENK-RU', 'F-RATING', 'F-SCORE', 'F-SREDN-RU']);
  const steering = all.filter((p) => p.class === 'steering-word').map((p) => p.id).sort();
  assert.deepEqual(steering, ['F-ACCEPTABLE', 'F-DOPUSTIMO-RU', 'F-FIX-CLAIM-EN', 'F-FIX-CLAIM-RU', 'F-IS-FINE', 'F-LV-FIX-CLAIM', 'F-LV-TISHI', 'F-NE-OSHIBKA-RU', 'F-NOT-AN-ERROR', 'F-ON-PURPOSE', 'F-SPECIALNO-RU']);
  assert.equal(ctl.length, all.length - rating.length - steering.length);
  // r2-f20: the bench note that steered verifiers is refused in executor-written text
  assert.ok(lintText('Slide numbers were taken on 04.10.2026: a small shift alone is not an error.', all).length > 0);
  assert.equal(lintText(JSON.parse(fs.readFileSync(new URL('../../bench/sources.json', import.meta.url), 'utf8')).sources.map((x) => x.notes || '').join(' | '), all).length, 0, 'bench notes are clean');
  // product words survive in the owner's task; thresholds and "until the panel" do not
  for (const s of ['Сделай сайт с оценкой стоимости авто.', 'Покажи среднюю цену по марке.', 'Add a credit score badge and star rating.']) {
    assert.equal(lintText(s, ctl).length, 0, s);
  }
  for (const s of ['Доводи до оценки 9,5.', 'Iterate until the panel says it is done.', 'Гоняй панель до готовности.', 'Give it at least 9 points.']) {
    assert.ok(lintText(s, ctl).length > 0, s);
  }
});

test('author notes: steering, intent and fix claims are refused; numeric facts pass; the length is capped (r3-f2)', () => {
  for (const s of ['The price is low on purpose.', 'This is by design.', 'Intentional omission, do not flag.', 'Цена специально занижена.', 'Сознательно, так задумано, это не ошибка.', 'Таблица поправлена.', 'Price error corrected; resolved.', 'Цены сверены с прайсом.', 'Deliberate choice.', 'Всё исправлено.']) {
    assert.ok(notesProblems(s).length > 0, s);
  }
  for (const s of ['Prices come from source S1.', 'deal score ≥ 70, year ≥ 2012', 'Средний чек 40 евро, оценка рынка.']) {
    assert.deepEqual(notesProblems(s), [], s);
  }
  assert.ok(notesProblems('a'.repeat(MAX_NOTES_CHARS + 1)).some((h) => h.patternId === 'NOTES-TOO-LONG'));
});

test('the trace scan reads files by content: unknown extensions, no extension, UTF-16 (r3-f15)', (t) => {
  const dir = tmpDir(t);
  const line = 'Round 3 panel score 9.5, ROUND2-FEEDBACK\n';
  for (const f of ['b.jsonl', 'FEEDBACK', 'c.md.bak', 'd.vtt', 'x.ipynb', 'z.weird']) put(dir, f, line);
  put(dir, 'e.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]));
  put(dir, 'f.txt', Buffer.from(line, 'utf16le'));
  put(dir, 'img.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3, 0xff, 0xd8]));
  const files = new Set(scanTrace(dir, loadPatterns('trace'), []).map((h) => h.file));
  for (const f of ['b.jsonl', 'FEEDBACK', 'c.md.bak', 'd.vtt', 'x.ipynb', 'z.weird', 'e.md', 'f.txt']) assert.ok(files.has(f), f);
  assert.ok(!files.has('img.bin'), 'genuinely binary files are skipped');
  assert.equal(decodeForScan(Buffer.from([0, 1, 2, 0xff])), null);
});

// BUG 15 (a real night run): «Версия 1 / Версия 2» are the stages of a Shopify integration in a
// product description. The trace filter must keep the history of the reviewed work out, not product numbering.
const VERSION_IDS = (s, scopes = ['both', 'content']) => scanString(s, loadPatterns('trace'), [], scopes).map((h) => h.patternId).filter((id) => id.startsWith('T-VERSION'));

test('product numbering of versions is not a review trace (bug 15)', () => {
  const productProse = [
    'Версия 1 — один тег в Google Tag Manager или вставка в тему. Версия 2 — приложение Shopify с блоком темы, ставится без программиста.', // the sentence of the real run
    'Версия 1: подключение',
    'Версия 2: приложение',
    'версия 2 приложения для Shopify',
    'API версии 3 поддерживает пакетную загрузку',
    'Shopify версии 2 выпущен в 2025 году',
    'Версия 2 работает через API магазина',
    'версия 2 текстовый редактор для описаний',
    'В версии 3 появился экспорт в CSV',
    'в версии 2 добавлено приложение для темы',
    'Версия 1 / Версия 2 / Версия 3',
    'Версия №2 доступна на сайте',
    'версия плана',
    'The Shopify app, version 2 of the Shopify API, supports bulk upload.',
    'version 3 of our app ships in May',
    'version 2 of the checkout extension',
    'the latest version of the plan',
    'a preview version of the theme',
    'an HDMI v2 cable and a v3 hub',
    'версия 3 работы блока на мобильных', // «работа» = how it works, not the reviewed work
    'Версия 1 описание подключения',
    'Это версия 3 нашего приложения',
    'Version 1 - fixed price, Version 2 - usage based',
    'available since version 2',
  ];
  for (const s of productProse) assert.deepEqual(VERSION_IDS(s), [], `not a trace: "${s}"`);
});

test('the history of the reviewed work itself is still a review trace (bug 15)', () => {
  const history = [
    ['версия 2 документа', 'T-VERSION-RU'],
    ['Версия 3 плана', 'T-VERSION-RU'],
    ['версия 2 отчёта', 'T-VERSION-RU'],
    ['версия 2 отчета', 'T-VERSION-RU'],
    ['версией 3 черновика', 'T-VERSION-RU'],
    ['версия документа №2', 'T-VERSION-RU'],
    ['в версии 3 исправлено', 'T-VERSION-FIXED-RU'],
    ['В версии 3 учтено замечание про цену', 'T-VERSION-FIXED-RU'],
    ['во версии 2: устранены повторы', 'T-VERSION-FIXED-RU'],
    ['<p>Версия 7. Собрано 05.10.2026.</p>', 'T-VERSION-STAMP-RU'],
    ['по сравнению с версией 2', 'T-VERSION-COMPARE-RU'],
    ['В сравнении с версией №1 текст короче', 'T-VERSION-COMPARE-RU'],
    ['относительно версии 3', 'T-VERSION-COMPARE-RU'],
    ['предыдущая версия', 'T-VERSION-PREV-RU'],
    ['в предыдущей версии были ошибки', 'T-VERSION-PREV-RU'],
    ['v2 → v3', 'T-VERSION-ARROW'],
    ['V1 -> V2', 'T-VERSION-ARROW'],
    ['v1.2 => v1.3', 'T-VERSION-ARROW'],
    ['version 3 of the plan', 'T-VERSION-OF-EN'],
    ['Version 2 of this document', 'T-VERSION-OF-EN'],
    ['version 4 of the report', 'T-VERSION-OF-EN'],
    ['compared to version 2', 'T-VERSION-COMPARE-EN'],
    ['the previous version', 'T-VERSION-PREV-EN'],
    ['fixed in version 3', 'T-FIXED-IN-EN'],
    // wider history marks (review of 07.10, finding A2 / R3)
    ['Версия 3 (после замечаний)', 'T-VERSION-REVIEW-RU'],
    ['Версия 4 (учтены замечания проверки)', 'T-VERSION-REVIEW-RU'],
    ['Версия 2 — учтены замечания', 'T-VERSION-REVIEW-RU'],
    ['Версия 3 — доработана', 'T-VERSION-REVIEW-RU'],
    ['версия 2.1 — после проверки', 'T-VERSION-REVIEW-RU'],
    ['Что изменилось с версии 2', 'T-VERSION-FROM-RU'],
    ['изменения с версии 2', 'T-VERSION-FROM-RU'],
    ['в отличие от версии 2', 'T-VERSION-FROM-RU'],
    ['версия 2 → версия 3', 'T-VERSION-ARROW-WORD'],
    ['version 2 -> version 3', 'T-VERSION-ARROW-WORD'],
    ['версия 3 этого плана', 'T-VERSION-RU'],
    ['документ версии 3', 'T-VERSION-NOUN-FIRST-RU'],
    ['Обновлено в версии 4', 'T-VERSION-DONE-IN-RU'],
    ['в версии 3 добавлен раздел', 'T-VERSION-STRUCTURE-RU'],
    ['Это версия 3.', 'T-VERSION-THIS-RU'],
    ['<p>Это версия 3.</p>', 'T-VERSION-THIS-RU'],
    ['Version 3 (after review)', 'T-VERSION-REVIEW-EN'],
    ['Version 3 — fixed typos', 'T-VERSION-REVIEW-EN'],
    ['changes since version 2', 'T-VERSION-SINCE-EN'],
    ['in contrast to version 2', 'T-VERSION-SINCE-EN'],
  ];
  for (const [s, id] of history) {
    const all = scanString(s, loadPatterns('trace'), [], ['both', 'content']).map((h) => h.patternId);
    assert.ok(all.includes(id), `"${s}" must hit ${id}, got ${all.join(',') || 'nothing'}`);
  }
});

test('the real sentence of that run passes the trace scan unchanged, and an excuse still works for a phrase that is caught (bug 15)', (t) => {
  const dir = tmpDir(t);
  put(dir, 'content/PRODUCT.md', '# Продукт\n\n| Установка | Версия 1 — один тег в Google Tag Manager или вставка в тему. Версия 2 — приложение Shopify с блоком темы, ставится без программиста |\n');
  assert.deepEqual(scanTrace(dir, loadPatterns('trace'), []), []);

  // a product phrase that is still caught: the excuse path (traceAllow, a literal phrase) removes exactly it
  put(dir, 'content/tariffs.md', 'Тариф Pro включает версия 3 плана подписки без ограничений.\nВ версии 3 исправлено всё, что просили.\n');
  const pats = loadPatterns('trace');
  const hits = scanTrace(dir, pats, []);
  assert.ok(hits.some((h) => h.file === 'content/tariffs.md' && h.line === 1 && h.patternId === 'T-VERSION-RU'));
  assert.ok(hits.some((h) => h.file === 'content/tariffs.md' && h.line === 2));
  const allow = [{ phrase: 'версия 3 плана подписки', why: 'название тарифа продукта' }];
  assert.deepEqual(allowProblems(allow[0]), []);
  const after = scanTrace(dir, pats, allow);
  assert.ok(!after.some((h) => h.file === 'content/tariffs.md' && h.line === 1), 'the allowed product phrase passes');
  assert.ok(after.some((h) => h.file === 'content/tariffs.md' && h.line === 2), 'the real history on the next line stays');
  // an excuse for text no pattern catches any more is refused as not needed (it would only widen what is let through)
  assert.ok(allowProblems({ phrase: 'Версия 1 — один тег', why: 'x' }).some((p) => /covers no review-trace word/.test(p)));
});
