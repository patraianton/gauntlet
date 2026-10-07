// `status <run>` (SPEC 10.2): state, round, decisions so far, open counts per round, tokens,
// best round, next action; after DONE, any later change of the live files is shown as
// UNREVIEWED CHANGES (failure point 15: detection, not prevention).

import { exists, readJson } from '../core/fsx.mjs';
import { buildManifest } from '../material/manifest.mjs';
import { parseArgv, openRun, roundNumbers, readJsonIf } from './state.mjs';
import { tokenSummary } from './round.mjs';
import { manifestDiff } from './done.mjs';

const NEXT = {
  NEW: 'run step (after task set and the settings files)',
  AWAIT_LENS_WRITER: 'spawn the printed call, then step',
  READY: 'run step',
  AWAIT_PLANTER: 'spawn the printed calls, then step',
  AWAIT_VALIDATOR: 'spawn the printed calls, then step',
  AWAIT_REVIEWERS: 'spawn the printed calls, then step',
  AWAIT_MATCHER: 'spawn the printed calls, then step',
  AWAIT_VERIFY: 'spawn the printed calls, then step',
  AWAIT_VERIFY2: 'spawn the printed calls, then step',
  STOPPED: 'show the owner report --summary; wait for the owner\'s word',
  DONE: 'nothing',
  ABORTED: 'nothing',
};

export async function run(argv, ctx) {
  const { positional } = parseArgv(argv, {});
  const rc = openRun(positional[0], ctx, { command: 'status' });
  const st = rc.state;
  const rounds = [];
  for (const n of roundNumbers(rc)) {
    const g = readJsonIf(rc.paths.roundDir(n).gate, null);
    const r = readJsonIf(rc.paths.roundDir(n).roundJson, null);
    rounds.push({
      round: n,
      kind: r?.kind ?? null,
      decision: g?.decision ?? '(running)',
      // BLOCKED_* = an attempt that never reached the reviewers: it holds a folder number but is not a round
      notARound: g?.decision === 'BLOCKED_PRECHECK' || g?.decision === 'BLOCKED_TRACE',
      openBlockers: g?.open?.blocker ?? null,
      openMajors: g?.open?.major ?? null,
      versionHash: r?.versionHash ?? null,
    });
  }
  const t = tokenSummary(rc);
  let unreviewed = [];
  if (exists(rc.paths.done)) {
    const d = readJson(rc.paths.done);
    const live = buildManifest(rc.run, { countsFor: [] });
    if (live.versionHash !== d.finalVersionHash) {
      const reviewed = readJsonIf(rc.paths.roundDir(d.round).manifest, null);
      unreviewed = manifestDiff(reviewed, live).map((c) => `${c.rel} (${c.change})`);
      if (!unreviewed.length) unreviewed = ['(the material changed)'];
    }
  } else if (st.lastDecision === 'DONE' && st.stoppedReason && st.stoppedReason.startsWith('edited-after-review')) {
    unreviewed = st.stoppedReason.replace(/^edited-after-review:\s*/, '').split(', ');
  }
  const lines = [
    `Run ${rc.runId} (${rc.run.project}, ${rc.run.artifactType})`,
    `State: ${st.state}${st.round ? `, round ${st.round} (${st.roundKind})` : ''}${st.lastDecision ? `, last decision ${st.lastDecision}` : ''}`,
  ];
  if (st.stoppedReason) lines.push(`Stopped because: ${st.stoppedReason}`);
  for (const r of rounds) {
    if (r.notARound) lines.push(`  attempt ${r.round} (not a round, no reviewer ran): ${r.decision}`);
    else lines.push(`  round ${r.round} ${r.kind || ''}: ${r.decision}${r.openBlockers != null ? ` — open blockers ${r.openBlockers}, majors ${r.openMajors}` : ''}`);
  }
  const blockedN = rounds.filter((r) => r.notARound).length;
  if (blockedN) lines.push(`Rounds held: ${rounds.length - blockedN}; blocked attempts (not counted anywhere): ${blockedN}`);
  lines.push(`Panel tokens: ${t.spent} (${t.estimatedJobs} job(s) estimated${t.suspectRecords ? `, ${t.suspectRecords} record(s) SUSPECT: implausibly large, may include non-panel work` : ''}); next round estimate ${t.nextEstimate}; budget ${rc.run.limits.maxPanelTokens}`);
  if (st.best) lines.push(`Best round: ${st.best.round} (blockers ${st.best.blockers}, majors ${st.best.majors})${st.best.lensesValid === false ? ' - not every lens passed its attention check in that round' : ''}`);
  if (unreviewed.length) lines.push(`UNREVIEWED CHANGES: ${unreviewed.join(', ')}`);
  for (const w of rc.warnings) lines.push(`Warning: ${w}`);
  lines.push('');
  lines.push(`NEXT: ${NEXT[st.state] || 'run step'}`);
  return {
    exitCode: 0,
    state: st.state,
    payload: { state: st.state, round: st.round, roundKind: st.roundKind, lastDecision: st.lastDecision, rounds, tokens: t, best: st.best, unreviewedChanges: unreviewed },
    text: lines.join('\n'),
  };
}
