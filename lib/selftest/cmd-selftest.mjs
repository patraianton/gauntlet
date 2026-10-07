// `selftest [--keep]` (SPEC 21.3): the whole offline scenario with fake agents and a fixed seed in
// a temp data home. Prints a pass/fail table; exit 0 only if every assertion passed. The temp
// workspace and data home are deleted on success unless --keep.

import { parseArgv } from '../engine/state.mjs';

export async function run(argv) {
  const { opts } = parseArgv(argv, { flags: ['keep', 'verbose'] });
  const { runScenario } = await import('./scenarios.mjs');
  const lines = [];
  const res = await runScenario({ keep: !!opts.keep, log: opts.verbose ? (l) => process.stderr.write(l + '\n') : () => {} });
  for (const r of res.results) lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.details.replace(/\n/g, '\n      ')}`}`);
  const passed = res.results.filter((r) => r.ok).length;
  lines.push('');
  lines.push(`${passed}/${res.results.length} passed.${res.ok && !opts.keep ? ' Temp workspace removed.' : ` Temp folder: ${res.env.root}`}`);
  lines.push(res.ok ? 'NEXT: nothing; the engine works offline' : 'NEXT: fix the failing checks before any real run');
  return {
    exitCode: res.ok ? 0 : 1,
    state: null,
    payload: { ok: res.ok, results: res.results, tempRoot: res.ok && !opts.keep ? null : res.env.root },
    text: lines.join('\n'),
  };
}
