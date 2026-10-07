import test from 'node:test';
import assert from 'node:assert/strict';
import { lintReportText, REPORT_PATTERNS } from '../../lib/report/report-lint.mjs';

// A positive and a negative example for every pattern id (SPEC 15.5).
const CASES = {
  'R-PANEL-GAVE': ['Итого панель поставила 9 баллов.', 'Панель проверяющих работала три круга.'],
  'R-PANEL-SCORE': ['Оценка панели выросла.', 'Оценки нет — подтверждающего слепого круга не было.'],
  'R-ALL-HAPPY': ['Все проверяющие довольны результатом.', 'Все проверяющие были одной модели (Sonnet).'],
  'R-BARE-SCORE': ['Итог: 9,5 из 10.', 'Поймано 5 из 10 пар.'],
};

test('every report pattern has a positive and a negative example', () => {
  assert.deepEqual(Object.keys(CASES).sort(), REPORT_PATTERNS.map((p) => p.id).sort());
  for (const [id, [pos, neg]] of Object.entries(CASES)) {
    assert.ok(lintReportText(pos).some((h) => h.patternId === id), `${id} positive: ${pos}`);
    assert.ok(!lintReportText(neg).some((h) => h.patternId === id), `${id} negative: ${neg}`);
  }
});

test('bare scores are allowed only on a «справочно» line; slash form is caught', () => {
  assert.deepEqual(lintReportText('Справочно, по таблице: 7,5 из 10.'), []);
  assert.equal(lintReportText('Средняя 8.7/10')[0].patternId, 'R-BARE-SCORE');
  assert.deepEqual(lintReportText('Поймано 19 из 25.'), []);
  assert.deepEqual(lintReportText('Цена 9,5 из 100 тысяч'), [], '"из 100" is not a score out of 10');
});

test('quotation lines are skipped unless includeQuotes; hits carry line numbers', () => {
  const text = 'Наш текст.\n> панель поставила 9,5 из 10 (слова владельца)\nОценка панели: нет.';
  const hits = lintReportText(text);
  assert.deepEqual(hits.map((h) => [h.line, h.patternId]), [[3, 'R-PANEL-SCORE']]);
  const all = lintReportText(text, { includeQuotes: true });
  assert.ok(all.some((h) => h.line === 2 && h.patternId === 'R-PANEL-GAVE'));
  assert.ok(all.some((h) => h.line === 2 && h.patternId === 'R-BARE-SCORE'));
});
