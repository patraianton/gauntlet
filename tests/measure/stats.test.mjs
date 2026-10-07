import test from 'node:test';
import assert from 'node:assert/strict';
import { clopperPearson, lowerBound, proportion, binomCdf, formatEn, formatRu, MIN_N_FOR_INTERVAL } from '../../lib/measure/stats.mjs';

// SPEC 14.8 pinned values: k/n -> two-sided 95 % [lo, hi], one-sided 95 % lower bound.
const TABLE = [
  [3, 3, 0.292, 1.0, 0.368],
  [5, 5, 0.478, 1.0, 0.549],
  [10, 10, 0.692, 1.0, 0.741],
  [14, 14, 0.768, 1.0, 0.807],
  [29, 29, 0.881, 1.0, 0.902],
  [18, 20, 0.683, 0.988, 0.717],
  [19, 25, 0.549, 0.906, 0.58],
  [13, 25, 0.313, 0.722, 0.341],
  [5, 25, 0.068, 0.407, 0.082],
  [45, 50, 0.782, 0.967, 0.801],
  [0, 5, 0.0, 0.522, 0.0],
  [2, 10, 0.025, 0.556, 0.037],
];

for (const [k, n, lo, hi, lb] of TABLE) {
  test(`Clopper-Pearson ${k}/${n}`, () => {
    const [a, b] = clopperPearson(k, n);
    assert.ok(Math.abs(a - lo) <= 0.001, `lo ${a} vs ${lo}`);
    assert.ok(Math.abs(b - hi) <= 0.001, `hi ${b} vs ${hi}`);
    assert.ok(Math.abs(lowerBound(k, n) - lb) <= 0.001, `lower ${lowerBound(k, n)} vs ${lb}`);
  });
}

test('side note: 3/3 is anywhere from 29 % to 100 %; about 14/14 is needed to say "above 80 %"', () => {
  const [lo] = clopperPearson(3, 3);
  assert.equal(Math.round(lo * 100), 29);
  assert.ok(lowerBound(14, 14) > 0.8);
  assert.ok(lowerBound(13, 13) < 0.8);
});

test('edge cases and argument checks', () => {
  assert.deepEqual(clopperPearson(0, 0), [0, 1]);
  assert.equal(lowerBound(0, 0), 0);
  assert.throws(() => clopperPearson(4, 3), /k must be/);
  assert.throws(() => clopperPearson(-1, 3), /k must be/);
  assert.throws(() => clopperPearson(1, 3, 1.5), /conf/);
  assert.ok(Math.abs(binomCdf(2, 4, 0.5) - 11 / 16) < 1e-12);
  // large n works without overflow
  const [a, b] = clopperPearson(500, 1000);
  assert.ok(a > 0.46 && a < 0.47 && b > 0.53 && b < 0.54);
});

test('proportion: below 10 units no interval ("insufficient" / «мало данных»)', () => {
  const small = proportion(3, 3);
  assert.equal(small.sufficient, false);
  assert.equal(small.ci, null);
  assert.match(formatEn(small), /insufficient/);
  assert.match(formatRu(small), /мало данных/);
  const big = proportion(19, 25);
  assert.equal(big.sufficient, true);
  assert.ok(Math.abs(big.ci[0] - 0.549) <= 0.001);
  assert.match(formatEn(big), /^19\/25 \(95% CI 54\.9%-90\.6%; one-sided lower bound 58%\)$/);
  assert.match(formatRu(big), /19 из 25 \(где-то от 55 до 91 из 100\)/);
  assert.equal(MIN_N_FOR_INTERVAL, 10);
  assert.match(formatEn(proportion(0, 0)), /no data/);
});
