// `audit <run>` (SPEC 11.9): writes AUDIT.json; exit 3 on any failed check.
import { UsageError } from '../core/errors.mjs';
import { parseArgv } from './state.mjs';
import { audit } from './audit.mjs';

export async function run(argv, ctx) {
  const { positional } = parseArgv(argv, {});
  if (!positional[0]) throw new UsageError('usage: audit <run>');
  const res = audit(positional[0], ctx);
  const lines = res.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.id}${c.details.length ? ': ' + c.details.slice(0, 5).join(' | ') : ''}`);
  lines.push('');
  lines.push(res.ok ? 'NEXT: nothing; the run files are consistent' : 'NEXT: do not trust this run; show the failed checks to the owner');
  return { exitCode: res.ok ? 0 : 3, state: null, payload: res, text: lines.join('\n') };
}
