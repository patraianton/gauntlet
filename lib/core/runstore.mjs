// Run folder access: paths (SPEC 8), the hash-chained run ledger with data-home
// anchors (SPEC 9.15), state cache (9.7) and the run lock (SPEC 11).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { appendChained, readChained, verifyChained } from './chain.mjs';
import { dataPaths as defaultDataPaths } from './datahome.mjs';
import { readJson, writeJsonAtomic, exists } from './fsx.mjs';
import { IntegrityError, UsageError } from './errors.mjs';

export const EVENT_TYPES = Object.freeze([
  'init', 'task-set', 'sources-check', 'sources-baseline', 'lens-writer-issued', 'lenses-ingested', 'freeze', 'amend', 'round-open',
  'precheck', 'snapshot', 'copy', 'trace-scan', 'slots', 'planter-ingested', 'validator-ingested', 'canary-commit',
  'job-issued', 'answer-ingested', 'job-given-up', 'canary-reveal', 'match', 'lens-validity', 'source-unavailable', 'rerun', 'cluster',
  'verify-issued', 'verify-ingested', 'dispute-add', 'dispute-ingested', 'waive', 'owner-decision', 'usage', 'gate',
  'best', 'round-close', 'done', 'report', 'audit', 'abort', 'cleanup', 'supersede', 'setup-reset', 'guard', 'copy-tampered',
  'decoys-ingested', 'decoy-confirmed', 'decoy-reveal', 'controls-sealed', 'control-dismissed',
]);

export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function roundName(n) {
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`bad round number: ${n}`);
  return String(n).padStart(2, '0');
}

export function runPaths(runDir) {
  const d = path.resolve(runDir);
  const j = (...p) => path.join(d, ...p);
  return {
    dir: d,
    runJson: j('run.json'),
    ownerTask: j('OWNER-TASK.md'),
    task: j('TASK.md'),
    lenses: j('lenses.json'),
    sources: j('sources.json'),
    strip: j('strip.json'),
    mechanical: j('mechanical.json'),
    frozen: j('FROZEN.json'),
    setupSummary: j('SETUP-SUMMARY.ru.md'),
    state: j('state.json'),
    ledger: j('ledger.jsonl'),
    clusters: j('clusters.json'),
    disputes: j('disputes.json'),
    ownerDecisions: j('owner-decisions.json'),
    usage: j('usage.jsonl'),
    best: j('best.json'),
    done: j('DONE.json'),
    report: j('REPORT.ru.md'),
    audit: j('AUDIT.json'),
    templatesDir: j('templates'),
    setupDir: j('setup'),
    stripPreview: j('setup', 'strip-preview.json'),
    roundsDir: j('rounds'),
    lock: j('.lock'),
    guardOpen: j('.guard-open'),
    roundDir(n) {
      const r = j('rounds', roundName(n));
      const rj = (...p) => path.join(r, ...p);
      return {
        dir: r,
        roundJson: rj('round.json'),
        precheck: rj('precheck.json'),
        sourcesCheck: rj('sources-check.json'),
        snapshot: rj('snapshot'),
        manifest: rj('manifest.json'),
        copy: rj('copy.json'),
        copyTamper: rj('copy-tamper.json'),
        slots: rj('slots.json'),
        canaries: rj('canaries.json'),
        jobs: rj('jobs.json'),
        prompts: rj('prompts'),
        answers: rj('answers'),
        ingest: rj('ingest'),
        detections: rj('detections.json'),
        verifyItems: rj('verify-items.json'),
        gate: rj('gate.json'),
        todo: rj('todo.md'),
      };
    },
  };
}

/** runId from run.json, else the folder name. */
export function runIdOf(runDir) {
  const p = runPaths(runDir);
  try {
    const run = readJson(p.runJson);
    if (run && typeof run.runId === 'string' && run.runId) return run.runId;
  } catch {
    /* fall through */
  }
  return path.basename(p.dir);
}

/**
 * Append an event to <run>/ledger.jsonl and its head to the data-home anchors.jsonl.
 * opts.dataPaths overrides the data home (tests). Returns the ledger line.
 */
export function recordEvent(runDir, type, data, round = null, opts = {}) {
  if (!EVENT_TYPES.includes(type)) throw new UsageError(`unknown ledger event type: ${type}`);
  if (round !== null && !(Number.isInteger(round) && round >= 0)) throw new UsageError(`bad round for event ${type}: ${round}`);
  const dp = opts.dataPaths ?? defaultDataPaths();
  const p = runPaths(runDir);
  const runId = opts.runId ?? runIdOf(runDir);
  const line = appendChained(p.ledger, { type, runId, round, data: data ?? {} });
  // The anchors file is itself chained, so its own 'seq' belongs to the anchors chain;
  // the run ledger's seq is stored as 'runSeq' (SPEC 7 writes it as {runId, seq, head}).
  appendChained(dp.anchors, { runId, runSeq: line.seq, head: line.hash });
  return line;
}

