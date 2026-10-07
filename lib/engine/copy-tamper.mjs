// What changed in the review copy while the helpers worked (SPEC 14.13).
//
// The copy is hashed when it is planted and again when the last reviewer answer is in. When the two
// hashes differ the round is void (INVALID_ROUND); this module says exactly WHAT differs so that the
// owner is not left with "someone wrote into the copy" and nothing else (night 06-07.10.2026: six
// reviewers, 40 minutes, 171 MB data, a lost round and no way to tell which file or who).
//
// Pure functions only: the engine (round.mjs) reads the files and the clock, this module turns a
// before/after file list and the job windows into
//   - a record (rounds/NN/copy-tamper.json, the ledger event, the report),
//   - the plain-Russian lines of the report and of the to-do.
// "Who was running" is a guess from times: a file's modification time against the time each job was
// issued and the time its answer file was finished. It is evidence, not proof (a tool can keep or set
// an old time), and the record says so.

import { isScratchPath } from '../material/copy.mjs';
import { sizeRu } from './setup.mjs';

export const MAX_FILES_RECORDED = 500; // in rounds/NN/copy-tamper.json
export const MAX_FILES_LEDGER = 20; // in the ledger event
export const MAX_FILES_TEXT = 10; // in the report and the to-do

const ROLES_ON_THE_COPY = new Set(['reviewer', 'decoy']);

function iso(ms, isoLocal) {
  return typeof ms === 'number' && Number.isFinite(ms) ? isoLocal(new Date(ms)) : null;
}

function parseMs(s) {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * jobWindows(jobs, lensTitle) -> [{ job, role, lens, lensTitle, attempt, issuedAt, answeredAt }]
 * The jobs that work on the planted copy (reviewers and the decoy writer), as the round's jobs.json
 * holds them. answeredAt is null for a job that gave no answer (or one the engine did not time).
 */
export function jobWindows(jobs, lensTitle = () => null) {
  return (jobs || [])
    .filter((j) => ROLES_ON_THE_COPY.has(j.role))
    .map((j) => ({
      job: j.job,
      role: j.role,
      lens: j.lens ?? null,
      lensTitle: j.lens ? lensTitle(j.lens) : null,
      attempt: j.attempt ?? 1,
      issuedAt: j.issuedAt ?? null,
      answeredAt: j.answeredAt ?? null,
    }));
}

/** Jobs whose window [issuedAt, answeredAt] holds the time. A job with no answer time is still running. */
export function runningAt(windows, ms) {
  if (typeof ms !== 'number') return null;
  return windows.filter((w) => {
    const a = parseMs(w.issuedAt);
    if (a === null || ms < a) return false;
    const b = parseMs(w.answeredAt);
    return b === null || ms <= b + 1000; // file times are rounded; a second of slack
  });
}

/**
 * buildTamperRecord({ round, diff, expectedTreeHash, foundTreeHash, listingKnown, copyMissing, windows, detectedAt, isoLocal, copyDir })
 * -> the record. `diff` is diffListings(before, after). `windows` is jobWindows(...), or null when the jobs
 * that could have written are not tracked (the stage before planting): then nobody can be named.
 */
export function buildTamperRecord({ round, diff, expectedTreeHash, foundTreeHash, listingKnown, copyMissing, windows, detectedAt, isoLocal, copyDir = null }) {
  const rows = [];
  for (const f of diff.added) rows.push({ rel: f.rel, change: 'added', bytes: f.bytes, mtime: iso(f.mtimeMs, isoLocal), mtimeMs: f.mtimeMs, scratch: isScratchPath(f.rel, copyDir) });
  for (const f of diff.changed) rows.push({ rel: f.rel, change: 'changed', bytes: f.bytes, bytesBefore: f.bytesBefore, mtime: iso(f.mtimeMs, isoLocal), mtimeMs: f.mtimeMs, scratch: false });
  for (const f of diff.removed) rows.push({ rel: f.rel, change: 'removed', bytesBefore: f.bytesBefore, mtime: null, mtimeMs: null, scratch: false });
  const total = rows.length;
  const files = rows.slice(0, MAX_FILES_RECORDED).map((r) => {
    const running = r.change === 'removed' || !windows ? null : runningAt(windows, r.mtimeMs);
    const { mtimeMs, ...rest } = r; // eslint-disable-line no-unused-vars
    return { ...rest, runningJobs: running === null ? null : running.map((w) => ({ job: w.job, role: w.role, lens: w.lens })) };
  });
  return {
    schemaVersion: 1,
    round,
    detectedAt,
    expectedTreeHash,
    foundTreeHash,
    listingKnown: !!listingKnown,
    copyFolderMissing: !!copyMissing,
    counts: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, total },
    filesRecorded: files.length,
    files,
    jobs: windows ?? [],
    note: 'Who was running is read from times only: a file time against the time each job was issued and the time its answer was finished. It is evidence, not proof.',
  };
}

