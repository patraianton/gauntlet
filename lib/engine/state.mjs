// The run state machine (SPEC 9.7, 11) and the run context every engine command uses.
//
// state.json is a cache; the ledger is the truth. Every state change is written as a ledger event
// carrying `stateAfter` (the whole state object). On every command the cache is compared with the
// last `stateAfter` in the chain and, if they differ, the cache is restored from the ledger.
// So editing state.json changes nothing, and `audit` can rebuild the state from the ledger.

import fs from 'node:fs';
import { isOpenCluster } from './gate.mjs';
import path from 'node:path';
import { StateError, UsageError, IntegrityError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, readText, exists } from '../core/fsx.mjs';
import { hashJson, sha256Hex } from '../core/hash.mjs';
import { readChained, appendChained } from '../core/chain.mjs';
import { dataPaths as defaultDataPaths } from '../core/datahome.mjs';
import { runPaths, recordEvent, verifyRunIntegrity, readState, writeState, checkGuard, guardFileMap, expectedGuardMap, guardDiff, heldToken, setLockHooks, markGuardRecovered } from '../core/runstore.mjs';
import { loadRun, assertFrozen } from '../core/config.mjs';
import { makeRng, seededFromEnv, deriveSeed } from '../core/rand.mjs';
import { normalizeInput } from '../core/paths.mjs';

export const STATES = Object.freeze([
  'NEW',
  'AWAIT_LENS_WRITER',
  'READY',
  'AWAIT_PLANTER',
  'AWAIT_VALIDATOR',
  'AWAIT_REVIEWERS',
  'AWAIT_MATCHER',
  'AWAIT_VERIFY',
  'AWAIT_VERIFY2',
  'STOPPED',
  'DONE',
  'ABORTED',
]);

export const ROUND_STATES = Object.freeze([
  'AWAIT_PLANTER',
  'AWAIT_VALIDATOR',
  'AWAIT_REVIEWERS',
  'AWAIT_MATCHER',
  'AWAIT_VERIFY',
  'AWAIT_VERIFY2',
]);

export const TERMINAL_STATES = Object.freeze(['DONE', 'ABORTED']);

const ANY_LIVE = STATES.filter((s) => !TERMINAL_STATES.includes(s));

/** Legal moves: event -> { from: [states], to: state }. */
export const TRANSITIONS = Object.freeze({
  'issue-lens-writer': { from: ['NEW', 'AWAIT_LENS_WRITER'], to: 'AWAIT_LENS_WRITER' },
  freeze: { from: ['AWAIT_LENS_WRITER'], to: 'READY' },
  'reset-setup': { from: ['AWAIT_LENS_WRITER', 'STOPPED'], to: 'NEW' },
  'start-round': { from: ['READY'], to: 'AWAIT_PLANTER' },
  'fixed-key': { from: ['READY'], to: 'AWAIT_REVIEWERS' },
  'round-blocked': { from: ['READY'], to: 'READY' },
  'planter-ingested': { from: ['AWAIT_PLANTER'], to: 'AWAIT_VALIDATOR' },
  'reissue-planter': { from: ['AWAIT_PLANTER', 'AWAIT_VALIDATOR'], to: 'AWAIT_PLANTER' },
  'validator-ingested': { from: ['AWAIT_VALIDATOR', 'AWAIT_PLANTER'], to: 'AWAIT_REVIEWERS' },
  'reissue-validator': { from: ['AWAIT_VALIDATOR'], to: 'AWAIT_VALIDATOR' },
  'need-matcher': { from: ['AWAIT_REVIEWERS'], to: 'AWAIT_MATCHER' },
  rerun: { from: ['AWAIT_REVIEWERS', 'AWAIT_MATCHER'], to: 'AWAIT_REVIEWERS' },
  verify: { from: ['AWAIT_REVIEWERS', 'AWAIT_MATCHER'], to: 'AWAIT_VERIFY' },
  verify2: { from: ['AWAIT_VERIFY'], to: 'AWAIT_VERIFY2' },
  'round-continue': { from: ['AWAIT_REVIEWERS', 'AWAIT_MATCHER', 'AWAIT_VERIFY', 'AWAIT_VERIFY2', 'AWAIT_PLANTER', 'AWAIT_VALIDATOR'], to: 'READY' },
  stop: { from: ANY_LIVE, to: 'STOPPED' },
  resume: { from: ['STOPPED'], to: 'READY' },
  done: { from: ['STOPPED', 'DONE'], to: 'DONE' },
  'done-mismatch': { from: ['STOPPED', 'DONE'], to: 'STOPPED' },
  abort: { from: ANY_LIVE, to: 'ABORTED' },
});

