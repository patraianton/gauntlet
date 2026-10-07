// Hash-chained JSON-lines files (SPEC 9.15).
//
// Line: { seq, prev, hash, ts, ...payload }
//   prev = hash of the previous line, or 64 zeros for seq 0
//   hash = sha256(prev + canonical(line without the "hash" key))
//
// Appends take a short exclusive lock file (<file>.lock) because some chains (the
// data-home anchors and measurement files) are shared by several runs.

import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './hash.mjs';
import { canonical } from './canon.mjs';
import { now } from './clock.mjs';
import { appendLine, ensureDir, sleepMs } from './fsx.mjs';
import { IntegrityError, UsageError } from './errors.mjs';

export const ZERO_HASH = '0'.repeat(64);
const RESERVED = ['seq', 'prev', 'hash', 'ts'];
const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 60000;

/** hash of a line object (its own "hash" key is ignored). */
export function lineHash(line) {
  const { hash: _ignored, ...rest } = line;
  return sha256Hex(String(line.prev) + canonical(rest));
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

/** Run fn while holding <lockPath> (created with 'wx'). Waits up to 15 s; takes over stale locks. */
export function withFileLock(lockPath, fn) {
  ensureDir(path.dirname(lockPath));
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        stale = !pidAlive(info.pid) || Date.now() - Number(info.at) > LOCK_STALE_MS;
      } catch {
        // half-written or unreadable lock: stale if it is old
        try {
          stale = Date.now() - fs.statSync(lockPath).mtimeMs > 2000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* someone else took it */
        }
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new UsageError(`lock busy: ${lockPath}`);
      sleepMs(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function splitLines(text) {
  // Returns { lines: [string], partial: bool } ; partial = last line has no newline.
  if (text === '') return { lines: [], partial: false };
  const partial = !text.endsWith('\n');
  const parts = text.split('\n');
  if (!partial) parts.pop();
  return { lines: parts, partial };
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function parseLine(raw, idx, file) {
  try {
    const v = JSON.parse(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw new IntegrityError('TAMPER', `${file}: line ${idx} is not valid JSON (${e.message})`, { file, seq: idx });
  }
}

function assertJsonSafe(v, at) {
  if (v === null || v === undefined) return;
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new UsageError(`appendChained: non-finite number at ${at || '/'}`);
    return;
  }
  if (t === 'string' || t === 'boolean') return;
  if (t === 'function' || t === 'symbol' || t === 'bigint') throw new UsageError(`appendChained: ${t} is not JSON at ${at || '/'}`);
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertJsonSafe(x, `${at}/${i}`));
    return;
  }
  for (const [k, x] of Object.entries(v)) assertJsonSafe(x, `${at}/${k}`);
}

/** Every line, parsed. A missing file is an empty chain. Unparsable lines throw TAMPER. */
export function readChained(file) {
  const { lines } = splitLines(readFileOrEmpty(file));
  return lines.map((raw, i) => parseLine(raw, i, file));
}

/**
 * Append payload as the next chained line. Payload keys seq/prev/hash/ts are refused.
 * The current last line is checked (parse + own hash) before appending; a broken
 * tail throws TAMPER instead of extending a broken chain.
 */
export function appendChained(file, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsageError('appendChained: payload must be an object');
  }
  for (const k of RESERVED) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) throw new UsageError(`appendChained: payload may not contain "${k}"`);
  }
  assertJsonSafe(payload, '');
  return withFileLock(`${file}.lock`, () => {
    const text = readFileOrEmpty(file);
    const { lines, partial } = splitLines(text);
    if (partial) throw new IntegrityError('TAMPER', `${file}: last line is incomplete`, { file, seq: lines.length - 1 });
    let seq = 0;
    let prev = ZERO_HASH;
    if (lines.length) {
      const last = parseLine(lines[lines.length - 1], lines.length - 1, file);
      if (last.seq !== lines.length - 1 || lineHash(last) !== last.hash) {
        throw new IntegrityError('TAMPER', `${file}: chain tail does not verify`, { file, seq: lines.length - 1 });
      }
      seq = last.seq + 1;
      prev = last.hash;
    }
    const body = { seq, prev, ts: now(), ...payload };
    const hash = lineHash(body);
    const line = { seq, prev, hash, ts: body.ts, ...payload };
    const json = JSON.stringify(line);
    // Re-parse to be sure the stored form hashes the same (e.g. no undefined/NaN surprises).
    if (lineHash(JSON.parse(json)) !== hash) {
      throw new UsageError('appendChained: payload is not stable through JSON (undefined, NaN, functions?)');
    }
    appendLine(file, json);
    return line;
  });
}

/** -> { ok, count, head, firstBrokenSeq|null }. head = hash of the last verified line (null if none). */
export function verifyChained(file) {
  const { lines, partial } = splitLines(readFileOrEmpty(file));
  let prev = ZERO_HASH;
  let head = null;
  for (let i = 0; i < lines.length; i++) {
    let line;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      return { ok: false, count: lines.length, head, firstBrokenSeq: i };
    }
    if (
      !line ||
      typeof line !== 'object' ||
      line.seq !== i ||
      line.prev !== prev ||
      typeof line.hash !== 'string' ||
      lineHash(line) !== line.hash
    ) {
      return { ok: false, count: lines.length, head, firstBrokenSeq: i };
    }
    prev = line.hash;
    head = line.hash;
  }
  if (partial) return { ok: false, count: lines.length, head, firstBrokenSeq: lines.length - 1 };
  return { ok: true, count: lines.length, head, firstBrokenSeq: null };
}
