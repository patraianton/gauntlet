// `step <run> [--usage <job>=<tokens>,...] [--usage-delta <n> --driver workflow]
//             [--usage-total <n> [--usage-first] --driver workflow  (legacy)]
//             [--answer-hash <job>=<code>,...] [--give-up <job>,...|missing] [--same-material]
//             [--no-sources] [--owner-quote "<owner's words>" --question "<what you asked>"]`  (SPEC 10.2, 11)
//
// --answer-hash: the code each agent replied with ("DONE <code>"); an answer whose sha256 does not
//   start with it is rejected (answer-hash-mismatch). The Workflow driver always passes it.
// --usage-delta: tokens the Workflow driver's own agents spent since its last report (measured around
//   each batch, never the turn total).
// --usage-first (legacy): this --usage-total is the first report of a new Workflow invocation (its budget
//   counter started at 0), so the whole total is new spending.
// --owner-quote: before freeze only — the owner's words approving strip rules that remove material
//   which is not a review trace (the preview lists them). --question is always required with it: the
//   exact question he answered.

import { UsageError } from '../core/errors.mjs';
import { parseArgv } from './state.mjs';
import { step } from './step.mjs';

/** Parse "--answer-hash a=1f2e,b=..." into { a: '1f2e...' } (hex, at least 12 characters). */
export function parseAnswerHashes(list) {
  const out = {};
  for (const part of (list || []).flatMap((g) => String(g).split(','))) {
    const t = part.trim();
    if (!t) continue;
    const m = /^([a-z2-9]{8})\s*=\s*([0-9a-f]{12,64})$/i.exec(t);
    if (!m) throw new UsageError(`bad --answer-hash entry "${t}" (expected <job>=<code>, the code the agent replied after DONE)`);
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, {
    flags: ['same-material', 'no-sources', 'usage-first'],
    options: ['usage', 'usage-delta', 'usage-total', 'driver', 'owner-quote', 'question'],
    multi: ['give-up', 'answer-hash'],
  });
  if (!positional[0]) throw new UsageError('usage: step <run> [options]');
  if (opts.driver && !['agent', 'workflow'].includes(opts.driver)) throw new UsageError('--driver must be agent or workflow');
  const giveUp = opts.giveUp.flatMap((g) => String(g).split(',')).map((s) => s.trim()).filter(Boolean);
  return step(positional[0], {
    ctx,
    usage: opts.usage || null,
    usageDelta: opts.usageDelta != null ? Number(opts.usageDelta) : null,
    usageTotal: opts.usageTotal != null ? Number(opts.usageTotal) : null,
    usageFirst: !!opts.usageFirst,
    driver: opts.driver || null,
    giveUp,
    answerHashes: parseAnswerHashes(opts.answerHash),
    sameMaterial: !!opts.sameMaterial,
    noSources: !!opts.noSources,
    ownerQuote: opts.ownerQuote ?? null,
    question: opts.question ?? null,
  });
}
