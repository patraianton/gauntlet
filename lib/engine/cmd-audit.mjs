// `audit <run>` (SPEC 11.9): writes AUDIT.json; exit 3 on any failed check.
import { UsageError } from '../core/errors.mjs';
import { parseArgv } from './state.mjs';
import { audit } from './audit.mjs';

export async function run(argv, ctx) {
  const { positional } = parseArgv(argv, {});
  if (!positional[0]) throw new UsageError('usage: audit <run>');
  const res = audit(positional[0], ctx);
  const lines = res.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.id}${c.details.length ? ': ' + c.details.slice(0, 5).join(' | ') : ''}`);
  // Comparisons that could not be made are not failures, but they are never left out of the output.
  for (const n of res.notCompared ?? []) {
    const what = n.id === 'frozen' ? `the run was frozen by another program version (${n.frozenTool?.version ?? '?'}, ${String(n.frozenTool?.gitHead ?? '?').slice(0, 7)}; now ${n.nowTool?.version ?? '?'}, ${String(n.nowTool?.gitHead ?? '?').slice(0, 7)}): not compared with FROZEN.json: ${(n.files ?? []).join(', ')}`
      : n.kind === 'stale' ? `the report on disk is older than the last ${n.events} state-changing event(s) of the run: its numbers are not compared; rebuild it with report`
        : `the logged report has other fields (${(n.fields ?? []).join(', ')}): only the common ones were compared`;
    lines.push(`NOT COMPARED ${n.id}: ${what}`);
  }
  lines.push('');
  if (!res.ok) lines.push('NEXT: do not trust this run; show the failed checks to the owner');
  else if ((res.notCompared ?? []).length) lines.push('NEXT: nothing is broken, but say to the owner which comparison could not be made (report --summary prints it in plain Russian)');
  else lines.push('NEXT: nothing; the run files are consistent');
  return { exitCode: res.ok ? 0 : 3, state: null, payload: res, text: lines.join('\n') };
}