/** The ledger event data: the record without the long lists. */
export function ledgerData(record, { stage = 'while reviewers worked', action = 'the round is void and repeats' } = {}) {
  return {
    stage,
    action,
    expectedTreeHash: record.expectedTreeHash,
    foundTreeHash: record.foundTreeHash,
    listingKnown: record.listingKnown,
    copyFolderMissing: record.copyFolderMissing,
    counts: record.counts,
    files: record.files.slice(0, MAX_FILES_LEDGER).map((f) => ({ rel: f.rel, change: f.change, bytes: f.bytes ?? null, mtime: f.mtime, scratch: f.scratch, runningJobs: f.runningJobs === null ? null : f.runningJobs.map((j) => j.job) })),
    jobs: record.jobs.map((w) => ({ job: w.job, role: w.role, lens: w.lens, issuedAt: w.issuedAt, answeredAt: w.answeredAt })),
  };
}

// ---------------------------------------------------------------- plain Russian

/** "22 байта", "3071 байт", "171,0 МБ": exact bytes up to 1 MiB so that a small change to a file shows. */
function sizeText(n) {
  if (typeof n !== 'number') return '?';
  if (n >= 1048576) return sizeRu(n);
  const a = n % 100;
  const b = n % 10;
  const word = a > 10 && a < 20 ? 'байт' : b === 1 ? 'байт' : b >= 2 && b <= 4 ? 'байта' : 'байт';
  return `${n} ${word}`;
}

function timeText(mtime) {
  return mtime ? String(mtime).replace('T', ' ').slice(0, 19) : null;
}

function who(w, T, fill) {
  if (w.role === 'decoy') return fill(T.whoDecoy, { JOB: w.job });
  return fill(T.whoReviewer, { TITLE: w.lensTitle || w.lens || '?', JOB: w.job });
}

function fileLine(f, windows, T, fill) {
  const byId = new Map(windows.map((w) => [w.job, w]));
  const parts = [`${T.change[f.change]}: \`${String(f.rel).replace(/`/g, "'")}\``];
  const size = f.change === 'removed' ? fill(T.sizeWas, { SIZE: sizeText(f.bytesBefore) }) : f.change === 'changed' ? fill(T.sizeChanged, { OLD: sizeText(f.bytesBefore), NEW: sizeText(f.bytes) }) : fill(T.sizeNow, { SIZE: sizeText(f.bytes) });
  parts.push(size);
  const t = timeText(f.mtime);
  if (t) parts.push(fill(T.time, { TIME: t }));
  if (f.runningJobs === null) parts.push(T.whoUnknown);
  else if (f.runningJobs.length === 0) parts.push(T.whoNobody);
  else parts.push(fill(T.whoRunning, { LIST: f.runningJobs.map((j) => who(byId.get(j.job) || { job: j.job, role: j.role, lens: j.lens }, T, fill)).join('; ') }));
  if (f.scratch) parts.push(T.scratchNote);
  return parts.join('; ');
}

/**
 * tamperLinesRu(record, phrases, fill, { filesPath? }) -> [string] plain-Russian lines (no list marks):
 * what happened, how many files, one line for each of the first MAX_FILES_TEXT files, what to do.
 */
export function tamperLinesRu(record, phrases, fill, { filesPath = null } = {}) {
  const T = phrases.tamper;
  const out = [T.lead];
  if (record.copyFolderMissing) out.push(T.folderGone);
  if (!record.listingKnown) out.push(T.noListing);
  const c = record.counts;
  if (c.total > 0) out.push(fill(T.counts, { A: c.added, C: c.changed, R: c.removed }));
  for (const f of record.files.slice(0, MAX_FILES_TEXT)) out.push(fileLine(f, record.jobs, T, fill));
  if (c.total > MAX_FILES_TEXT) out.push(fill(filesPath ? T.moreWithPath : T.more, { N: c.total - MAX_FILES_TEXT, PATH: filesPath ?? '' }));
  if (record.listingKnown && c.total > 0) out.push(T.timesNote);
  return out;
}

/** The sentence about tolerated scratch files that the engine removed (the round was still counted). */
export function scratchLineRu(n, phrases, fill) {
  return fill(phrases.tamper.scratchRemoved, { N: n });
}
