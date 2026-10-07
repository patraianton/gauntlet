// `step` — the one state machine both drivers call (SPEC 11, D1).
//
// Each call takes the run lock (<run>/.lock: a live holder younger than two hours is refused,
// exit 4; a stale lock is taken over and logged), verifies integrity, applies token usage,
// then does every deterministic job it can and returns exactly one of:
//   exit 10 — agent calls to spawn, exit 20 — the executor's to-do, exit 30 — stopped (report written),
//   exit 0 — nothing waiting.
// Running it again in a waiting state reprints the same calls (idempotent).

import { UsageError } from '../core/errors.mjs';
import { appendChained, readChained } from '../core/chain.mjs';
import { exists } from '../core/fsx.mjs';
import { withLock } from '../core/runstore.mjs';
import { openRun, log, commitState, ROUND_STATES, readJsonIf } from './state.mjs';
import { issueLensWriter, ingestLensWriter } from './setup.mjs';
import { loadJobs, setupJobs } from './ingest.mjs';
import {
  startRound,
  afterPlanter,
  afterValidator,
  afterReviewers,
  afterMatcher,
  afterVerify,
  stopRun,
  stopResultFrom,
  writeReport,
  tokenSummary,
  todoResult,
} from './round.mjs';
import { latestTodo } from './cmd-todo.mjs';