/** transition(state, event) -> next state; throws StateError on an illegal move. */
export function transition(state, event) {
  const t = TRANSITIONS[event];
  if (!t) throw new StateError(`unknown state event: ${event}`);
  if (!STATES.includes(state)) throw new StateError(`unknown state: ${state}`);
  if (!t.from.includes(state)) throw new StateError(`cannot ${event} in state ${state}`);
  return t.to;
}

export function initialState() {
  return {
    schemaVersion: 1,
    state: 'NEW',
    round: null,
    roundKind: null,
    lastDecision: null,
    candidate: null,
    confirmsDone: 0,
    best: null,
    tokens: { spent: 0, estimatedJobs: 0, measuredRounds: [] },
    pendingJobs: [],
    frozen: false,
    stoppedReason: null,
  };
}

// ---------------------------------------------------------------- run context

/** Lines of a text with a trailing newline removed (LF or CRLF). */
export function textLines(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const parts = t.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** TASK.md must be OWNER-TASK.md (without its Source line) with whole lines deleted only (D18). */
export function taskIsSubsequence(ownerText, taskText) {
  const owner = textLines(ownerText);
  if (owner.length && /^Source: /.test(owner[owner.length - 1])) owner.pop();
  const task = textLines(taskText);
  let i = 0;
  for (const line of task) {
    while (i < owner.length && owner[i] !== line) i++;
    if (i >= owner.length) return false;
    i++;
  }
  return true;
}

function lastStateAfter(ledgerFile) {
  const lines = readChained(ledgerFile);
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i].data;
    if (d && d.stateAfter && typeof d.stateAfter === 'object') return { line: lines[i], state: d.stateAfter };
  }
  return null;
}

/**
 * openRun(runDir, ctx, opts) -> rc
 * Verifies the ledger chain + anchor (TAMPER), TASK.md vs OWNER-TASK.md (TAMPER), FROZEN.json
 * after freeze (FROZEN_MISMATCH), restores state.json from the ledger if it was changed.
 * opts: { states?: [allowed states], command?, tolerateToolDrift? }
 */
