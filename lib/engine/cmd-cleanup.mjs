// `cleanup <run>` (SPEC 10.2): only in DONE / STOPPED / ABORTED after the report. Deletes leftover
// review-base folders of the run and every snapshot except the best, the last and the done one.
// Folders that contain a junction or symlink are refused and listed.

import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { exists, safeRemove, readJson } from '../core/fsx.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { parseArgv, openRun, log, roundNumbers, readJsonIf } from './state.mjs';
import { loadJobs, setupJobs } from './ingest.mjs';

export async function run(argv, ctx) {
  const { positional } = parseArgv(argv, {});
  if (!positional[0]) throw new UsageError('usage: cleanup <run>');
  return withLock(normalizeInput(positional[0]), async () => {
    const rc = openRun(positional[0], ctx, { states: ['DONE', 'STOPPED', 'ABORTED'], command: 'cleanup' });
    if (!exists(rc.paths.report)) throw new UsageError('write the report first (report <run>)');
    const removed = [];
    const refused = [];
    const tryRemove = (p) => {
      if (!p || !exists(p)) return;
      const r = safeRemove(p);
      if (r.removed) removed.push(p);
      else refused.push(...(r.refused.length ? r.refused : r.leftovers));
    };
    for (const j of setupJobs(rc)) tryRemove(j.dir);
    const rounds = roundNumbers(rc);
    const keep = new Set();
    if (exists(rc.paths.best)) keep.add(readJson(rc.paths.best).round);
    if (rounds.length) keep.add(rounds[rounds.length - 1]);
    if (exists(rc.paths.done)) keep.add(readJson(rc.paths.done).round);
    for (const n of rounds) {
      const r = readJsonIf(rc.paths.roundDir(n).roundJson, {});
      tryRemove(r.copyDir);
      for (const j of loadJobs(rc, n)) tryRemove(j.dir);
      if (!keep.has(n)) tryRemove(rc.paths.roundDir(n).snapshot);
    }
    log(rc, 'cleanup', { removed: removed.map((p) => path.relative(rc.runDir, p).replace(/\\/g, '/')), refused, kept: [...keep] });
    const lines = [`Removed ${removed.length} folder(s); kept snapshots of rounds ${[...keep].join(', ') || '(none)'}.`];
    if (refused.length) lines.push(`Refused (they contain a junction or symlink; remove by hand with care): ${refused.join(', ')}`);
    lines.push('', 'NEXT: nothing');
    return { exitCode: 0, state: rc.state.state, payload: { removed, refused, kept: [...keep] }, text: lines.join('\n') };
  });
}
