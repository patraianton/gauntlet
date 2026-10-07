// Exact binomial intervals (SPEC 14.8).
//
// clopperPearson(k, n, conf) -> [lo, hi]: two-sided Clopper-Pearson interval.
// lowerBound(k, n, conf)     -> lo: one-sided lower bound ("recall is above lo" at conf).
// Both are found by bisection on the exact binomial CDF computed with log-gamma terms,
// so they work for any n without overflow and need no beta-quantile library.

import { UsageError } from '../core/errors.mjs';

/** Below this many units a proportion is printed without an interval. */
export const MIN_N_FOR_INTERVAL = 10;
/** The headline own-lens recall waits for this many attention canaries. */
export const HEADLINE_N = 25;

// Lanczos approximation (g = 7, n = 9), accurate to ~1e-15 for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n, i) {
  return logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1);
}

function logPmf(i, n, p) {
  if (p <= 0) return i === 0 ? 0 : -Infinity;
  if (p >= 1) return i === n ? 0 : -Infinity;
  return logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p);
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logPmf(i, n, p));
  return Math.min(1, s);
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomSf(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logPmf(i, n, p));
  return Math.min(1, s);
}

function check(k, n, conf) {
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`n must be a non-negative integer (got ${n})`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new UsageError(`k must be an integer in [0, n] (got ${k}/${n})`);
  if (!(conf > 0 && conf < 1)) throw new UsageError(`conf must be in (0, 1) (got ${conf})`);
}

/** Bisection for the p where f(p) crosses target; f must be monotone on [0, 1]. */
function bisect(f, target, increasing) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < target) === increasing) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-13) break;
  }
  return (lo + hi) / 2;
}

/** Lower end: the p with P(X >= k | p) = alpha (increasing in p). */
function lowerAt(k, n, alpha) {
  if (k === 0) return 0;
  return bisect((p) => binomSf(k, n, p), alpha, true);
}

/** Upper end: the p with P(X <= k | p) = alpha (decreasing in p). */
function upperAt(k, n, alpha) {
  if (k === n) return 1;
  return bisect((p) => binomCdf(k, n, p), alpha, false);
}

/** Two-sided Clopper-Pearson interval. n = 0 gives [0, 1]. */
export function clopperPearson(k, n, conf = 0.95) {
  check(k, n, conf);
  if (n === 0) return [0, 1];
  const alpha = (1 - conf) / 2;
  return [lowerAt(k, n, alpha), upperAt(k, n, alpha)];
}

/** One-sided lower bound at confidence conf. */
export function lowerBound(k, n, conf = 0.95) {
  check(k, n, conf);
  if (n === 0) return 0;
  return lowerAt(k, n, 1 - conf);
}

/**
 * proportion(k, n) -> { k, n, rate, ci: [lo, hi] | null, lower: number | null, sufficient }
 * Below MIN_N_FOR_INTERVAL units no interval is given (printed as "insufficient").
 */
export function proportion(k, n, conf = 0.95) {
  const sufficient = n >= MIN_N_FOR_INTERVAL;
  return {
    k,
    n,
    rate: n > 0 ? k / n : null,
    ci: sufficient ? clopperPearson(k, n, conf) : null,
    lower: sufficient ? lowerBound(k, n, conf) : null,
    sufficient,
  };
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/** "k/n (95 % CI lo-hi; above lower with 95 %)" or "k/n, insufficient" — for STATS.md (English). */
export function formatEn(p) {
  if (!p || p.n === 0) return '0/0, no data';
  if (!p.sufficient) return `${p.k}/${p.n}, insufficient (n < ${MIN_N_FOR_INTERVAL})`;
  return `${p.k}/${p.n} (95% CI ${pct(p.ci[0])}-${pct(p.ci[1])}; one-sided lower bound ${pct(p.lower)})`;
}

/** Plain-Russian form for the owner: «K из N (от LO до HI из 100)» or «K из N — мало данных». */
export function formatRu(p) {
  if (!p || p.n === 0) return 'данных нет';
  if (!p.sufficient) return `${p.k} из ${p.n} — мало данных`;
  return `${p.k} из ${p.n} (где-то от ${Math.round(p.ci[0] * 100)} до ${Math.round(p.ci[1] * 100)} из 100)`;
}