/** Last anchor line for runId, or null. */
export function lastAnchor(runId, opts = {}) {
  const dp = opts.dataPaths ?? defaultDataPaths();
  let last = null;
  for (const a of readChained(dp.anchors)) if (a.runId === runId) last = a;
  return last;
}

/**
 * Ledger chain intact and its head equal to the last anchor of this run.
 * Throws IntegrityError('TAMPER') otherwise.
 */
export function verifyRunIntegrity(runDir, opts = {}) {
  const dp = opts.dataPaths ?? defaultDataPaths();
  const p = runPaths(runDir);
  const runId = opts.runId ?? runIdOf(runDir);
  const v = verifyChained(p.ledger);
  if (!v.ok) {
    throw new IntegrityError('TAMPER', `run ledger chain broken at line ${v.firstBrokenSeq}`, { file: p.ledger, firstBrokenSeq: v.firstBrokenSeq });
  }
  const av = verifyChained(dp.anchors);
  if (!av.ok) {
    throw new IntegrityError('TAMPER', `data-home anchors chain broken at line ${av.firstBrokenSeq}`, { file: dp.anchors, firstBrokenSeq: av.firstBrokenSeq });
  }
  const anchor = lastAnchor(runId, { dataPaths: dp });
  if (v.count === 0 && !anchor) return { ok: true, count: 0, head: null };
  if (!anchor) throw new IntegrityError('TAMPER', `no anchor recorded for run ${runId}`, { runId });
  if (v.count === 0) throw new IntegrityError('TAMPER', `run ledger of ${runId} is empty but anchors exist`, { runId });
  if (anchor.runSeq !== v.count - 1 || anchor.head !== v.head) {
    throw new IntegrityError('TAMPER', `run ledger head does not match the last anchor (ledger seq ${v.count - 1}, anchor seq ${anchor.runSeq})`, {
      runId,
      ledgerSeq: v.count - 1,
      ledgerHead: v.head,
      anchorSeq: anchor.runSeq,
      anchorHead: anchor.head,
    });
  }
  return { ok: true, count: v.count, head: v.head };
}

export function readState(runDir) {
  const p = runPaths(runDir);
  if (!exists(p.state)) return null;
  return readJson(p.state);
}