export function openRun(runDir, ctx = {}, opts = {}) {
  if (!runDir) throw new UsageError('the run folder is required');
  const dir = normalizeInput(runDir);
  const paths = runPaths(dir);
  if (!exists(paths.runJson)) throw new UsageError(`not a run folder (no run.json): ${dir}`);
  const dp = ctx.dataPaths ?? defaultDataPaths(ctx.dataHome);
  verifyRunIntegrity(dir, { dataPaths: dp });

  if (exists(paths.task)) {
    if (!exists(paths.ownerTask)) throw new IntegrityError('TAMPER', 'TASK.md exists without OWNER-TASK.md');
    if (!taskIsSubsequence(readText(paths.ownerTask), readText(paths.task))) {
      throw new IntegrityError('TAMPER', 'TASK.md is not OWNER-TASK.md with whole lines deleted; run `task set` again (before freeze) or `amend --what task`');
    }
    // The last event that set the task: `task set`, or `amend --what task`.
    const ref = (() => {
      const lines = readChained(paths.ledger);
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (l.type === 'task-set' || (l.type === 'amend' && l.data && l.data.what === 'task')) return l;
      }
      return null;
    })();
    if (ref && ref.data && ref.data.taskSha256) {
      const now = sha256Hex(fs.readFileSync(paths.task));
      if (now !== ref.data.taskSha256) throw new IntegrityError('TAMPER', 'TASK.md changed after it was set; run `task set` again (before freeze) or `amend --what task`');
    }
    if (ref && ref.data && ref.data.ownerTaskSha256) {
      const now = sha256Hex(fs.readFileSync(paths.ownerTask));
      if (now !== ref.data.ownerTaskSha256) throw new IntegrityError('TAMPER', 'OWNER-TASK.md changed after it was set');
    }
  }

  const frozenExists = exists(paths.frozen);
  // A read-only command (audit, report) may open a run frozen by another version of the program; it then
  // gets `rc.toolDrift` and must say what it could not compare. Every other command refuses (FROZEN_MISMATCH).
  const frozenCheck = frozenExists ? assertFrozen(dir, { repoDir: ctx.repoDir, tolerateToolDrift: !!opts.tolerateToolDrift }) : null;
  const run = loadRun(dir);
  const warnings = [];

  // Guard: engine-written decision files must equal what the ledger recorded at the end of the
  // last command (clusters, disputes, owner decisions, round files, ingest records). Checked once per
  // command: a later openRun inside the same lock (audit, report) would see this command's own writes.
  const ownWrites = heldToken(dir) && openedInLock.has(lockKey(dir));
  const guard = ownWrites ? { status: 'ok', changed: {} } : checkGuard(dir, readChained(paths.ledger));
  if (guard.status === 'tamper') {
    const list = Object.keys(guard.changed);
    throw new IntegrityError('TAMPER', `run files changed outside gauntlet since the last command: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', ...' : ''}`, { changed: guard.changed });
  }
  // FROZEN.json itself must be the one the last freeze / amend / owner decision recorded: a
  // recomputed FROZEN.json (after editing lenses.json, run.json limits, sources, strip, TASK)
  // would otherwise pass assertFrozen. Same check as audit item 5, now on every command.
  if (frozenExists && guard.status === 'ok' && !ownWrites) {
    const ledgerLines = readChained(paths.ledger);
    const ev = [...ledgerLines].reverse().find((l) => ['freeze', 'amend', 'owner-decision'].includes(l.type) && l.data?.frozenSha256);
    if (ev && ev.data.frozenSha256 !== hashJson(readJson(paths.frozen))) {
      throw new IntegrityError('TAMPER', 'FROZEN.json differs from the one recorded by the last freeze/amend/owner decision: frozen settings were changed and FROZEN.json recomputed outside gauntlet');
    }
  }
  if (guard.status === 'busy') warnings.push('another command holds this run; its files were not checked');
  if (guard.status === 'interrupted' && !heldToken(dir)) warnings.push('the previous command did not finish; the next command that takes the run lock records what it wrote');

  // State: the ledger is the truth.
  let state = readState(dir);
  const fromLedger = lastStateAfter(paths.ledger);
  if (fromLedger) {
    if (!state || hashJson(state) !== hashJson(fromLedger.state)) {
      state = structuredClone(fromLedger.state);
      writeState(dir, state);
      warnings.push('state.json differed from the ledger and was restored from it');
    }
  } else if (!state) {
    state = initialState();
  }

  if (opts.states && !opts.states.includes(state.state)) {
    throw new UsageError(`${opts.command || 'this command'} is not allowed in state ${state.state} (allowed: ${opts.states.join(', ')})`);
  }

  const rc = {
    runDir: dir,
    paths,
    run,
    runId: run.runId,
    state,
    dataPaths: dp,
    ctx,
    frozen: frozenExists ? readJson(paths.frozen) : null,
    toolDrift: frozenCheck?.toolDrift ?? null,
    warnings,
  };
  if (guard.status === 'interrupted' && heldToken(dir)) {
    const changed = guard.changed;
    if (Object.keys(changed).length) {
      log(rc, 'guard', { changed, sha256: hashJson(guard.current), recovered: true });
      warnings.push(`the previous command did not finish; ${Object.keys(changed).length} run file(s) it may have written were accepted and recorded (audit lists them)`);
    }
    markGuardRecovered(dir);
  }
  if (heldToken(dir)) openedInLock.set(lockKey(dir), rc);
  return rc;
}

// ---------------------------------------------------------------- guard sealing

const openedInLock = new Map(); // run folder -> rc opened while this process holds its lock