/** Parse "--usage a=1,b=2" into { a: 1, b: 2 }. */
export function parseUsage(s) {
  const out = {};
  if (!s) return out;
  for (const part of String(s).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^([a-z2-9]{8})\s*=\s*(\d+)$/.exec(t);
    if (!m) throw new UsageError(`bad --usage entry "${t}" (expected <job>=<tokens>)`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function usageLines(rc) {
  return exists(rc.paths.usage) ? readChained(rc.paths.usage) : [];
}

function jobRecord(rc, job) {
  const n = rc.state.round;
  if (n) {
    const j = loadJobs(rc, n).find((x) => x.job === job);
    if (j) return { ...j, round: n };
  }
  const s = setupJobs(rc).find((x) => x.job === job);
  return s ? { ...s, round: null } : null;
}

/** A reported per-agent token count below this is never believed: the job is booked at the estimate. */
export const MIN_BELIEVED_JOB_TOKENS = 1000;
/**
 * Nor is one below this fraction of the per-job estimate (r3-f7): a real agent reading the material
 * spends a sizeable share of it, so "1000 tokens per agent" cannot switch the token stop off.
 */
export const MIN_BELIEVED_FRACTION = 0.25;

/** A usage record larger than this many round estimates is flagged `suspect` (never trusted silently). */
export const SUSPECT_FACTOR = 2;

/** Book one Workflow-budget line; flag it `suspect` when it is implausibly large for one report. */
function bookWorkflowLine(rc, fields) {
  const est = rc.run.limits.roundTokenEstimate;
  const suspect = Number.isFinite(est) && est > 0 && fields.tokens > SUSPECT_FACTOR * est;
  const line = appendChained(rc.paths.usage, { job: null, role: 'workflow', round: rc.state.round ?? null, estimated: false, ...fields, ...(suspect ? { suspect: true } : {}) });
  if (suspect) {
    rc.warnings.push(`a single usage record of ${fields.tokens} tokens is more than ${SUSPECT_FACTOR} x the round estimate (${est}); marked suspect: it may include work that is not the panel's`);
  }
  return line;
}

/**
 * Apply --usage / --usage-delta / --usage-total (SPEC 11 preamble). Agent mode: tokens per job of the last spawn;
 * jobs without numbers, or with a number below max(MIN_BELIEVED_JOB_TOKENS, MIN_BELIEVED_FRACTION x
 * the per-job estimate), get roundTokenEstimate / (jobs per round) flagged estimated, once. Workflow mode is decided by THIS call's --driver
 * workflow only (never by run.json): --usage-delta is the tokens the driver's own agents spent since
 * its last report (one line); the legacy --usage-total is the turn's whole counter (a difference to the
 * last recorded total). Either without --driver workflow is refused (r2-f6).
 */
export function applyUsage(rc, opts) {
  const lines = usageLines(rc);
  const recorded = new Set(lines.filter((l) => l.job).map((l) => l.job));
  const added = [];
  const workflow = opts.driver === 'workflow';
  if ((opts.usageTotal != null || opts.usageDelta != null) && !workflow) {
    throw new UsageError('--usage-delta / --usage-total are the Workflow budget and are accepted only with --driver workflow (Agent mode reports --usage <job>=<tokens>)');
  }
  if (opts.usageTotal != null && opts.usageDelta != null) {
    throw new UsageError('give either --usage-delta or the legacy --usage-total, not both');
  }
  if (opts.usageDelta != null) {
    // The driver measures budget.spent() around its own agent batches and clerk calls and reports only
    // that sum (tokens its own agents spent since the last report). The window's other work in the same
    // turn is never in it (docs/measurement.md).
    const delta = Number(opts.usageDelta);
    if (!Number.isFinite(delta) || delta < 0) throw new UsageError('--usage-delta must be a non-negative number');
    added.push(bookWorkflowLine(rc, { tokens: Math.round(delta), source: 'workflow-budget', delta: true }));
  }
  if (opts.usageTotal != null) {
    const total = Number(opts.usageTotal);
    if (!Number.isFinite(total) || total < 0) throw new UsageError('--usage-total must be a non-negative number');
    // LEGACY (kept so that old drivers and recorded runs still work). budget.spent() is the whole
    // turn's counter, window's own coding included, so a total booked this way can swallow work
    // that is not the panel's (night of 06-07.10.2026): new drivers send --usage-delta instead.
    // budget.spent() of the Workflow runtime starts at 0 in every invocation. The driver marks the
    // first report of an invocation (--usage-first): its whole total is new spending. A total below
    // the last one without the mark is treated the same way (an older driver) and flagged.
    let last = 0;
    for (const l of lines) if (l.source === 'workflow-budget' && Number.isFinite(l.total)) last = l.total;
    const restarted = !!opts.usageFirst || total < last;
    const delta = restarted ? total : total - last;
    added.push(bookWorkflowLine(rc, { tokens: delta, source: 'workflow-budget', total, ...(restarted ? { invocationStart: true } : {}) }));
    rc.warnings.push('--usage-total is the legacy whole-turn counter and can include the own work of the window; the Workflow driver now reports --usage-delta');
    if (!opts.usageFirst && total < last) rc.warnings.push(`the Workflow token total went down (${last} -> ${total}); counted as a new invocation`);
  }
  const usage = parseUsage(opts.usage);
  const pending = rc.state.pendingJobs || [];
  const lensCount = (readJsonIf(rc.paths.lenses, null)?.lenses || []).length || 5;
  const perJobEstimate = Math.round(rc.run.limits.roundTokenEstimate / Math.max(1, lensCount + 4));
  const floor = Math.max(MIN_BELIEVED_JOB_TOKENS, Math.round(perJobEstimate * MIN_BELIEVED_FRACTION));
  for (const [job, tokens] of Object.entries(usage)) {
    if (recorded.has(job)) continue;
    const rec = jobRecord(rc, job);
    if (!rec) throw new UsageError(`--usage names an unknown job ${job}`);
    if (!workflow && tokens < floor) {
      // Self-reported numbers steer the token stop: an implausibly small one is booked at the estimate.
      added.push(appendChained(rc.paths.usage, { job, role: rec.role, round: rec.round, tokens: perJobEstimate, estimated: true, source: 'estimate', reportedTokens: tokens }));
      rc.warnings.push(`--usage ${job}=${tokens} is below ${floor} tokens (a quarter of the per-agent estimate); booked at the estimate ${perJobEstimate} instead`);
    } else {
      added.push(appendChained(rc.paths.usage, { job, role: rec.role, round: rec.round, tokens, estimated: false, source: 'agent-usage' }));
    }
    recorded.add(job);
  }
  if (!workflow) {
    // Jobs of the last spawn that have an answer (or were given up) but no numbers: estimate once.
    for (const job of pending) {
      if (recorded.has(job)) continue;
      const rec = jobRecord(rc, job);
      if (!rec) continue;
      const answered = rec.status === 'answered' || rec.status === 'given-up' || (rec.dir && exists(`${rec.dir}/answer.json`));
      if (!answered) continue;
      added.push(appendChained(rc.paths.usage, { job, role: rec.role, round: rec.round, tokens: perJobEstimate, estimated: true, source: 'estimate' }));
      recorded.add(job);
    }
  }
  if (added.length) {
    const t = tokenSummary(rc);
    commitState(
      rc,
      { tokens: { spent: t.spent, estimatedJobs: t.estimatedJobs, measuredRounds: t.measuredRounds, suspectRecords: t.suspectRecords } },
      'usage',
      { lines: added.length, tokens: added.reduce((a, l) => a + (Number(l.tokens) || 0), 0), estimated: added.filter((l) => l.estimated).length, ...(added.some((l) => l.suspect) ? { suspect: added.filter((l) => l.suspect).length } : {}) },
      rc.state.round ?? null,
    );
  }
  return added.length;
}

async function dispatch(rc, opts) {
  for (let guard = 0; guard < 50; guard++) {
    const s = rc.state.state;
    let res;
    switch (s) {
      case 'NEW':
        res = issueLensWriter(rc, opts);
        break;
      case 'AWAIT_LENS_WRITER':
        res = ingestLensWriter(rc, opts);
        if (res && res.stop) return stopRun(rc, res.decision, [`reason: ${res.reason}`, ...(res.errors || []).slice(0, 10)]);
        break;
      case 'READY':
        res = await startRound(rc, opts);
        break;
      case 'AWAIT_PLANTER':
        res = await afterPlanter(rc, opts);
        break;
      case 'AWAIT_VALIDATOR':
        res = await afterValidator(rc, opts);
        break;
      case 'AWAIT_REVIEWERS':
        res = await afterReviewers(rc, opts);
        break;
      case 'AWAIT_MATCHER':
        res = await afterMatcher(rc, opts);
        break;
      case 'AWAIT_VERIFY':
      case 'AWAIT_VERIFY2':
        res = await afterVerify(rc, opts);
        break;
      case 'STOPPED': {
        if (rc.state.lastDecision === 'DONE' && String(rc.state.stoppedReason || '').startsWith('edited-after-review')) {
          const rep = exists(rc.paths.report) ? { reportPath: rc.paths.report, summaryRu: await summaryOf(rc) } : await writeReport(rc);
          const res = stopResultFrom(rc, 'DONE', rep);
          res.text = `The live files changed after the confirm round: ${rc.state.stoppedReason.replace(/^edited-after-review:\s*/, '')}.\n` +
            'Either put the reviewed files back and run done, or, on the owner\'s word, run owner --kind continue to review the new version.\n' + res.text;
          return res;
        }
        if (rc.state.lastDecision === 'DONE') {
          return todoResult(rc, { decision: 'DONE', todoPath: latestTodo(rc), items: ['The confirm round was clean. Change nothing.'], summary: 'done (pending the live-file check)', next: 'run done' });
        }
        const rep = exists(rc.paths.report) ? { reportPath: rc.paths.report, summaryRu: await summaryOf(rc) } : await writeReport(rc);
        return stopResultFrom(rc, rc.state.lastDecision || 'STOPPED', rep);
      }
      case 'DONE':
        return { exitCode: 0, state: 'DONE', payload: { state: 'DONE' }, text: 'The run is done.\nNEXT: nothing; show the owner the report if they have not seen it.' };
      case 'ABORTED':
        return { exitCode: 0, state: 'ABORTED', payload: { state: 'ABORTED' }, text: 'The run was aborted.\nNEXT: nothing.' };
      default:
        throw new UsageError(`unknown state ${s}`);
    }
    if (res && res.next) continue;
    return res;
  }
  throw new Error('step did not settle after 50 internal transitions');
}

async function summaryOf(rc) {
  try {
    const rep = await import('../report/report-ru.mjs');
    return rep.summaryLines(rc.runDir, { dataPaths: rc.dataPaths }) || [];
  } catch {
    return [];
  }
}

/**
 * step(runDir, opts) -> { exitCode, state, payload, text }
 * opts: { ctx, usage, usageTotal, driver, giveUp: [job|'missing'], sameMaterial, noSources }
 */
export async function step(runDir, opts = {}) {
  const ctx = opts.ctx || {};
  // Integrity first (fails closed before the lock is even taken).
  openRun(runDir, ctx, { command: 'step' });
  return withLock(runDir, async ({ takenOver }) => {
    const rc = openRun(runDir, ctx, { command: 'step' });
    rc.answerHashes = opts.answerHashes || {};
    if (takenOver) log(rc, 'cleanup', { what: 'stale-lock', takenOver }, rc.state.round ?? null);
    if (rc.state.state === 'ABORTED' || rc.state.state === 'DONE') return dispatch(rc, opts);
    // One rule for Workflow mode: the owner's opt-in recorded in run.json before freeze.
    if (opts.driver === 'workflow' && rc.run.driver?.mode !== 'workflow') {
      throw new UsageError('--driver workflow needs the owner\'s recorded opt-in: run.json driver.mode "workflow" with driver.workflowOptIn { approvedBy: "<owner label>", quote, question, date }, written before freeze. Without it, drive the run with agents (Agent mode).');
    }
    applyUsage(rc, opts);
    if (opts.giveUp && opts.giveUp.length && !ROUND_STATES.includes(rc.state.state) && rc.state.state !== 'AWAIT_LENS_WRITER') {
      throw new UsageError('--give-up is only meaningful while agents are awaited');
    }
    const res = await dispatch(rc, opts);
    if (rc.warnings.length) res.text = `${res.text}\n\nWarnings:\n${rc.warnings.map((w) => `- ${w}`).join('\n')}`;
    return res;
  });
}
