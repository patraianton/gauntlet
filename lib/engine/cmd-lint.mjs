// `lint <file> --kind prompt|trace|report` (SPEC 10.2, 15.5): run one lint over a file.

import { UsageError } from '../core/errors.mjs';
import { readText, exists } from '../core/fsx.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { loadPatterns, lintText } from '../material/lint.mjs';
import { parseArgv } from './state.mjs';

export async function run(argv) {
  const { positional, opts } = parseArgv(argv, { options: ['kind'] });
  if (!positional[0] || !['prompt', 'trace', 'report'].includes(opts.kind)) throw new UsageError('usage: lint <file> --kind prompt|trace|report');
  const file = normalizeInput(positional[0]);
  if (!exists(file)) throw new UsageError(`no such file: ${file}`);
  const text = readText(file);
  let hits;
  if (opts.kind === 'report') {
    const m = await import('../report/report-lint.mjs');
    hits = m.lintReportText(text);
  } else {
    hits = lintText(text, loadPatterns(opts.kind));
  }
  const lines = hits.map((h) => `line ${h.line ?? '?'}: "${h.text}" (${h.patternId ?? h.id ?? ''})`);
  lines.push('');
  lines.push(hits.length ? `NEXT: remove or cut the ${hits.length} hit(s)` : 'NEXT: nothing; no hits');
  return { exitCode: hits.length ? 20 : 0, state: null, payload: { file, kind: opts.kind, hits }, text: lines.join('\n') };
}
