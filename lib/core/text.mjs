// Small text helpers shared by lint.mjs and sample.mjs (kept here so the two do not import each other).

/** 9.8: NFKC, collapse whitespace, trim. */
export function normalizeLine(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}
