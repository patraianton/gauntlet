// `abort <run> --reason <text> [--owner-quote <text> --question <text>]` (SPEC 10.2): delete review copies and job
// folders, reveal a sealed key (kept as evidence), write the report with status "aborted", state
// ABORTED. A run stopped on a plateau, a limit or an inconclusive panel, one with serious problems the
// gate still counts as open (open, unverified or contested), or one in the middle of a round, is
// aborted only on the owner's words (--owner-quote): otherwise abort + a new run would be a re-roll that
// drops problems (r2-f4, r3-f8).

import fs from 'node:fs';
import { ownerWords } from '../core/owner.mjs';
import path from 'node:path';
import { UsageError } from '../core/errors.mjs';
import { writeJsonAtomic, exists, safeRemove } from '../core/fsx.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { revealKey } from '../measure/canary.mjs';
import { now } from '../core/clock.mjs';
import { parseArgv, openRun, move, log, roundNumbers, readJsonIf, runLeftovers, needsOwnerToEnd, ROUND_STATES } from './state.mjs';
import { loadJobs, setupJobs } from './ingest.mjs';
import { writeReport, stopResultFrom } from './round.mjs';
import { unstage } from './stage.mjs';
import { revealDecoys } from './decoy-run.mjs';

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { options: ['reason', 'owner-quote', 'question'] });
  if (!positional[0] || !opts.reason) throw new UsageError('usage: abort <run> --reason <text> [--owner-quote <text> --question <text>]');
  const words = ownerWords(opts.ownerQuote, opts.question, { required: false });
  const quote = words?.quote ?? null;
  return withLock(normalizeInput(positional[0]), async () => {
    const rc = openRun(positional[0], ctx, { command: 'abort' });
    if (['DONE', 'ABORTED'].includes(rc.state.state)) throw new UsageError(`the run is already ${rc.state.state}`);
    const leftovers = runLeftovers(rc.runDir);
    if (needsOwnerToEnd(leftovers) && !quote) {
      throw new UsageError(
        `this run ${leftovers.state === 'STOPPED' ? `stopped with ${leftovers.lastDecision}` : ROUND_STATES.includes(leftovers.state) ? `is in the middle of a round (${leftovers.state})` : 'is open'}${leftovers.openSerious.length ? ` and has ${leftovers.openSerious.length} serious problem(s) still open, unverified or contested` : ''}; only the owner may end it: abort <run> --reason <text> --owner-quote "<the owner's words>" --question "<the exact question you asked the owner>"`,
      );
    }
    if (quote) {
      const od = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
      od.decisions.push({ id: `O${od.decisions.length + 1}`, ts: now(), kind: 'abort', quote, question: words?.question ?? null, openSerious: leftovers.openSerious.map((c) => c.id) });
      writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: od.decisions });
    }
    const left = [];
    const remove = (p) => {
      if (!p || !exists(p)) return;
      const res = safeRemove(p);
      if (!res.removed) left.push(...res.leftovers);
    };
    for (const n of roundNumbers(rc)) {
      const rp = rc.paths.roundDir(n);
      const r = readJsonIf(rp.roundJson, {});
      remove(r.copyDir);
      for (const j of loadJobs(rc, n)) remove(j.dir);
      if (!r.commitment && !r.revealed) unstage(rc, n);
      if (r.commitment && !r.revealed) {
        try {
          const key = revealKey(rc.dataPaths, rc.runId, n, r.commitment);
          writeJsonAtomic(rp.canaries, key);
          writeJsonAtomic(rp.roundJson, { ...r, revealed: true });
          const moved = unstage(rc, n);
          log(rc, 'canary-reveal', { commitment: r.commitment, aborted: true, canaries: key.canaries.length, unstaged: moved.length }, n);
        } catch (e) {
          left.push(`sealed key of round ${n}: ${e.message}`);
        }
      }
      try {
        revealDecoys(rc, n, { aborted: true });
      } catch (e) {
        left.push(`sealed decoy key of round ${n}: ${e.message}`);
      }
    }
    for (const j of setupJobs(rc)) remove(j.dir);
    const sealed = rc.dataPaths.sealedDir(rc.runId);
    if (exists(sealed)) for (const f of fs.readdirSync(sealed)) if (f.endsWith('.seed.json')) remove(path.join(sealed, f));
    move(rc, 'abort', { stoppedReason: String(opts.reason), pendingJobs: [] }, 'abort', { reason: opts.reason, ownerQuote: quote, openSerious: leftovers.openSerious.map((c) => c.id), leftovers: left });
    const rep = await writeReport(rc);
    const res = stopResultFrom(rc, 'ABORTED', rep);
    res.exitCode = 0;
    res.text = `Aborted: ${opts.reason}.${left.length ? ` Not removed: ${left.join(', ')}` : ''}\n${res.text}`;
    return res;
  });
}
