// `sources check <run>` (SPEC 9.4, 10.2): run every source recipe now and print the results.
// A preview: the same check runs at setup (every source must pass) and at each round start
// (a failing or changed source blocks the round). It applies the same age rule as setup (r3-f4).

import { UsageError } from '../core/errors.mjs';
import { exists } from '../core/fsx.mjs';
import { parseArgv, openRun, log } from './state.mjs';
import { runSourcesCheck, loadSourcesFile, approvedMovingKeys } from './setup.mjs';
import { movingTargetProblems } from '../material/sources.mjs';

export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  if (sub !== 'check') throw new UsageError('usage: sources check <run>');
  const { positional } = parseArgv(rest, {});
  const rc = openRun(positional[0], ctx, { command: 'sources check' });
  if (!exists(rc.paths.sources)) throw new UsageError(`no sources.json in ${rc.runDir}`);
  const results = runSourcesCheck(rc);
  log(rc, 'sources-check', { preview: true, results: results.map((r) => ({ id: r.id, ok: r.ok, exitCode: r.exitCode, bytes: r.bytes, sha256: r.sha256, error: r.error ?? null })) });
  const lines = results.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.id}  ${r.ok ? `${r.bytes} bytes` : r.error || `exit ${r.exitCode}`}${r.sample ? `\n      ${String(r.sample).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  const failing = results.filter((r) => !r.ok);
  // Recipes that read something that changes during the run: a warning here, the owner's words at setup and amend.
  const okMoving = approvedMovingKeys(rc);
  const moving = movingTargetProblems(loadSourcesFile(rc)).map((p) => ({ ...p, approved: okMoving.has(p.key), hint: !!p.hint }));
  for (const m of moving) lines.push(`${m.hint ? 'HINT' : 'WARN'} ${m.id}  ${m.key.replace(/^source S\d+: /, '')}${m.approved ? " (kept on the owner's words)" : ''}\n      ${m.why}. Fix: ${m.suggest}`);
  lines.push('');
  lines.push(failing.length ? `NEXT: fix ${failing.map((f) => f.id).join(', ')} in sources.json (every recipe must return data)` : 'NEXT: run step');
  return { exitCode: failing.length ? 20 : 0, state: rc.state.state, payload: { results, movingTargets: moving.map((m) => ({ id: m.id, key: m.key, approved: m.approved, hint: m.hint })), todo: failing.map((f) => ({ kind: 'source', text: `Source ${f.id} failed: ${f.error || 'exit ' + f.exitCode}` })) }, text: lines.join('\n') };
}
