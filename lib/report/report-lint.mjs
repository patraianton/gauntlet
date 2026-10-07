// Lint of the owner report (SPEC 15.5, P4).
//
// Forbidden in our own words: «панель поставила», «оценка панели», «все проверяющие довольны»,
// and any bare score `\d+[.,]\d (из|/) 10` on a line that does not contain «справочно».
// Lines that start with ">" are quotations of other people's words (the owner's task,
// material quotes, reviewers' and verifiers' text); the report generator puts every
// external text into such lines, so by default they are skipped. Pass
// { includeQuotes: true } to lint them as well.

export const REPORT_PATTERNS = Object.freeze([
  { id: 'R-PANEL-GAVE', re: /панел[ьи]\s+постав(?:ила|ил|или)/iu, why: 'a score attributed to the panel' },
  { id: 'R-PANEL-SCORE', re: /оценк[аеиу]\s+панели/iu, why: 'a panel score' },
  { id: 'R-ALL-HAPPY', re: /все\s+проверяющие\s+довольны/iu, why: 'approval by reviewer mood' },
  { id: 'R-BARE-SCORE', re: /\d+[.,]\d\s*(?:из|\/)\s*10(?!\d)/u, why: 'a score out of 10 outside a «справочно» line', unlessLine: /справочно/iu },
]);

/** lintReportText(text, { includeQuotes }) -> [{ line, patternId, text }] */
export function lintReportText(text, opts = {}) {
  const hits = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!opts.includeQuotes && /^\s*>/.test(line)) return;
      for (const p of REPORT_PATTERNS) {
        const m = p.re.exec(line);
        if (!m) continue;
        if (p.unlessLine && p.unlessLine.test(line)) continue;
        hits.push({ line: i + 1, patternId: p.id, text: m[0] });
      }
    });
  return hits;
}
