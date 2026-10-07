// `waive <run> --cluster <id>[,<id>] --owner-quote <text> --question <text>` — only on the owner's words (SPEC 10.2).
// The cluster becomes `waived`; the quote is stored and shown in the headline («Готово с вашими
// исключениями»), the summary line and section 6 of the report, never as "fixed".
// Only in STOPPED, after the stop report was written: a waiver answers a report the owner has seen,
// it is not a tool the executor uses between rounds. To waive mid-run: owner --kind stop first.

import { UsageError } from '../core/errors.mjs';
import { ownerWords } from '../core/owner.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { now } from '../core/clock.mjs';
import { writeJsonAtomic } from '../core/fsx.mjs';
import { readChained } from '../core/chain.mjs';
import { parseArgv, openRun, log, readJsonIf } from './state.mjs';

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { options: ['cluster', 'owner-quote', 'question'] });
  if (!positional[0] || !opts.cluster) throw new UsageError('usage: waive <run> --cluster <id>[,<id>] --owner-quote <text> --question <text>');
  const words = ownerWords(opts.ownerQuote, opts.question);
  const quote = words.quote;
  return withLock(normalizeInput(positional[0]), async () => {
    const rc = openRun(positional[0], ctx, { states: ['STOPPED'], command: 'waive' });
    const lines = readChained(rc.paths.ledger);
    let lastNotStopped = -1;
    lines.forEach((l, i) => {
      if (l.data?.stateAfter && l.data.stateAfter.state !== 'STOPPED') lastNotStopped = i;
    });
    if (!lines.slice(lastNotStopped + 1).some((l) => l.type === 'report')) {
      throw new UsageError('waive answers the stop report: write it first (report <run>) and show it to the owner');
    }
    const ids = String(opts.cluster).split(',').map((s) => s.trim()).filter(Boolean);
    const file = readJsonIf(rc.paths.clusters, { schemaVersion: 1, clusters: [] });
    for (const id of ids) {
      const c = file.clusters.find((x) => x.id === id);
      if (!c) throw new UsageError(`no cluster ${id}`);
      if (['closed', 'dropped', 'waived'].includes(c.status)) throw new UsageError(`cluster ${id} is already ${c.status}`);
    }
    const round = rc.state.round ?? null;
    file.clusters = file.clusters.map((c) =>
      ids.includes(c.id)
        ? { ...c, status: 'waived', waived: true, history: [...(c.history || []), { round, from: c.status, to: 'waived', why: `owner: ${quote}` }] }
        : c,
    );
    writeJsonAtomic(rc.paths.clusters, { schemaVersion: 1, clusters: file.clusters });
    const od = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
    const id = `O${od.decisions.length + 1}`;
    od.decisions.push({ id, ts: now(), kind: 'waive', clusters: ids, quote, question: words.question, afterRound: round });
    writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: od.decisions });
    log(rc, 'waive', { id, clusters: ids, quote }, round);
    return { exitCode: 0, state: rc.state.state, payload: { decision: id, clusters: ids }, text: `Waived ${ids.join(', ')} on the owner's words (${id}). The report lists this under the owner's decisions.\nNEXT: run step` };
  });
}
