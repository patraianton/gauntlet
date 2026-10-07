// `owner <run> --kind continue|raise-limit|stop|model-opt-in --owner-quote <text> --question <text> [--set <key>=<value>]...`
// Only on the owner's own words (SPEC 10.2). Every decision is stored with the verbatim quote in
// owner-decisions.json, logged, and printed back in the report under «Что вы решили сами».
// Changes to run.json re-freeze FROZEN.json (after verifying that nothing else changed).

import { UsageError } from '../core/errors.mjs';
import { ownerWords, ownerLabel } from '../core/owner.mjs';
import { readJson, writeJsonAtomic, exists } from '../core/fsx.mjs';
import { hashJson } from '../core/hash.mjs';
import { withLock } from '../core/runstore.mjs';
import { normalizeInput } from '../core/paths.mjs';
import { writeFrozen, validateRun, MODEL_ROLES, DEFAULT_LIMITS } from '../core/config.mjs';
import { now, localDate } from '../core/clock.mjs';
import { parseArgv, openRun, log, commitState, readJsonIf, ROUND_STATES } from './state.mjs';
import { countedRounds, stopRun } from './round.mjs';

const KINDS = ['continue', 'raise-limit', 'stop', 'model-opt-in'];

function parseSet(list) {
  const out = {};
  for (const s of list || []) {
    const i = String(s).indexOf('=');
    if (i <= 0) throw new UsageError(`bad --set "${s}" (use key=value)`);
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

function addDecision(rc, entry) {
  const od = readJsonIf(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: [] });
  const id = `O${od.decisions.length + 1}`;
  const full = { id, ts: now(), ...entry };
  od.decisions.push(full);
  writeJsonAtomic(rc.paths.ownerDecisions, { schemaVersion: 1, decisions: od.decisions });
  return full;
}

function refreeze(rc) {
  if (!exists(rc.paths.frozen)) return null;
  const f = writeFrozen(rc.runDir, { repoDir: rc.ctx.repoDir });
  rc.frozen = f;
  return hashJson(f);
}

/** The only limits an owner's raise-limit may change (upward only). */
export const RAISABLE_LIMITS = Object.freeze(['maxRounds', 'maxConfirms', 'maxPanelTokens']);

export async function run(argv, ctx) {
  const { positional, opts } = parseArgv(argv, { options: ['kind', 'owner-quote', 'question'], multi: ['set'] });
  const runDir = positional[0];
  if (!runDir || !KINDS.includes(opts.kind)) throw new UsageError(`usage: owner <run> --kind ${KINDS.join('|')} --owner-quote <text> --question <text> [--set k=v]...`);
  const words = ownerWords(opts.ownerQuote, opts.question);
  const quote = words.quote;
  const question = words.question;
  const set = parseSet(opts.set);
  return withLock(normalizeInput(runDir), async () => {
    const rc = openRun(runDir, ctx, { command: 'owner' });
    const st = rc.state;
    if (['DONE', 'ABORTED'].includes(st.state)) throw new UsageError(`the run is ${st.state}; start a new run instead`);
    const lastRound = countedRounds(rc).slice(-1)[0]?.n ?? null;

    if (opts.kind === 'stop') {
      if (ROUND_STATES.includes(st.state)) {
        const d = addDecision(rc, { kind: 'stop', question, quote, round: st.round, applied: false });
        log(rc, 'owner-decision', { id: d.id, kind: 'stop', quote, pendingUntilGate: true }, st.round);
        return { exitCode: 0, state: st.state, payload: { decision: d.id }, text: `Recorded (${d.id}): the run stops at the end of the current round.\nNEXT: finish the current round with step` };
      }
      const d = addDecision(rc, { kind: 'stop', question, quote, round: null, applied: true });
      log(rc, 'owner-decision', { id: d.id, kind: 'stop', quote }, st.round ?? null);
      if (st.state === 'STOPPED') {
        commitState(rc, { lastDecision: 'STOP_OWNER', stoppedReason: 'owner asked to stop' }, 'owner-decision', { id: d.id, kind: 'stop' });
      }
      return stopRun(rc, 'STOP_OWNER', ['owner asked to stop']);
    }

    if (ROUND_STATES.includes(st.state)) throw new UsageError(`owner --kind ${opts.kind} is allowed only between rounds (now ${st.state})`);

    if (opts.kind === 'continue') {
      if (st.state !== 'STOPPED') throw new UsageError('continue resumes a stopped run; this run is not stopped');
      const d = addDecision(rc, { kind: 'continue', question, quote, afterRound: lastRound });
      const to = rc.state.frozen ? 'READY' : 'NEW';
      commitState(rc, { state: to, stoppedReason: null, pendingJobs: [] }, 'owner-decision', { id: d.id, kind: 'continue', quote, afterRound: lastRound });
      return { exitCode: 0, state: to, payload: { decision: d.id, state: to }, text: `Resumed on the owner's words (${d.id}). The plateau count starts again from the next round.\nNEXT: run step` };
    }

    const runJson = readJson(rc.paths.runJson);
    let change;
    if (opts.kind === 'raise-limit') {
      const keys = Object.keys(set);
      if (!keys.length) throw new UsageError('raise-limit needs --set limits.<name>=<number>');
      runJson.limits = { ...DEFAULT_LIMITS, ...(runJson.limits || {}) };
      change = {};
      for (const k of keys) {
        const m = /^limits\.([A-Za-z]+)$/.exec(k);
        // Only the budget limits can be raised, and only upward. plateauRounds, maxLensReruns,
        // verifierBatchMax and roundTokenEstimate are protections, frozen with the run.
        if (!m || !RAISABLE_LIMITS.includes(m[1])) throw new UsageError(`--set ${k}: only limits.<${RAISABLE_LIMITS.join('|')}> can be raised; the other limits are frozen protections`);
        const v = Number(set[k]);
        if (!Number.isInteger(v) || v < 0) throw new UsageError(`--set ${k}: must be a whole number`);
        const cur = Number(runJson.limits[m[1]]);
        if (!(v > cur)) throw new UsageError(`--set ${k}=${v}: a raise must be above the current value ${cur}`);
        change[k] = { from: runJson.limits[m[1]], to: v };
        runJson.limits[m[1]] = v;
      }
      // Limits above the defaults are valid only with the owner's recorded words (config.mjs).
      runJson.limitsOptIn = { approvedBy: ownerLabel(), quote, ...(question ? { question } : {}), date: localDate() };
    } else {
      // model-opt-in
      const role = set.role;
      const model = set.model;
      if (!MODEL_ROLES.includes(role)) throw new UsageError(`--set role=<${MODEL_ROLES.join('|')}> is required`);
      if (!model) throw new UsageError('--set model=<name> is required');
      const entry = { role, model, approvedBy: ownerLabel(), quote, ...(question ? { question } : {}), date: localDate() };
      if (set.lens) entry.lens = set.lens;
      runJson.models = { ...(runJson.models || {}), optIn: [...(runJson.models?.optIn || []), entry] };
      change = { added: entry };
    }
    const errors = validateRun(runJson, { legacyQuestions: true });
    if (errors.length) throw new UsageError('the change would make run.json invalid:\n  ' + errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n  '));
    writeJsonAtomic(rc.paths.runJson, runJson);
    const frozenSha256 = refreeze(rc);
    const d = addDecision(rc, { kind: opts.kind, question, set, quote, afterRound: lastRound });
    const resume = opts.kind === 'raise-limit' && st.state === 'STOPPED' && st.lastDecision === 'STOP_LIMIT';
    commitState(rc, resume ? { state: 'READY', stoppedReason: null } : {}, 'owner-decision', { id: d.id, kind: opts.kind, quote, change, frozenSha256 });
    return {
      exitCode: 0,
      state: rc.state.state,
      payload: { decision: d.id, change, state: rc.state.state },
      text: `Recorded (${d.id}) on the owner's words: ${JSON.stringify(change)}.${resume ? ' The run is resumed.' : ''}\nNEXT: run step`,
    };
  });
}
