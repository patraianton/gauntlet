// `dispute <run> --cluster <id> --argument <text> (--evidence-cmd <exe> [--evidence-arg <a>]... | --evidence-quote <rel>::<quote>)`
// Only between rounds. The dispute verifier of the next round decides (SPEC 10.2, 12.6).

import { UsageError } from '../core/errors.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { parseArgv, openRun } from './state.mjs';
import { addDispute } from './dispute.mjs';

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { options: ['cluster', 'argument', 'evidence-cmd', 'evidence-quote'], multi: ['evidence-arg'] });
  if (!positional[0]) throw new UsageError('usage: dispute <run> --cluster <id> --argument <text> (--evidence-cmd <exe> ... | --evidence-quote <file>::<quote>)');
  return withLock(normalizeInput(positional[0]), async () => {
    const rc = openRun(positional[0], ctx, { states: ['READY', 'STOPPED'], command: 'dispute' });
    if (opts.evidenceCmd && opts.evidenceQuote) throw new UsageError('give either --evidence-cmd or --evidence-quote, not both');
    const d = addDispute(rc, {
      cluster: opts.cluster,
      argument: opts.argument,
      evidenceCmd: opts.evidenceCmd || null,
      evidenceArgs: opts.evidenceArg,
      evidenceQuote: opts.evidenceQuote || null,
    });
    return {
      exitCode: 0,
      state: rc.state.state,
      payload: { dispute: { id: d.id, cluster: d.cluster, evidenceKind: d.evidence.kind } },
      text: `Dispute ${d.id} recorded for ${d.cluster}; a fresh checker weighs it in the next round. The cluster stays open until then.\nNEXT: run step`,
    };
  });
}