export function writeState(runDir, state) {
  const p = runPaths(runDir);
  const { schemaVersion: _s, ...rest } = state ?? {};
  writeJsonAtomic(p.state, { schemaVersion: 1, ...rest });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const held = new Map(); // lock path -> { token, depth }

/**
 * Run fn while holding <run>/.lock. A lock held by a live PID that is less than two
 * hours old is refused (UsageError, exit 4). A stale lock (dead PID, or older than two
 * hours) is taken over; fn receives { takenOver: null | { pid, at, host } } so the
 * caller can log it. Nested calls from the same process share the lock.
 */
export async function withLock(runDir, fn, opts = {}) {
  const p = runPaths(runDir);
  const lockPath = p.lock;
  const nowMs = opts.nowMs ?? Date.now;
  const mine = held.get(lockPath);
  if (mine) {
    mine.depth++;
    try {
      return await fn({ takenOver: null, nested: true });
    } finally {
      mine.depth--;
    }
  }
  let takenOver = null;
  const token = randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, at: nowMs(), host: os.hostname(), token });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(p.dir, { recursive: true });
      fs.writeFileSync(lockPath, body, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt >= 2) {
        if (e.code === 'EEXIST') throw new UsageError(`run is locked: ${lockPath}`);
        throw e;
      }
      let info = null;
      try {
        info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        info = null;
      }
      const age = info && Number.isFinite(Number(info.at)) ? nowMs() - Number(info.at) : Infinity;
      const sameHost = !info || !info.host || info.host === os.hostname();
      const live = info && sameHost && pidAlive(info.pid) && info.pid !== process.pid;
      if (live && age < LOCK_MAX_AGE_MS) {
        throw new UsageError(`run is locked by process ${info.pid} since ${new Date(Number(info.at)).toISOString()}; another step is running`, {
          lock: lockPath,
          pid: info.pid,
        });
      }
      if (!sameHost && age < LOCK_MAX_AGE_MS) {
        throw new UsageError(`run is locked by host ${info.host}; another step is running`, { lock: lockPath });
      }
      takenOver = info ? { pid: info.pid ?? null, at: info.at ?? null, host: info.host ?? null } : { pid: null, at: null, host: null };
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced */
      }
    }
  }
  // A marker left by a command that died (its lock was stale or gone) is inherited: this command's
  // first openRun records what the dead command wrote instead of calling it tampering.
  let inherited = false;
  try {
    const old = JSON.parse(fs.readFileSync(p.guardOpen, 'utf8'));
    inherited = !!old && old.token !== token;
  } catch {
    inherited = false;
  }
  held.set(lockPath, { token, depth: 1, inherited, recovered: false });
  // Guard marker: present while a command holds the lock. If the command dies, the marker stays and
  // the next command knows the guarded files may have been half-written by it (see checkGuard).
  try {
    fs.writeFileSync(p.guardOpen, JSON.stringify({ token, pid: process.pid, at: nowMs() }));
  } catch {
    /* the run folder may not exist yet (tests of the lock itself) */
  }
  if (lockHooks.acquired) lockHooks.acquired(p.dir, token);
  try {
    return await fn({ takenOver, nested: false });
  } finally {
    let sealed = true;
    if (lockHooks.release) {
      try {
        sealed = lockHooks.release(p.dir, token) !== false;
      } catch {
        sealed = false;
      }
    }
    if (sealed) {
      try {
        const m = JSON.parse(fs.readFileSync(p.guardOpen, 'utf8'));
        if (m.token === token) fs.unlinkSync(p.guardOpen);
      } catch {
        /* gone */
      }
    }
    held.delete(lockPath);
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (cur.token === token) fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

let lockHooks = { acquired: null, release: null };

/** Hooks called by withLock on the outermost acquire and release (state.mjs seals the guard on release). */
export function setLockHooks(h) {
  lockHooks = { ...lockHooks, ...h };
}

/** Mark the inherited guard marker of the held lock as recovered (state.mjs logged what changed). */
export function markGuardRecovered(runDir) {
  const h = held.get(runPaths(runDir).lock);
  if (h) h.recovered = true;
}

/** The token of the lock this process holds on runDir, or null. */
export function heldToken(runDir) {
  const h = held.get(runPaths(runDir).lock);
  return h ? h.token : null;
}

// ---------------------------------------------------------------- guard (failure points 6, 7)
//
// Engine-written decision files (clusters, disputes, owner decisions, best version, the strip
// preview, every round file and ingest record) are hashed when a command releases the run lock and
// the changes are logged as a `guard` event. Every later command compares the files with the
// ledger: a file edited between commands (e.g. a cluster set to "closed" by hand) is TAMPER, so the
// executor cannot close a finding by editing clusters.json. Answers and prompts are covered
// separately (write-once hashes in their own events).

/** Guarded files of a run folder -> { relPosix: sha256 }. */
export function guardFileMap(runDir) {
  const p = runPaths(runDir);
  const out = {};
  const add = (abs, rel) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch {
      /* absent */
    }
  };
  for (const name of ['clusters.json', 'disputes.json', 'owner-decisions.json', 'best.json', 'DONE.json']) add(path.join(p.dir, name), name);
  add(p.stripPreview, 'setup/strip-preview.json');
  let rounds = [];
  try {
    rounds = fs.readdirSync(p.roundsDir).filter((n) => /^\d{2,}$/.test(n));
  } catch {
    rounds = [];
  }
  for (const r of rounds.sort()) {
    const rd = path.join(p.roundsDir, r);
    for (const name of safeList(rd)) if (name.endsWith('.json')) add(path.join(rd, name), `rounds/${r}/${name}`);
    for (const name of safeList(path.join(rd, 'ingest'))) if (name.endsWith('.json')) add(path.join(rd, 'ingest', name), `rounds/${r}/ingest/${name}`);
  }
  return out;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The guarded map the ledger expects (folding every `guard` event's changes), or null when none was sealed. */
export function expectedGuardMap(ledgerLines) {
  let map = null;
  for (const l of ledgerLines) {
    if (l.type !== 'guard' || !l.data || typeof l.data.changed !== 'object') continue;
    map = map || {};
    for (const [rel, sha] of Object.entries(l.data.changed)) {
      if (sha === null) delete map[rel];
      else map[rel] = sha;
    }
  }
  return map;
}

/** { rel: sha|null } of files that differ between two maps. */
export function guardDiff(expected, current) {
  const changed = {};
  for (const k of new Set([...Object.keys(expected || {}), ...Object.keys(current || {})])) {
    const a = expected?.[k] ?? null;
    const b = current?.[k] ?? null;
    if (a !== b) changed[k] = b;
  }
  return changed;
}

/**
 * State of the guard for runDir:
 *   { status: 'ok' | 'tamper' | 'busy' | 'interrupted', changed: { rel: sha|null } }
 * 'busy': another live process holds the lock (files may be mid-write; nothing is checked);
 * 'interrupted': a guard marker was left by a command that did not finish.
 */
export function checkGuard(runDir, ledgerLines) {
  const p = runPaths(runDir);
  const expected = expectedGuardMap(ledgerLines);
  const current = guardFileMap(runDir);
  const changed = guardDiff(expected || {}, current);
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(p.guardOpen, 'utf8'));
  } catch {
    marker = null;
  }
  const mine = heldToken(runDir);
  const h = held.get(p.lock);
  if (h && h.inherited && !h.recovered) return { status: 'interrupted', changed, expected, current, marker };
  if (marker && marker.token !== mine) {
    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(p.lock, 'utf8'));
    } catch {
      lock = null;
    }
    const liveOther = lock && lock.token === marker.token && lock.pid !== process.pid && pidAlive(lock.pid);
    return { status: liveOther ? 'busy' : 'interrupted', changed, expected, current, marker };
  }
  if (expected === null) return { status: 'ok', changed, expected, current, first: true };
  return { status: Object.keys(changed).length ? 'tamper' : 'ok', changed, expected, current };
}