function lockKey(dir) {
  const r = path.resolve(dir);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Log a `guard` event with every guarded file that changed since the last one. */
export function sealGuard(rc) {
  const current = guardFileMap(rc.runDir);
  const expected = expectedGuardMap(readChained(rc.paths.ledger)) || {};
  const changed = guardDiff(expected, current);
  if (Object.keys(changed).length) log(rc, 'guard', { changed, sha256: hashJson(current) });
}

setLockHooks({
  acquired(dir) {
    openedInLock.delete(lockKey(dir));
  },
  release(dir) {
    const rc = openedInLock.get(lockKey(dir));
    openedInLock.delete(lockKey(dir));
    if (rc) sealGuard(rc);
    return true;
  },
});

/** Append a run-ledger event (and its anchor). */
export function log(rc, type, data = {}, round = null) {
  return recordEvent(rc.runDir, type, data, round, { dataPaths: rc.dataPaths, runId: rc.runId });
}

/**
 * commitState(rc, patch, type, data, round) — merge patch into the state, log the event with
 * `stateAfter`, write state.json, and add a runs-index line when the state name changed.
 */
export function commitState(rc, patch, type, data = {}, round = null) {
  const prev = rc.state.state;
  const next = { ...rc.state, ...patch, schemaVersion: 1 };
  if (!STATES.includes(next.state)) throw new StateError(`unknown state: ${next.state}`);
  const line = log(rc, type, { ...data, stateAfter: next }, round);
  writeState(rc.runDir, next);
  rc.state = next;
  if (next.state !== prev) indexRun(rc, next.state);
  return line;
}

/** Move along a named transition and commit. */
export function move(rc, event, patch, type, data = {}, round = null) {
  const to = transition(rc.state.state, event);
  return commitState(rc, { ...patch, state: to }, type, data, round);
}

export function rootsKey(run) {
  return (run.material?.roots || [])
    .map((r) => normalizeInput(r.path))
    .map((p) => (process.platform === 'win32' ? p.toLowerCase() : p))
    .sort()
    .join('|');
}

export function indexRun(rc, status) {
  appendChained(rc.dataPaths.runsIndex, {
    runId: rc.runId,
    project: rc.run.project,
    rootsKey: rootsKey(rc.run),
    status,
    runDir: rc.runDir,
  });
}

/**
 * What a run leaves behind that a new run must not silently drop (r2-f4): its state, last decision
 * and the serious problems the gate still counts as open (open, unverified or contested,
 * blocker/major, not waived: the gate's own isOpenCluster, r3-f8).
 * Reads the run folder directly; a missing or unreadable folder gives { readable: false }.
 */
export function runLeftovers(runDir) {
  try {
    const p = runPaths(runDir);
    const st = exists(p.state) ? readJson(p.state) : null;
    const clusters = exists(p.clusters) ? readJson(p.clusters).clusters || [] : [];
    const open = clusters
      .filter((c) => isOpenCluster(c))
      .map((c) => ({ id: c.id, severity: c.severity, status: c.status, file: c.file ?? null, problem: String(c.problem ?? '').slice(0, 300) }));
    return { readable: true, state: st?.state ?? null, lastDecision: st?.lastDecision ?? null, openSerious: open };
  } catch {
    return { readable: false, state: null, lastDecision: null, openSerious: [] };
  }
}

/**
 * True when ending or replacing the run would drop something only the owner may drop: a hard stop, a
 * serious problem the gate counts as open, or a round in progress (its answers may already be on disk:
 * aborting then would be a free re-roll of the round, r3-f8).
 */
export function needsOwnerToEnd(left) {
  const stoppedHard = left.state === 'STOPPED' && /^STOP_(?:PLATEAU|LIMIT|INCONCLUSIVE)$/.test(String(left.lastDecision || ''));
  return stoppedHard || left.openSerious.length > 0 || ROUND_STATES.includes(left.state);
}

/**
 * Random generator for one purpose. In seeded test mode (GAUNTLET_TEST=1 + GAUNTLET_SEED) the
 * seed is derived from the env seed, the run, the ledger length and the purpose, so separate
 * processes and repeated steps never repeat ids.
 */
export function rngFor(rc, purpose) {
  if (seededFromEnv(process.env)) {
    let seq = 0;
    try {
      seq = readChained(rc.paths.ledger).length;
    } catch {
      seq = 0;
    }
    const base = sha256Hex(`gauntlet-test\0${process.env.GAUNTLET_SEED}`);
    return makeRng({ seedHex: deriveSeed(base, `${rc.runId}|${seq}|${purpose}|${rngCounter++}`) });
  }
  return makeRng();
}
let rngCounter = 0;

export function isSeeded() {
  return seededFromEnv(process.env);
}

export function readJsonIf(p, dflt = null) {
  try {
    return exists(p) ? readJson(p) : dflt;
  } catch {
    return dflt;
  }
}

export function writeJson(p, v) {
  writeJsonAtomic(p, v);
}

/** Every round number that has a folder, ascending. */
export function roundNumbers(rc) {
  const dir = rc.paths.roundsDir;
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d{2,}$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
}

export function roundInfo(rc, n) {
  const rp = rc.paths.roundDir(n);
  return { rp, round: readJsonIf(rp.roundJson, null), gate: readJsonIf(rp.gate, null) };
}

export function relToRun(rc, p) {
  return path.relative(rc.runDir, p).replace(/\\/g, '/');
}

export function ledgerLines(rc) {
  return readChained(rc.paths.ledger);
}

// ---------------------------------------------------------------- CLI argument parsing

/**
 * parseArgv(argv, { flags: [names], options: [names], multi: [names] }) -> { positional, opts }
 * Accepts `--name value` and `--name=value`. Unknown options are a usage error (exit 4).
 * opts keys are camelCased (`--same-material` -> sameMaterial).
 */
export function parseArgv(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const options = new Set([...(spec.options || []), ...(spec.multi || [])]);
  const multi = new Set(spec.multi || []);
  const positional = [];
  const opts = {};
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (const m of multi) opts[camel(m)] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    let name = a.slice(2);
    let value = null;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (flags.has(name)) {
      if (value !== null) throw new UsageError(`--${name} takes no value`);
      opts[camel(name)] = true;
      continue;
    }
    if (!options.has(name)) throw new UsageError(`unknown option --${name}`);
    if (value === null) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[++i];
    }
    if (multi.has(name)) opts[camel(name)].push(value);
    else opts[camel(name)] = value;
  }
  return { positional, opts };
}
